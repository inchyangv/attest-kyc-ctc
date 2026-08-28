import { ethers } from 'ethers';

/**
 * OpenZeppelin `MerkleProof` 호환 머클 트리.
 *
 * 내부 노드 = keccak256(정렬된 두 자식) — 정렬하므로 좌우 구분(위치 비트)이 불필요하고,
 * 나중에 온체인에서 `MerkleProof.verify()` 로 선택공개를 검증할 수 있다.
 */
export function hashPair(a: string, b: string): string {
  return a.toLowerCase() <= b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return ethers.ZeroHash;
  let level = [...leaves].sort();          // 결정적 순서
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** 특정 리프의 증명 경로. 선택공개(§6.1)에 쓴다. */
export function merkleProof(leaves: readonly string[], leaf: string): string[] {
  let level = [...leaves].sort();
  let idx = level.indexOf(leaf);
  if (idx < 0) throw new Error('merkleProof: 리프를 찾을 수 없습니다');

  const proof: string[] = [];
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(root: string, leaf: string, proof: readonly string[]): boolean {
  let acc = leaf;
  for (const p of proof) acc = hashPair(acc, p);
  return acc.toLowerCase() === root.toLowerCase();
}
