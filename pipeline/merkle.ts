import { ethers } from 'ethers';

/**
 * Merkle tree compatible with OpenZeppelin `MerkleProof`.
 *
 * An internal node is keccak256 of the two sorted children. Sorting removes the need for
 * position bits and lets `MerkleProof.verify()` check selective disclosure on chain later.
 */
export function hashPair(a: string, b: string): string {
  return a.toLowerCase() <= b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return ethers.ZeroHash;
  let level = [...leaves].sort();   //    // deterministic order
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** Proof path for one leaf, used by selective disclosure. */
export function merkleProof(leaves: readonly string[], leaf: string): string[] {
  let level = [...leaves].sort();
  let idx = level.indexOf(leaf);
  if (idx < 0) throw new Error('merkleProof: leaf not found');

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
