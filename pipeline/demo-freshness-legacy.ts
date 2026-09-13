import { ethers } from 'ethers';
import { DEMO_NOTE_ABI, type DemoFreshnessConfig } from './demo-freshness.js';
import { LEGACY_ASC_ABI, LEGACY_REGISTRY_ABI, detectRosterGeneration } from './roster-legacy-v1.js';

/**
 * Read-only freshness gate for the live `v1-live` deployment, whose registry evaluates Direct marks
 * and has no roster-witness path. The v2 gate in `demo-freshness.ts` applies once the v2 contracts
 * are deployed; `detectRosterGeneration` decides which one the CLI runs.
 *
 * The scheduled window is bounded by the earliest of each holder's credential expiry and
 * `issuedAt + pilot maxAge`. It is an observation of one block, not a promise of availability.
 */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireThat(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }

export const PILOT_POLICY_MAX_AGE_SECONDS = 604_800;
export const PRODUCTION_POLICY_MAX_AGE_SECONDS = 2_592_000;
export const REQUIRED_METHODS = 65_572; // ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED

export async function checkLegacyDemoFreshness(provider: ethers.Provider, config: DemoFreshnessConfig, observedAtSeconds = Math.floor(Date.now() / 1000)) {
  requireThat(Number.isSafeInteger(config.minFreshSeconds) && config.minFreshSeconds > 0 && config.minFreshSeconds <= PILOT_POLICY_MAX_AGE_SECONDS,
    'freshness window must be a positive whole number of seconds, at most the pilot policy age');
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
  requireThat(await detectRosterGeneration(provider, config.registry, block.number) === 'v1-live', 'registry is not the v1 build; use the v2 freshness gate');
  const at = { blockTag: block.number };
  const asc = new ethers.Contract(config.asc, LEGACY_ASC_ABI, provider);
  const registry = new ethers.Contract(config.registry, LEGACY_REGISTRY_ABI, provider);
  const note = new ethers.Contract(config.note, DEMO_NOTE_ABI, provider);
  const subjects = [...config.holders, config.control];
  const [chainKey, sourceContract, marks, tombstones, verdicts, policies, frozen, noteRegistry, notePolicy, blocked, allowed, code] = await Promise.all([
    asc.expectedChainKey(at) as Promise<bigint>, asc.sourceContract(at) as Promise<string>,
    Promise.all(subjects.map(s => asc.getMark(s, at) as Promise<ethers.Result>)),
    Promise.all(subjects.map(s => asc.tombstone(s, at) as Promise<boolean>)),
    Promise.all(subjects.map(s => Promise.all([1n, 2n].map(p => registry.isVerified(s, p, at) as Promise<boolean>)))),
    Promise.all([1n, 2n].map(p => registry.policies(p, at) as Promise<ethers.Result>)),
    Promise.all([1n, 2n].map(p => registry.policyFrozen(p, at) as Promise<boolean>)),
    note.REGISTRY(at) as Promise<string>, note.POLICY_ID(at),
    note.canTransfer(config.holders[0], config.control, at) as Promise<boolean>,
    note.canTransfer(config.holders[0], config.holders[1], at) as Promise<boolean>,
    provider.getCode(config.note, block.number),
  ]);
  requireThat(chainKey === 1n, 'unexpected source chain key');
  requireThat(same(sourceContract, config.source), 'unexpected source contract');
  requireThat(code !== '0x' && same(noteRegistry, config.registry) && notePolicy === 2n, 'note binding mismatch');
  requireThat(blocked === false && allowed === true, 'note transfer preflight mismatch');
  const policyView = policies.map((p, i) => ({
    id: i + 1, requireAll: Number(p[0]), minAssurance: Number(p[1]), maxAge: Number(p[2]), requiredRegime: Number(p[3]),
    requiredJurisdiction: Number(p[4]), trustedIssuer: String(p[5]), requireRoster: Boolean(p[6]), exists: Boolean(p[7]), frozen: frozen[i],
  }));
  for (const p of policyView) {
    requireThat(p.exists && p.frozen && p.requireAll === REQUIRED_METHODS && p.minAssurance === 2 && p.requiredRegime === p.id
      && p.requiredJurisdiction === 410 && same(p.trustedIssuer, config.expectedIssuer)
      && p.maxAge === (p.id === 1 ? PRODUCTION_POLICY_MAX_AGE_SECONDS : PILOT_POLICY_MAX_AGE_SECONDS), `unexpected frozen policy ${p.id}`);
  }
  const pilotMaxAge = policyView[1].maxAge;
  const holders = config.holders.map((subject, index) => {
    const m = marks[index];
    const mark = { status: Number(m[0]), origin: Number(m[1]), kind: Number(m[2]), assurance: Number(m[3]), regime: Number(m[4]),
      jurisdiction: Number(m[5]), methods: Number(m[6]), issuedAt: Number(m[7]), expiry: Number(m[8]), issuer: String(m[12]) };
    const [production, pilot] = verdicts[index];
    requireThat(!tombstones[index], `holder ${index + 1} is tombstoned`);
    requireThat(mark.status === 1 && mark.origin === 1 && mark.kind === 1 && mark.regime === 2 && mark.jurisdiction === 410
      && mark.assurance >= 2 && (mark.methods & REQUIRED_METHODS) === REQUIRED_METHODS && same(mark.issuer, config.expectedIssuer)
      && mark.issuedAt > 0 && mark.issuedAt <= block.timestamp && mark.expiry > block.timestamp, `holder ${index + 1} mark is not an active sandbox credential from the expected issuer`);
    requireThat(!production && pilot, `holder ${index + 1} must fail production and pass pilot`);
    // maxAge is inclusive at issuedAt+maxAge; treating that boundary as exclusive is conservative by one second.
    const limits = { credentialExpiry: mark.expiry, policyAgeBoundary: mark.issuedAt + pilotMaxAge };
    const scheduledUntilExclusive = Math.min(...Object.values(limits));
    const remainingSeconds = scheduledUntilExclusive - Math.max(block.timestamp, observedAtSeconds);
    requireThat(remainingSeconds >= config.minFreshSeconds, `holder ${index + 1} scheduled freshness is only ${remainingSeconds}s; required ${config.minFreshSeconds}s`);
    return { subject, issuedAt: mark.issuedAt, limits, scheduledUntilExclusive, remainingSeconds, productionVerified: false, pilotVerified: true };
  });
  requireThat(verdicts[2].every(v => !v), 'control must fail both policies');
  requireThat(Number(marks[2][0]) === 0, 'control must have no mark');
  requireThat((await provider.getBlock(block.number))?.hash === block.hash, 'observation block changed; retry');
  return {
    generation: 'v1-live' as const,
    observation: { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp }, observedAtSeconds,
    policies: policyView, holders, minimumRequestedSeconds: config.minFreshSeconds,
    scheduledUntilExclusive: Math.min(...holders.map(h => h.scheduledUntilExclusive)),
    notePreflight: { controlRejected: true, holdersAccepted: true },
    guarantee: 'none: scheduled bounds assume no earlier revocation, policy/infrastructure change or reorg',
    notVerified: ['roster witnesses (the v1 build has no witness path; epoch verdicts are checked by verify:epoch)',
      'runtime identity pins', 'source transaction/event lineage', 'finality', 'actual transfer or balance changes',
      'continuous renewal or judging-period availability'],
  };
}
