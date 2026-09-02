import { ethers } from 'ethers';

/**
 * Epoch roster tree, Mode B.
 *
 * The hard part is not proving a mark was issued. It is proving it was not revoked.
 * Membership proofs are easy; non-membership is decided by the data structure.
 *
 *   plain Merkle    no non-membership proof, so it only works as a whitelist
 *   sparse Merkle   works, but depth 160-256 makes verification too expensive
 *   sorted-key      adjacency proofs, depth about 20 at a million entries. Chosen.
 *
 * Non-membership in a sorted-key tree works like this:
 *   present two consecutive leaves with key_i < target < key_{i+1}.
 *   If both are in the tree and their indices are consecutive, nothing sits between them.
 *
 * OpenZeppelin's sorted-pair hashing does not work here. It discards position, so
 * consecutive indices cannot be proven. This tree is positional.
 */

export interface RosterEntry {
  subject: string;   // EVM address
  attrs: string;   // bytes32, packed scalars
  claimsRoot: string;
  evidenceHash: string;
  issuer: string;
}

export interface RosterTree {
  /** Real entries sorted by subjectKey, sentinels excluded */
  entries: RosterEntry[];
  /** All keys including sentinels. `keys[i+1]` corresponds to `entries[i]` */
  keys: string[];
  /** Mark hashes aligned with keys. Sentinel marks are zero. */
  marks: string[];
  /** All leaves including sentinels */
  leaves: string[];
  layers: string[][];           // layers[0] = leaves
  root: string;
}

/** Tree index of `entries[i]`. The sentinel shifts it by one. */
export function leafIndexOf(i: number): number { return i + 1; }

/** Leaves room for non-EVM subjects, CAIP-10 style. Fixed to the EVM namespace for now. */
export const EVM_NAMESPACE = 'eip155';

export function subjectKey(subject: string, namespace: string = EVM_NAMESPACE): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address'], [namespace, ethers.getAddress(subject)]),
  );
}

export function markHash(e: RosterEntry): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'address'],
      [e.attrs, e.claimsRoot, e.evidenceHash, ethers.getAddress(e.issuer)],
    ),
  );
}

export function rosterLeaf(e: RosterEntry, namespace: string = EVM_NAMESPACE): string {
  return ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [subjectKey(e.subject, namespace), markHash(e)]),
  );
}

/** Positional internal node. Left and right are not sorted. */
function hashNode(left: string, right: string): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));
}

/**
 * Boundary sentinels.
 *
 * Without them, proving that a target sits past the last key means proving that leaf really
 * is the last one, which the tree cannot show. An attacker offers a middle leaf and
 * non-membership passes even though the target sits further along.
 * With sentinels at both ends every non-membership becomes a gap between two adjacent
 * leaves, and the boundary case disappears along with the hole.
 */
export const MIN_KEY = '0x' + '00'.repeat(32);
export const MAX_KEY = '0x' + 'ff'.repeat(32);

const SENTINEL_MARK = '0x' + '00'.repeat(32);
const sentinelLeaf = (key: string) =>
  ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [key, SENTINEL_MARK]));

export function buildRoster(entries: readonly RosterEntry[], namespace: string = EVM_NAMESPACE): RosterTree {
  const withKeys = entries.map((e) => ({ e, k: subjectKey(e.subject, namespace) }));
  withKeys.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  for (let i = 1; i < withKeys.length; i++) {
    if (withKeys[i].k === withKeys[i - 1].k) {
      throw new Error(`buildRoster: duplicate subject ${withKeys[i].e.subject}`);
    }
  }

  for (const { k, e } of withKeys) {
    if (k === MIN_KEY || k === MAX_KEY) throw new Error(`buildRoster: ${e.subject} collides with a sentinel key`);
  }

  // Sentinels at both ends, so every non-membership is an adjacency proof
  const sorted = withKeys.map((x) => x.e);
  const keys = [MIN_KEY, ...withKeys.map((x) => x.k), MAX_KEY];
  const marks = [SENTINEL_MARK, ...sorted.map(markHash), SENTINEL_MARK];
  const leaves = keys.map((key, i) =>
    ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [key, marks[i]])),
  );

  const layers: string[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      // pair an odd tail with itself, keeping position
      next.push(hashNode(cur[i], i + 1 < cur.length ? cur[i + 1] : cur[i]));
    }
    layers.push(next);
  }

  return { entries: sorted, keys, marks, leaves, layers, root: layers[layers.length - 1][0] };
}

export interface InclusionProof {
  index: number;
  siblings: string[];
}

export function inclusionProof(tree: RosterTree, index: number): InclusionProof {
  if (index < 0 || index >= tree.leaves.length) throw new Error('inclusionProof: index out of range');
  const siblings: string[] = [];
  let idx = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const pair = idx ^ 1;
    siblings.push(pair < layer.length ? layer[pair] : layer[idx]);   // an odd tail pairs with itself
    idx >>= 1;
  }
  return { index, siblings };
}

export function verifyInclusion(root: string, leaf: string, proof: InclusionProof): boolean {
  let acc = leaf;
  let idx = proof.index;
  for (const s of proof.siblings) {
    acc = idx % 2 === 0 ? hashNode(acc, s) : hashNode(s, acc);
    idx >>= 1;
  }
  return acc.toLowerCase() === root.toLowerCase();
}

/**
 * Non-membership, expressed only as the gap between two adjacent leaves.
 * Sentinels remove the boundary cases.
 */
export interface NonInclusionProof {
  left: InclusionProof;  leftKey: string;  leftMark: string;
  right: InclusionProof; rightKey: string; rightMark: string;
}

/**
 * Proves the target is absent from the roster.
 * This is how revocation and never-issued are expressed: fall out of the root and you are out.
 */
export function nonInclusionProof(tree: RosterTree, target: string, namespace: string = EVM_NAMESPACE): NonInclusionProof {
  const tk = subjectKey(target, namespace);
  if (tree.keys.includes(tk)) throw new Error('nonInclusionProof: the target is in the roster');

  const hi = tree.keys.findIndex((k) => k > tk);
  if (hi <= 0) throw new Error('nonInclusionProof: outside the sentinel range');
  const lo = hi - 1;

  return {
    left:  inclusionProof(tree, lo), leftKey:  tree.keys[lo], leftMark:  tree.marks[lo],
    right: inclusionProof(tree, hi), rightKey: tree.keys[hi], rightMark: tree.marks[hi],
  };
}

export function verifyNonInclusion(
  root: string, target: string, proof: NonInclusionProof, namespace: string = EVM_NAMESPACE,
): boolean {
  const tk = subjectKey(target, namespace);
  // 1. does the target fall between the two keys
  if (!(proof.leftKey < tk && tk < proof.rightKey)) return false;
  // 2. are the leaves consecutive. Without this a forged gap that skips entries passes.
  if (proof.right.index !== proof.left.index + 1) return false;
  // 3. bind each ordering key to the leaf it claims. The old shape accepted keys and leaves
  // independently, allowing real adjacent leaves to be relabelled around a present target.
  const leftLeaf = ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [proof.leftKey, proof.leftMark]),
  );
  const rightLeaf = ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [proof.rightKey, proof.rightMark]),
  );
  return verifyInclusion(root, leftLeaf, proof.left)
      && verifyInclusion(root, rightLeaf, proof.right);
}
