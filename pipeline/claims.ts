import { ethers } from 'ethers';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';

/**
 * 클레임 커밋먼트.
 *
 * ★ 개인정보는 온체인에 1바이트도 올리지 않는다 (§15-1).
 *   각 클레임에 salt 를 붙여 해시하고, 그 루트만 마크에 싣는다.
 *   salt 는 이용자 브라우저에만 남으므로 온체인 값에서 원문을 역산할 수 없다.
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

/** 선택공개 — 특정 클레임 하나만 공개하고 나머지는 숨긴다. */
export function discloseClaim(claims: readonly Claim[], key: string): { claim: Claim; proof: string[] } {
  const claim = claims.find((c) => c.key === key);
  if (!claim) throw new Error(`discloseClaim: '${key}' 클레임이 없습니다`);
  return { claim, proof: merkleProof(claims.map(claimLeaf), claimLeaf(claim)) };
}

export function verifyDisclosure(root: string, claim: Claim, proof: readonly string[]): boolean {
  return verifyProof(root, claimLeaf(claim), proof);
}
