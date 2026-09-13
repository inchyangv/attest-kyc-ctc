import { ethers } from 'ethers';
import { STATUS_ASC_ABI, STATUS_REGISTRY_ABI } from './onchain-state.js';

export interface ConsumerConfig {
  registry: string; asc: string; source: string;
  registryCodeHash: string; ascCodeHash: string;
}
export class ConsumerReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ConsumerReadError'; }
}
const fail = (code: string): never => { throw new ConsumerReadError(code); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A storage-only policy observation, not a preview, witness submission or asset authorization.
 * Addresses, frozen policy ID and code pins must come from independent application review.
 */
export async function readConsumerVerdict(provider: ethers.Provider, config: ConsumerConfig, subject: string, policyId: bigint) {
  if (!config || [config.registry, config.asc, config.source, subject].some(a => !ethers.isAddress(a) || same(a, ethers.ZeroAddress))
    || [config.registryCodeHash, config.ascCodeHash].some(h => !ethers.isHexString(h, 32) || same(h, ethers.ZeroHash))
    || typeof policyId !== 'bigint' || policyId < 1n || policyId > ethers.MaxUint256) return fail('CONSUMER_CONFIG_INVALID');
  const trusted = { ...config }, holder = ethers.getAddress(subject);
  if ((await provider.getNetwork()).chainId !== 102031n) return fail('CONSUMER_CHAIN_MISMATCH');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number) || block.number < 1 || !ethers.isHexString(block.hash, 32)
    || !Number.isSafeInteger(block.timestamp) || block.timestamp < 1) return fail('CONSUMER_OBSERVATION_UNAVAILABLE');
  const at = { blockTag: block.number };
  const registry = new ethers.Contract(trusted.registry, STATUS_REGISTRY_ABI, provider);
  const asc = new ethers.Contract(trusted.asc, STATUS_ASC_ABI, provider);
  const [registryCode, ascCode] = await Promise.all([provider.getCode(trusted.registry, block.number), provider.getCode(trusted.asc, block.number)]);
  for (const [code, pin] of [[registryCode, trusted.registryCodeHash], [ascCode, trusted.ascCodeHash]]) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || !same(ethers.keccak256(code), pin)) return fail('CONSUMER_RUNTIME_MISMATCH');
  }
  const versions: [ethers.Contract, string, bigint][] = [
    [registry, 'ATTRS_SCHEMA_VERSION', 0n], [registry, 'POLICY_SCHEMA_VERSION', 2n], [registry, 'ROSTER_FORMAT_VERSION', 2n],
    [registry, 'EPOCH_SCHEMA_VERSION', 2n], [registry, 'ROSTER_AUTH_VERSION', 1n], [registry, 'ROSTER_WITNESS_VERSION', 1n],
    [registry, 'ISSUER_KEY_PROVENANCE_VERSION', 1n],
    [asc, 'ATTRS_SCHEMA_VERSION', 0n], [asc, 'TRANSACTION_PROCESSING_VERSION', 2n], [asc, 'EPOCH_SCHEMA_VERSION', 2n], [asc, 'ROSTER_AUTH_VERSION', 1n],
    [asc, 'ISSUER_KEY_PROVENANCE_VERSION', 1n],
  ];
  const observed = await Promise.all(versions.map(([contract, name]) => contract[name](at)));
  if (observed.some((value, i) => value !== versions[i][2])) return fail('CONSUMER_SCHEMA_UNSUPPORTED');
  const [boundAsc, source, chainKey, policy, kind, frozen, verified] = await Promise.all([
    registry.ASC(at), asc.sourceContract(at), asc.expectedChainKey(at), registry.policies(policyId, at),
    registry.policyKind(policyId, at), registry.policyFrozen(policyId, at), registry.isVerified(holder, policyId, at),
  ]);
  if (!same(boundAsc, trusted.asc) || !same(source, trusted.source) || chainKey !== 1n) return fail('CONSUMER_BINDING_MISMATCH');
  if (!policy[7] || !frozen || (kind !== 1n && kind !== 2n)) return fail('CONSUMER_POLICY_UNAPPROVED');
  const finalBlock = await provider.getBlock(block.number);
  if ((await provider.getNetwork()).chainId !== 102031n || finalBlock?.number !== block.number
    || finalBlock.hash !== block.hash || finalBlock.timestamp !== block.timestamp) return fail('CONSUMER_OBSERVATION_CHANGED');
  return {
    verdict: verified ? 'accepted' as const : 'rejected' as const, verified: Boolean(verified), subject: holder,
    registry: ethers.getAddress(trusted.registry), asc: ethers.getAddress(trusted.asc), source: ethers.getAddress(trusted.source),
    policy: { id: policyId.toString(), schemaVersion: 2, kind: Number(kind), requireAll: Number(policy[0]), minAssurance: Number(policy[1]),
      maxAge: Number(policy[2]), requiredRegime: Number(policy[3]), requiredJurisdiction: Number(policy[4]), trustedIssuer: String(policy[5]),
      requireRoster: Boolean(policy[6]), exists: true, frozen: true },
    observation: { chainId: 102031, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
      finality: 'latest-observed-not-finalized', registryCodeHash: ethers.keccak256(registryCode), ascCodeHash: ethers.keccak256(ascCode) },
    meaning: 'Registry.isVerified-at-observed-block-not-asset-transaction-authorization',
    warning: policy[6] ? 'Current stored witness still trusts issuer screening and roster completeness.'
      : 'Direct policy does not establish continued revocation freshness.',
  };
}
