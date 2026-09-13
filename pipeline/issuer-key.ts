import { ethers } from 'ethers';

export const ISSUER_KEY_VERSION = 1;
export const ISSUER_KEY_ABI = [
  'function ISSUER_KEY_VERSION() view returns (uint256)',
  'function SOURCE() view returns (address)',
  'function operatingKey() view returns (address)',
  'function pendingKey() view returns (address)',
  'function keyEpoch() view returns (uint64)',
  'function suspended() view returns (bool)',
  'function proposeKey(address next)',
  'function acceptKey(uint64 expectedEpoch)',
  'function suspend(bytes32 reasonHash)',
  'function declareCompromise(bytes32 reasonHash,uint64 lastTrustedBlock)',
  'function issueOnce(uint64 expectedEpoch,bytes32 requestId,address subject,bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash)',
  'function revoke(uint64 expectedEpoch,address subject,uint16 reasonCode,uint32 epoch)',
  'function deny(uint64 expectedEpoch,address subject,uint32 listVersion,uint32 epoch)',
  'function approvalDigest(bytes32 sourceDigest,uint64 epoch) view returns (bytes32)',
  'function isValidSignature(bytes32 sourceDigest,bytes signature) view returns (bytes4)',
] as const;
export const ISSUER_APPROVAL_TYPES = { IssuerApproval: [
  { name: 'sourceDigest', type: 'bytes32' }, { name: 'keyEpoch', type: 'uint64' },
] };

function checkedEpoch(epoch: bigint): void {
  if (typeof epoch !== 'bigint' || epoch <= 0n || epoch > 0xffffffffffffffffn) throw new Error('invalid issuer key epoch');
}

/** Wrap the EXACT source root approval digest; does not assert legal identity or current key status. */
export function issuerApprovalData(chainId: bigint, issuer: string, sourceDigest: string, keyEpoch: bigint) {
  checkedEpoch(keyEpoch);
  if (typeof chainId !== 'bigint' || chainId <= 0n || !ethers.isAddress(issuer) || issuer === ethers.ZeroAddress ||
      !ethers.isHexString(sourceDigest, 32) || sourceDigest === ethers.ZeroHash) throw new Error('invalid issuer approval domain/digest');
  const domain = { name: 'ProofmarkIssuer', version: '1', chainId, verifyingContract: ethers.getAddress(issuer) };
  const value = { sourceDigest, keyEpoch };
  return { domain, types: ISSUER_APPROVAL_TYPES, value, digest: ethers.TypedDataEncoder.hash(domain, ISSUER_APPROVAL_TYPES, value) };
}

/** 8-byte epoch plus canonical ECDSA r,s,v; accepted as the existing root-approval file signature. */
export function encodeIssuerSignature(keyEpoch: bigint, signature: string): string {
  checkedEpoch(keyEpoch);
  if (!ethers.isHexString(signature, 65)) throw new Error('65-byte issuer signature required');
  const canonical = ethers.Signature.from(signature).serialized;
  return ethers.concat([ethers.toBeHex(keyEpoch, 8), canonical]);
}

/** Keep current API EOA transport separate: this only prepares calldata for a dedicated runner.
 * Does not send transactions, choose a nonce, obtain PII or bypass the issuance journal. */
export function encodeIssuerIssue(keyEpoch: bigint, requestId: string, subject: string, attrs: string, claimsRoot: string, evidenceHash: string): string {
  checkedEpoch(keyEpoch);
  if (!ethers.isAddress(subject) || subject === ethers.ZeroAddress ||
      [requestId, attrs, claimsRoot, evidenceHash].some(v => !ethers.isHexString(v, 32))) throw new Error('invalid issuer issuance payload');
  return new ethers.Interface(ISSUER_KEY_ABI).encodeFunctionData('issueOnce', [keyEpoch, requestId, subject, attrs, claimsRoot, evidenceHash]);
}

/** Encode only: the separately authorized recovery owner must approve the incident reference and cutoff. */
export function encodeIssuerCompromise(reasonHash: string, lastTrustedBlock: bigint): string {
  if (!ethers.isHexString(reasonHash, 32) || reasonHash === ethers.ZeroHash || typeof lastTrustedBlock !== 'bigint'
    || lastTrustedBlock < 0n || lastTrustedBlock > 0xffffffffffffffffn) throw new Error('invalid issuer compromise boundary');
  return new ethers.Interface(ISSUER_KEY_ABI).encodeFunctionData('declareCompromise', [reasonHash, lastTrustedBlock]);
}
