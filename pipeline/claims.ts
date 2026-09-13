import { ethers } from 'ethers';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';

/**
 * Claim commitments.
 *
 * No cleartext PII goes on chain. The wallet-linked commitment can still be personal data under
 * privacy law, so this is pseudonymisation rather than anonymisation.
 * Each claim is salted and hashed, and only the root travels with the mark.
 * Openings are returned to the browser and retained by the encrypted recovery journal/vault.
 * Random salts resist guessing; retained openings and wallet linkage remain privacy inputs.
 *
 *   leaf_i     = keccak256(abi.encode(key, value, salt_i))
 *   claimsRoot = MerkleRoot(sorted(leaf_1..leaf_n))
 */
export interface Claim {
  key: string;      // 'fullName' | 'dob' | 'idDocHash' | 'accountHolder' | …
  value: string;
  salt: string;     // 0x + 64 hex
}

export function newSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

export function claimLeaf(c: Claim): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['string', 'string', 'bytes32'], [c.key, c.value, c.salt]),
  );
}

export function claimsRoot(claims: readonly Claim[]): string {
  return merkleRoot(claims.map(claimLeaf));
}

/** Selective disclosure: reveal one claim and keep the rest hidden. */
export function discloseClaim(claims: readonly Claim[], key: string): { claim: Claim; proof: string[] } {
  const claim = claims.find((c) => c.key === key);
  if (!claim) throw new Error(`discloseClaim: no claim named '${key}'`);
  return { claim, proof: merkleProof(claims.map(claimLeaf), claimLeaf(claim)) };
}

export function verifyDisclosure(root: string, claim: Claim, proof: readonly string[]): boolean {
  return verifyProof(root, claimLeaf(claim), proof);
}
