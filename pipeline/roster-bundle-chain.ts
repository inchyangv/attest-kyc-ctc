import { ethers } from 'ethers';
import { ROSTER_REGISTRY_ABI } from './roster-format.js';
import { ROSTER_WITNESS_ABI } from './roster-witness.js';
import type { loadRosterBundle, RosterScope } from './roster-bundle.js';

type BundleProof = ReturnType<ReturnType<typeof loadRosterBundle>['proof']>;
const ASC_ABI = [
  'function ATTRS_SCHEMA_VERSION() view returns (uint256)', 'function TRANSACTION_PROCESSING_VERSION() view returns (uint256)',
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)', 'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
  'function sourceContract() view returns (address)', 'function expectedChainKey() view returns (uint64)',
  'function latestEpoch() view returns (uint32)', 'function epochRoots(uint32) view returns (bytes32)',
  'function epochSourceCutoff() view returns (uint40)', 'function epochPublishedAt() view returns (uint40)',
  'function epochValidUntil() view returns (uint40)', 'function epochSnapshotId() view returns (bytes32)',
  'function epochListVersion() view returns (uint32)', 'function isRosterFresh() view returns (bool)',
  'function epochIssuerApproved(uint32,address) view returns (bool)',
  'function isEpochIssuerUsable(uint32,address) view returns (bool)',
] as const;
const REG_ABI = [...ROSTER_REGISTRY_ABI, ...ROSTER_WITNESS_ABI,
  'function ASC() view returns (address)', 'function ATTRS_SCHEMA_VERSION() view returns (uint256)',
  'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
  'function POLICY_SCHEMA_VERSION() view returns (uint256)', 'function policyFrozen(uint256) view returns (bool)',
] as const;
export const BUNDLE_CHECK_ABIS = { asc: ASC_ABI, registry: REG_ABI };

/** expectedScope is the consumer's independently trusted config, NOT copied from a downloaded file.
 * This does no writes. A latest-block simulation can become stale/reorged before submission. */
export async function checkBundleProof(provider: ethers.Provider, expectedScope: RosterScope, proof: BundleProof, policyId: bigint) {
  if (policyId <= 0n || policyId > ethers.MaxUint256) throw new Error('invalid consumer policy');
  for (const key of Object.keys(expectedScope) as (keyof RosterScope)[]) {
    if (String(expectedScope[key]).toLowerCase() !== String(proof.scope[key]).toLowerCase()) throw new Error('bundle destination differs from trusted consumer scope');
  }
  if ((await provider.getNetwork()).chainId !== BigInt(expectedScope.hubChainId)) throw new Error('wrong hub network');
  const block = await provider.getBlock('latest');
  if (!block?.hash) throw new Error('bundle observation block unavailable');
  const at = { blockTag: block.number };
  const asc = new ethers.Contract(expectedScope.asc, ASC_ABI, provider);
  const registry = new ethers.Contract(expectedScope.registry, REG_ABI, provider);
  const versions: [ethers.Contract, string, bigint][] = [
    [asc, 'ATTRS_SCHEMA_VERSION', 0n], [asc, 'TRANSACTION_PROCESSING_VERSION', 2n], [asc, 'EPOCH_SCHEMA_VERSION', 2n], [asc, 'ROSTER_AUTH_VERSION', 1n],
    [asc, 'ISSUER_KEY_PROVENANCE_VERSION', 1n],
    [registry, 'ROSTER_FORMAT_VERSION', 2n], [registry, 'EPOCH_SCHEMA_VERSION', 2n], [registry, 'ROSTER_AUTH_VERSION', 1n],
    [registry, 'ISSUER_KEY_PROVENANCE_VERSION', 1n],
    [registry, 'ROSTER_WITNESS_VERSION', 1n], [registry, 'ATTRS_SCHEMA_VERSION', 0n], [registry, 'POLICY_SCHEMA_VERSION', 2n],
  ];
  const observed = await Promise.all(versions.map(([contract, name]) => contract[name](at)));
  if (observed.some((value, i) => value !== versions[i][2])) throw new Error('unsupported bundle consumer schema');
  const [boundAsc, source, key, epoch, root, cutoff, published, until, snapshot, version, fresh, frozen, requiresRoster] = await Promise.all([
    registry.ASC(at), asc.sourceContract(at), asc.expectedChainKey(at), asc.latestEpoch(at), asc.epochRoots(proof.epoch, at),
    asc.epochSourceCutoff(at), asc.epochPublishedAt(at), asc.epochValidUntil(at), asc.epochSnapshotId(at), asc.epochListVersion(at),
    asc.isRosterFresh(at), registry.policyFrozen(policyId, at), registry.policyRequiresRoster(policyId, at),
  ]);
  if (boundAsc.toLowerCase() !== expectedScope.asc.toLowerCase() || source.toLowerCase() !== expectedScope.source.toLowerCase() ||
      key !== BigInt(expectedScope.sourceChainKey)) throw new Error('bundle source/ASC binding mismatch');
  if (epoch !== BigInt(proof.epoch) || root.toLowerCase() !== proof.root.toLowerCase() || cutoff !== BigInt(proof.sourceCutoff) ||
      published !== BigInt(proof.publishedAt) || until !== BigInt(proof.validUntil) || snapshot.toLowerCase() !== proof.snapshotId.toLowerCase() ||
      version !== BigInt(proof.listVersion) || !fresh || block.timestamp < proof.publishedAt || block.timestamp >= proof.validUntil) throw new Error('bundle is not the current fresh on-chain epoch');
  if (!frozen || !requiresRoster) throw new Error('consumer policy must be frozen and require roster');
  let result: { kind: BundleProof['kind']; proofAccepted: boolean; eligible: boolean; witnessSimulation: 'succeeded' | 'not-run'; transaction?: { chainId: number; to: string; data: string } };
  if (proof.kind === 'inclusion') {
    if (!(await asc.isEpochIssuerUsable(proof.epoch, proof.mark.issuer, at))) throw new Error('bundle issuer approval is absent or compromised');
    const verified: boolean = await registry.verifyWithRoster(proof.subject, policyId, proof.mark, proof.proof, at);
    if (verified) await registry.cacheRosterWitness.staticCall(proof.subject, proof.mark, proof.proof, at);
    result = { kind: proof.kind, proofAccepted: verified, eligible: verified, witnessSimulation: verified ? 'succeeded' : 'not-run',
      // Re-encode checked fields; never trust caller-supplied transaction.data/to from a proof response.
      ...(verified ? { transaction: { chainId: expectedScope.hubChainId, to: expectedScope.registry,
        data: registry.interface.encodeFunctionData('cacheRosterWitness', [proof.subject, proof.mark, proof.proof]) } } : {}) };
  } else {
    result = { kind: proof.kind, proofAccepted: await registry.proveNotInRoster(proof.subject, proof.proof, at), eligible: false, witnessSimulation: 'not-run' };
  }
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error('bundle observation reorganized; discard verdict');
  return { ...result, observation: { chainId: expectedScope.hubChainId, blockNumber: block.number, blockHash: block.hash,
    timestamp: block.timestamp, finality: 'latest-observed-not-finalized' },
    meaning: proof.kind === 'inclusion' ? 'policy-proof-verdict-not-a-stored-witness-or-submitted-transaction' : 'absence-from-current-root-not-a-sanction-verdict' };
}
