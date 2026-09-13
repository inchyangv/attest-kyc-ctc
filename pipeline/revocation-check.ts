import { ethers } from 'ethers';
import type { RevocationJob } from './vault.js';
import { assertRevocationTarget } from './rescreen.js';

export const REVOCATION_ASC_ABI = [
  'function sourceContract() view returns (address)', 'function expectedChainKey() view returns (uint64)',
  'function TRANSACTION_PROCESSING_VERSION() view returns (uint256)',
  'function tombstone(address) view returns (bool)',
  'function lastAppliedHeight(address) view returns (uint64)',
  'function lastAppliedTxIndex(address) view returns (uint64)',
  'function lastAppliedLogIndex(address) view returns (uint256)',
] as const;
export const REVOCATION_REGISTRY_ABI = [
  'function ASC() view returns (address)', 'function POLICY_SCHEMA_VERSION() view returns (uint256)',
  'function policyOwner(uint256) view returns (address)', 'function policyFrozen(uint256) view returns (bool)',
  'function isVerified(address,uint256) view returns (bool)',
] as const;
const events = new ethers.Interface(['event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)']);
export interface RevocationCheckConfig {
  source: string; asc: string; registry: string; expectedRevoker: string;
  sourceCodeHash: string; ascCodeHash: string; registryCodeHash: string;
  policyIds: number[]; confirmations: number;
}
export class RevocationCheckError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RevocationCheckError'; }
}
function requireThat(ok: unknown, code: string): asserts ok { if (!ok) throw new RevocationCheckError(code); }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
function fresh(block: ethers.Block | null, now: number): asserts block is ethers.Block & { hash: string } {
  requireThat(block?.hash && hash(block.hash) && Number.isSafeInteger(block.number) && block.number >= 0
    && Number.isSafeInteger(block.timestamp) && block.timestamp > 0
    && block.timestamp <= now + 30 && now - block.timestamp <= 300, 'STALE_OR_INVALID_HEAD');
}

/** Read-only, exact receipt-coordinate reconciliation. No local state transition, signature or relay.
 * Use cache-disabled providers. Runtime hashes must come from independently approved deployment pins.
 */
export async function checkRevocation(sourceRpc: ethers.Provider, hubRpc: ethers.Provider, job: RevocationJob,
  config: RevocationCheckConfig, now = Math.floor(Date.now() / 1000)) {
  requireThat(Number.isSafeInteger(now) && now > 0 && Number.isSafeInteger(config.confirmations) && config.confirmations > 0,
    'INVALID_CHECK_CONFIG');
  requireThat([config.source, config.asc, config.registry, config.expectedRevoker, job.walletAddress]
    .every(a => ethers.isAddress(a) && !same(a, ethers.ZeroAddress)), 'INVALID_CHECK_ADDRESS');
  requireThat([config.sourceCodeHash, config.ascCodeHash, config.registryCodeHash].every(hash)
    && config.policyIds.length > 0 && config.policyIds.length <= 16
    && config.policyIds.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(config.policyIds).size === config.policyIds.length, 'INVALID_CHECK_CONFIG');
  if (!job.transaction) return { state: 'UNSIGNED' as const, enforced: false };
  const tx = job.transaction;
  requireThat(hash(tx.hash) && tx.chainId === 11155111 && same(tx.source, config.source), 'SOURCE_TARGET_MISMATCH');
  try { assertRevocationTarget(job, { chainId: 11155111, source: config.source }); }
  catch { throw new RevocationCheckError('SOURCE_TARGET_MISMATCH'); }
  requireThat((await sourceRpc.getNetwork()).chainId === 11155111n && (await hubRpc.getNetwork()).chainId === 102031n,
    'WRONG_CHAIN');
  const [sourceHead, hubHead] = await Promise.all([sourceRpc.getBlock('latest'), hubRpc.getBlock('latest')]);
  fresh(sourceHead, now); fresh(hubHead, now);
  const [sourceCode, ascCode, registryCode] = await Promise.all([
    sourceRpc.getCode(config.source, sourceHead.number), hubRpc.getCode(config.asc, hubHead.number), hubRpc.getCode(config.registry, hubHead.number),
  ]);
  requireThat(sourceCode !== '0x' && ascCode !== '0x' && registryCode !== '0x'
    && same(ethers.keccak256(sourceCode), config.sourceCodeHash) && same(ethers.keccak256(ascCode), config.ascCodeHash)
    && same(ethers.keccak256(registryCode), config.registryCodeHash), 'RUNTIME_PIN_MISMATCH');
  const receipt = await sourceRpc.getTransactionReceipt(tx.hash);
  if (!receipt) return { state: 'SOURCE_PENDING' as const, enforced: false, transactionHash: tx.hash };
  requireThat(receipt.hash === tx.hash && receipt.to && same(receipt.to, config.source) && same(receipt.from, config.expectedRevoker)
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0 && receipt.blockNumber <= sourceHead.number
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0 && hash(receipt.blockHash), 'SOURCE_RECEIPT_MISMATCH');
  const sourceBlock = await sourceRpc.getBlock(receipt.blockNumber);
  requireThat(sourceBlock?.number === receipt.blockNumber && sourceBlock.hash === receipt.blockHash, 'SOURCE_REORG');
  const depth = sourceHead.number - receipt.blockNumber + 1;
  if (depth < config.confirmations) return { state: 'SOURCE_UNCONFIRMED' as const, enforced: false, transactionHash: tx.hash, confirmations: depth };
  requireThat(receipt.status === 0 || receipt.status === 1, 'SOURCE_RECEIPT_MISMATCH');
  if (receipt.status === 0) return { state: 'SOURCE_REVERTED' as const, enforced: false, transactionHash: tx.hash };
  requireThat(same(ethers.keccak256(await sourceRpc.getCode(config.source, receipt.blockNumber)), config.sourceCodeHash), 'RUNTIME_PIN_MISMATCH');
  const matches = receipt.logs.flatMap((log, index) => {
    if (!same(log.address, config.source)) return [];
    try {
      const decoded = events.parseLog(log);
      return decoded && same(decoded.args.subject, job.walletAddress) ? [{ index, decoded, log }] : [];
    } catch { return []; }
  });
  requireThat(matches.length === 1 && matches[0].decoded.args.reasonCode === 2n
    && matches[0].log.topics.length === 4 && matches[0].log.data === '0x', 'SOURCE_EVENT_MISMATCH');
  const source = { transactionHash: tx.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    transactionIndex: receipt.index, receiptLogIndex: matches[0].index, confirmations: depth,
    head: { blockNumber: sourceHead.number, blockHash: sourceHead.hash, timestamp: sourceHead.timestamp } };
  const asc = new ethers.Contract(config.asc, REVOCATION_ASC_ABI, hubRpc);
  const registry = new ethers.Contract(config.registry, REVOCATION_REGISTRY_ABI, hubRpc);
  const at = { blockTag: hubHead.number };
  const [boundSource, chainKey, version, boundAsc, policyVersion, tombstone, height, index, logIndex, policies] = await Promise.all([
    asc.sourceContract(at), asc.expectedChainKey(at), asc.TRANSACTION_PROCESSING_VERSION(at),
    registry.ASC(at), registry.POLICY_SCHEMA_VERSION(at), asc.tombstone(job.walletAddress, at),
    asc.lastAppliedHeight(job.walletAddress, at), asc.lastAppliedTxIndex(job.walletAddress, at), asc.lastAppliedLogIndex(job.walletAddress, at),
    Promise.all(config.policyIds.map(async id => {
      const [owner, frozen, verified] = await Promise.all([registry.policyOwner(id, at), registry.policyFrozen(id, at), registry.isVerified(job.walletAddress, id, at)]);
      requireThat(ethers.isAddress(owner) && !same(owner, ethers.ZeroAddress) && frozen === true && typeof verified === 'boolean', 'INVALID_POLICY_OBSERVATION');
      return { id, verified: verified as boolean };
    })),
  ]);
  requireThat(same(boundSource, config.source) && chainKey === 1n && version === 2n
    && same(boundAsc, config.asc) && policyVersion === 2n, 'HUB_BINDING_MISMATCH');
  requireThat(typeof tombstone === 'boolean', 'INVALID_HUB_OBSERVATION');
  const exact = height === BigInt(source.blockNumber) && index === BigInt(source.transactionIndex) && logIndex === BigInt(source.receiptLogIndex);
  const newer = height > BigInt(source.blockNumber) || (height === BigInt(source.blockNumber)
    && (index > BigInt(source.transactionIndex) || (index === BigInt(source.transactionIndex) && logIndex > BigInt(source.receiptLogIndex))));
  const [sourceAgain, headAgain, hubAgain] = await Promise.all([
    sourceRpc.getBlock(source.blockNumber), sourceRpc.getBlock(sourceHead.number), hubRpc.getBlock(hubHead.number),
  ]);
  requireThat(sourceAgain?.hash === source.blockHash && headAgain?.hash === sourceHead.hash && hubAgain?.hash === hubHead.hash, 'OBSERVATION_REORG');
  const enforced = exact && tombstone === true && policies.every(p => p.verified === false);
  return { state: enforced ? 'ENFORCED' as const : newer ? 'SUPERSEDED' as const : exact ? 'INCONSISTENT' as const : 'AWAITING_HUB' as const,
    enforced, source, hub: { blockNumber: hubHead.number, blockHash: hubHead.hash, timestamp: hubHead.timestamp,
      tombstone, cursor: { height: height.toString(), transactionIndex: index.toString(), receiptLogIndex: logIndex.toString() }, policies },
    observedAt: now, guarantee: 'point-in-time RPC observation only; not permanent finality, native proof verification or consumer transfer execution' };
}
