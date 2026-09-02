import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  buildRoster, inclusionProof, verifyInclusion,
  nonInclusionProof, verifyNonInclusion,
  rosterLeaf, subjectKey, leafIndexOf, MIN_KEY, MAX_KEY,
  type RosterEntry,
} from './roster.js';

function entry(seed: number): RosterEntry {
  const addr = ethers.getAddress('0x' + seed.toString(16).padStart(40, '0'));
  return {
    subject: addr,
    attrs: ethers.zeroPadValue(ethers.toBeHex(BigInt(seed) << 200n), 32),
    claimsRoot: ethers.keccak256(ethers.toUtf8Bytes(`claims${seed}`)),
    evidenceHash: ethers.keccak256(ethers.toUtf8Bytes(`ev${seed}`)),
    issuer: ethers.getAddress('0x' + 'ee'.repeat(20)),
  };
}

const set = (n: number) => Array.from({ length: n }, (_, i) => entry(i + 1));

describe('roster tree: inclusion proofs', () => {
  for (const n of [1, 2, 3, 7, 8, 33]) {
    test(`${n} entries: every item proves inclusion`, () => {
      const tree = buildRoster(set(n));
      for (let i = 0; i < tree.entries.length; i++) {
        const li = leafIndexOf(i);
        assert.ok(verifyInclusion(tree.root, tree.leaves[li], inclusionProof(tree, li)),
          `item ${i} failed its inclusion proof`);
      }
    });
  }

  test('a forged leaf fails verification', () => {
    const tree = buildRoster(set(5));
    const p = inclusionProof(tree, leafIndexOf(2));
    const fake = ethers.keccak256(ethers.toUtf8Bytes('fake'));
    assert.ok(!verifyInclusion(tree.root, fake, p));
  });

  test('a proof for another index does not verify', () => {
    const tree = buildRoster(set(5));
    const p = inclusionProof(tree, leafIndexOf(1));
    assert.ok(!verifyInclusion(tree.root, tree.leaves[leafIndexOf(2)], p));
  });
});

describe('roster tree: non-inclusion proofs, how revocation is expressed', () => {
  test('a subject absent from the roster proves non-inclusion', () => {
    const tree = buildRoster(set(10));
    const outsider = ethers.getAddress('0x' + 'ab'.repeat(20));
    const p = nonInclusionProof(tree, outsider);
    assert.ok(verifyNonInclusion(tree.root, outsider, p));
  });

  test('many outside subjects all prove', () => {
    const tree = buildRoster(set(20));
    for (let i = 100; i < 110; i++) {
      const out = ethers.getAddress('0x' + i.toString(16).padStart(40, '0'));
      assert.ok(verifyNonInclusion(tree.root, out, nonInclusionProof(tree, out)), `${out} failed`);
    }
  });

  test('a listed subject cannot produce a non-inclusion proof', () => {
    const tree = buildRoster(set(5));
    assert.throws(() => nonInclusionProof(tree, tree.entries[2].subject), /in the roster/);
  });

  test('non-adjacent leaves do not pass', () => {
    // without this check a forged gap that skips entries passes
    const tree = buildRoster(set(10));
    const target = tree.entries[4].subject;           // actually in the roster
    const p = {
      left:  inclusionProof(tree, leafIndexOf(2)), leftKey:  tree.keys[leafIndexOf(2)], leftMark:  tree.marks[leafIndexOf(2)],
      right: inclusionProof(tree, leafIndexOf(7)), rightKey: tree.keys[leafIndexOf(7)], rightMark: tree.marks[leafIndexOf(7)],
    };
    assert.ok(!verifyNonInclusion(tree.root, target, p), 'non-adjacent leaves passed a non-inclusion check');
  });

  test('adjacent real leaves cannot be relabelled around a subject that is present', () => {
    const tree = buildRoster(set(10));
    const targetEntry = 4;
    const target = tree.entries[targetEntry].subject;
    const rightIndex = leafIndexOf(targetEntry);
    const leftIndex = rightIndex - 1;

    // This is the exact old exploit: both physical leaves and proofs are real and adjacent, while
    // caller-chosen keys falsely claim they surround the target. Recomputing leaf(key, mark) kills it.
    const forged = {
      left: inclusionProof(tree, leftIndex), leftKey: MIN_KEY, leftMark: tree.marks[leftIndex],
      right: inclusionProof(tree, rightIndex), rightKey: MAX_KEY, rightMark: tree.marks[rightIndex],
    };
    assert.equal(verifyNonInclusion(tree.root, target, forged), false);
  });

  test('sentinels bound every possible key, so there are no boundary cases', () => {
    const tree = buildRoster(set(6));
    assert.equal(tree.keys[0], MIN_KEY);
    assert.equal(tree.keys[tree.keys.length - 1], MAX_KEY);
    // every address lands between the sentinels
    for (const seed of [0xffff, 0x1, 0xdeadbeef]) {
      const a = ethers.getAddress('0x' + seed.toString(16).padStart(40, '0'));
      const k = subjectKey(a);
      assert.ok(MIN_KEY < k && k < MAX_KEY);
    }
  });
});

describe('roster tree: determinism and integrity', () => {
  test('input order does not change the root; sorting is deterministic', () => {
    const a = buildRoster(set(9));
    const b = buildRoster([...set(9)].reverse());
    assert.equal(a.root, b.root);
  });

  test('changing any entry changes the root', () => {
    const base = set(5);
    const a = buildRoster(base);
    const mutated = base.map((e, i) => i === 2 ? { ...e, attrs: ethers.ZeroHash } : e);
    assert.notEqual(buildRoster(mutated).root, a.root);
  });

  test('revocation is falling out of the root', () => {
    const base = set(8);
    const before = buildRoster(base);
    const revoked = base[3].subject;

    // before revocation, inclusion proves
    assert.ok(verifyInclusion(before.root, before.leaves[leafIndexOf(3)], inclusionProof(before, leafIndexOf(3))));

    // drop it from the next epoch and non-inclusion proves
    const after = buildRoster(base.filter((e) => e.subject !== revoked));
    assert.ok(verifyNonInclusion(after.root, revoked, nonInclusionProof(after, revoked)));
    assert.notEqual(after.root, before.root);
  });

  test('duplicate subjects are rejected', () => {
    const dup = [entry(1), entry(1)];
    assert.throws(() => buildRoster(dup), /duplicate/);
  });

  test('an empty roster still works on sentinels alone, so nobody is included', () => {
    const tree = buildRoster([]);
    const anyone = ethers.getAddress('0x' + '11'.repeat(20));
    assert.ok(verifyNonInclusion(tree.root, anyone, nonInclusionProof(tree, anyone)));
  });

  test('at 1000 entries the depth stays logarithmic', () => {
    const tree = buildRoster(set(1000));
    assert.equal(tree.leaves.length, 1002);   //    // plus 2 sentinels
    assert.ok(tree.layers.length - 1 <= 11, `depth ${tree.layers.length - 1}`);
    const p = inclusionProof(tree, 500);
    assert.ok(p.siblings.length <= 11);
    assert.ok(verifyInclusion(tree.root, tree.leaves[500], p));
  });
});
