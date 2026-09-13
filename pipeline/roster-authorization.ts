import { ethers } from 'ethers';

export const ROSTER_AUTH_VERSION = 1;
export const ROSTER_AUTH_ABI = [
  'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function rosterApprovalDigest(uint32 epoch,bytes32 root,uint32 listVersion,uint40 validUntil,uint40 sourceCutoff,bytes32 snapshotId,address publisher) view returns (bytes32)',
  'function publishEpochForIssuers(uint32 epoch,bytes32 root,uint32 listVersion,uint40 validUntil,uint40 sourceCutoff,bytes32 snapshotId,(address issuer,bytes signature)[] approvals)',
  'event RosterIssuerAuthorized(uint32 indexed epoch,bytes32 indexed root,address indexed issuer)',
] as const;
export const ROSTER_APPROVAL_TYPES = { RosterApproval: [
  { name: 'epoch', type: 'uint32' }, { name: 'root', type: 'bytes32' }, { name: 'listVersion', type: 'uint32' },
  { name: 'validUntil', type: 'uint40' }, { name: 'sourceCutoff', type: 'uint40' }, { name: 'snapshotId', type: 'bytes32' },
  { name: 'publisher', type: 'address' },
] };
export interface RosterApprovalMessage {
  epoch: number; root: string; listVersion: number; validUntil: number; sourceCutoff: number; snapshotId: string; publisher: string;
}
export interface RootApproval { issuer: string; signature: string }
export function rosterApprovalData(chainId: bigint, source: string, message: RosterApprovalMessage) {
  if (chainId <= 0n || !ethers.isAddress(source) || source === ethers.ZeroAddress || !ethers.isAddress(message.publisher) || message.publisher === ethers.ZeroAddress ||
    !ethers.isHexString(message.root, 32) || message.root === ethers.ZeroHash || !ethers.isHexString(message.snapshotId, 32) || message.snapshotId === ethers.ZeroHash ||
    [[message.epoch, 0xffffffff], [message.listVersion, 0xffffffff], [message.validUntil, 0xffffffffff], [message.sourceCutoff, 0xffffffffff]]
      .some(([n, max]) => !Number.isSafeInteger(n) || n < 0 || n > max) || message.epoch === 0) throw new Error('invalid roster approval message');
  const domain = { name: 'ProofmarkRoster', version: '1', chainId, verifyingContract: ethers.getAddress(source) };
  const value = { ...message, publisher: ethers.getAddress(message.publisher) };
  return { domain, types: ROSTER_APPROVAL_TYPES, value, digest: ethers.TypedDataEncoder.hash(domain, ROSTER_APPROVAL_TYPES, value) };
}

/** Envelope binding/shape only. Source staticCall and publication validate current roles and signatures,
 * including ERC-1271. An address in this file is NOT evidence that its signature is valid. */
export function readRootApprovals(value: unknown, digest: string, requiredIssuers: readonly string[]): RootApproval[] {
  if (!value || typeof value !== 'object') throw new Error('invalid approval envelope');
  const v = value as { version?: unknown; digest?: unknown; approvals?: unknown };
  if (v.version !== 1 || typeof v.digest !== 'string' || v.digest.toLowerCase() !== digest.toLowerCase() || !Array.isArray(v.approvals) || !v.approvals.length || v.approvals.length > 16)
    throw new Error('approval envelope does not bind this exact roster/destination or exceeds issuer limit');
  const approvals: RootApproval[] = v.approvals.map(a => {
    if (!a || typeof a !== 'object' || typeof a.issuer !== 'string' || !ethers.isAddress(a.issuer) || a.issuer === ethers.ZeroAddress ||
      typeof a.signature !== 'string' || !ethers.isHexString(a.signature) || ethers.dataLength(a.signature) > 4096) throw new Error('invalid issuer approval');
    return { issuer: ethers.getAddress(a.issuer), signature: a.signature };
  }).sort((a, b) => BigInt(a.issuer) < BigInt(b.issuer) ? -1 : 1);
  const issuers = new Set(approvals.map(a => a.issuer.toLowerCase()));
  if (issuers.size !== approvals.length || requiredIssuers.some(issuer => !issuers.has(issuer.toLowerCase()))) throw new Error('duplicate approval or roster issuer not covered');
  return approvals;
}
export async function requireRosterAuthorization(...readVersions: (() => Promise<unknown>)[]): Promise<void> {
  if (!readVersions.length) throw new Error('roster authorization target required');
  for (const read of readVersions) {
    let version: unknown;
    try { version = await read(); } catch { throw new Error('roster issuer authorization unavailable; migrate all contracts'); }
    if (Number(version) !== ROSTER_AUTH_VERSION) throw new Error('unsupported roster issuer authorization');
  }
}
