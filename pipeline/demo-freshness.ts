import { ethers } from 'ethers';
import { MAX_EPOCH_AGE_SECONDS, MAX_PUBLICATION_LAG_SECONDS } from './epoch.js';
import { readOnchainState } from './onchain-state.js';

export const DEMO_NOTE_ABI = [
  'function REGISTRY() view returns (address)', 'function POLICY_ID() view returns (uint256)',
  'function canTransfer(address,address) view returns (bool)',
] as const;
export interface DemoFreshnessConfig {
  asc: string; registry: string; note: string; source: string; expectedIssuer: string;
  holders: readonly [string, string]; control: string; minFreshSeconds: number;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireThat(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
function threshold(seconds: number) {
  requireThat(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_EPOCH_AGE_SECONDS,
    'freshness window must be a positive whole number of seconds, at most 24 hours');
  return seconds;
}
/** No default: the operator must explicitly choose the approved observation window. */
export function parseMinFreshHours(raw: string | undefined): number {
  requireThat(raw !== undefined && /^\d+(?:\.\d+)?$/.test(raw), 'MIN_FRESH_HOURS must explicitly specify a positive decimal number of hours');
  return threshold(Number(raw) * 3600);
}

/** Read-only scheduled horizon, not continuous availability or source/finality proof.
 * Runtime pins and source-chain issuer-role checks remain the separate scene preflight. */
export async function checkDemoFreshness(provider: ethers.Provider, config: DemoFreshnessConfig, observedAtSeconds = Math.floor(Date.now() / 1000)) {
  threshold(config.minFreshSeconds);
  requireThat(Number.isSafeInteger(observedAtSeconds) && observedAtSeconds > 0, 'invalid observation clock');
  const addresses = [config.asc, config.registry, config.note, config.source, config.expectedIssuer, ...config.holders, config.control];
  requireThat(addresses.every(a => ethers.isAddress(a) && !same(a, ethers.ZeroAddress)), 'invalid demo address');
  requireThat(new Set([...config.holders, config.control].map(a => a.toLowerCase())).size === 3, 'holders and control must be distinct');
  requireThat((await provider.getNetwork()).chainId === 102031n, 'wrong hub chain');
  const block = await provider.getBlock('latest');
  requireThat(block?.hash && Number.isSafeInteger(block.number) && block.number >= 0
    && Number.isSafeInteger(block.timestamp) && block.timestamp > 0, 'observation block unavailable');
  requireThat(block.timestamp <= observedAtSeconds + 30 && observedAtSeconds - block.timestamp <= 300,
    'latest block is stale or ahead of observation clock (maximum lag 300s, lead 30s)');
  const at = { blockTag: block.number };
  const note = new ethers.Contract(config.note, DEMO_NOTE_ABI, provider);
  const [states, noteRegistry, notePolicy, blocked, allowed, code] = await Promise.all([
    Promise.all([...config.holders, config.control].map(subject => readOnchainState(provider,
      { asc: config.asc, registry: config.registry, subject }, block.number))),
    note.REGISTRY(at) as Promise<string>, note.POLICY_ID(at),
    note.canTransfer(config.holders[0], config.control, at) as Promise<boolean>,
    note.canTransfer(config.holders[0], config.holders[1], at) as Promise<boolean>,
    provider.getCode(config.note, block.number),
  ]);
  requireThat(code !== '0x' && same(noteRegistry, config.registry) && notePolicy === 2n, 'note binding mismatch');
  requireThat(blocked === false && allowed === true, 'note transfer preflight mismatch');
  for (const state of states) {
    requireThat(state.blockNumber === block.number && state.observation.blockHash === block.hash
      && state.observation.timestamp === block.timestamp, 'mixed observation blocks');
    requireThat(same(state.asc.sourceContract, config.source), 'unexpected source contract');
    requireThat(state.registry.compatible && state.registry.versions.ROSTER_WITNESS_VERSION === 1, 'current roster schema required');
    for (const p of state.policies) {
      requireThat(p.exists && p.frozen && p.requireRoster && p.kind === 1 && p.requireAll === 65572
        && p.minAssurance === 2 && p.maxAge === (p.id === 1 ? 2592000 : 604800)
        && p.requiredRegime === p.id && p.requiredJurisdiction === 410
        && same(p.trustedIssuer, config.expectedIssuer), `unexpected frozen policy ${p.id}`);
      requireThat(p.diagnosis === 'consistent', `Registry verdict/diagnostic disagreement for ${state.subject} policy ${p.id}`);
    }
  }
  const epoch = states[0].epoch;
  const { sourceCutoff: cutoff, publishedAt: published, validUntil } = epoch;
  requireThat(epoch.latestEpoch > 0 && epoch.root && epoch.root !== ethers.ZeroHash
    && epoch.snapshotId && epoch.snapshotId !== ethers.ZeroHash && epoch.fresh
    && cutoff !== null && published !== null && cutoff > 0 && cutoff <= published && published <= block.timestamp
    && published - cutoff <= MAX_PUBLICATION_LAG_SECONDS && validUntil > published
    && validUntil - cutoff <= MAX_EPOCH_AGE_SECONDS && validUntil > block.timestamp, 'invalid or stale roster epoch');
  requireThat(states.every(s => JSON.stringify(s.epoch) === JSON.stringify(epoch)), 'mixed roster epochs');
  const holders = states.slice(0, 2).map((state, index) => {
    const [production, pilot] = state.policies;
    requireThat(!production.verified && pilot.verified, `holder ${index + 1} must fail production and pass pilot`);
    const w = state.witness;
    requireThat(w && w.epoch === epoch.latestEpoch && w.issuerApproved && pilot.decisionMark
      && same(w.mark.issuer, config.expectedIssuer), `holder ${index + 1} lacks a current approved witness`);
    const mark = pilot.decisionMark;
    // maxAge is inclusive at issuedAt+maxAge; expiry and epoch.validUntil are exclusive.
    // Using maxAge's boundary as exclusive is intentionally conservative by one second.
    const limits = { credentialExpiry: mark.expiry, policyAgeBoundary: mark.issuedAt + pilot.maxAge, epochValidUntil: validUntil };
    const scheduledUntilExclusive = Math.min(...Object.values(limits));
    // A lagging latest block has already spent part of its scheduled wall-clock window.
    const remainingSeconds = scheduledUntilExclusive - Math.max(block.timestamp, observedAtSeconds);
    requireThat(remainingSeconds >= config.minFreshSeconds, `holder ${index + 1} scheduled freshness is only ${remainingSeconds}s; required ${config.minFreshSeconds}s`);
    return { subject: state.subject, witnessEpoch: w.epoch, limits, scheduledUntilExclusive, remainingSeconds,
      productionVerified: false, pilotVerified: true };
  });
  requireThat(states[2].policies.every(p => !p.verified), 'control must fail both policies');
  requireThat((await provider.getBlock(block.number))?.hash === block.hash, 'observation block changed; retry');
  return { observation: states[0].observation, observedAtSeconds, blockNumber: block.number, epoch, holders,
    minimumRequestedSeconds: config.minFreshSeconds, scheduledUntilExclusive: Math.min(...holders.map(h => h.scheduledUntilExclusive)),
    notePreflight: { controlRejected: true, holdersAccepted: true },
    guarantee: 'none: scheduled bounds assume no earlier revocation, epoch replacement, policy/infrastructure change or reorg',
    notVerified: ['runtime identity pins', 'source transaction/event lineage', 'finality', 'actual transfer or balance changes', 'continuous renewal or judging-period availability'] };
}
