import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  buildRoster, inclusionProof, verifyInclusion,
  nonInclusionProof, verifyNonInclusion,
  rosterLeaf, subjectKey, leafIndexOf, leafOf, rosterRoot, MIN_KEY, MAX_KEY,
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

  test('v2 vectors agree with the Solidity fixture', () => {
    const tree = buildRoster(set(5));
    assert.equal(tree.root, '0xfd1fc0f9cc82c72c2771bc978ffdb61676508d3778f2499d27279be6f5c03297');
    assert.equal(tree.leaves[3], '0x050d0d386055a3f8c2254fa608426547ff72c10cb4a77052c3a4d9ec250e608a');
  });

  test('rejects empty, excess, wrong-size and aliased-index paths', () => {
    const tree = buildRoster(set(5));
    const p = inclusionProof(tree, 3);
    for (const altered of [
      { ...p, siblings: [] }, { ...p, siblings: [...p.siblings, ethers.ZeroHash] },
      { ...p, leafCount: 8 }, { ...p, leafCount: 1 }, { ...p, leafCount: 0 },
      { ...p, index: p.index + 8 }, { ...p, index: p.index + 2 ** 32 },
      { ...p, index: -1 }, { ...p, index: 1.5 }, { ...p, leafCount: Number.NaN },
    ]) assert.equal(verifyInclusion(tree.root, tree.leaves[3], altered), false);
    assert.throws(() => inclusionProof(tree, 0.5), /out of range/);
    assert.notEqual(rosterRoot(tree.layers.at(-1)![0], 8), tree.root);
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

  test('hex casing cannot change key ordering and forge absence for a listed subject', () => {
    const tree = buildRoster(set(5));
    const targetEntry = 2;
    const target = tree.entries[targetEntry].subject;
    const targetIndex = leafIndexOf(targetEntry);
    const sameKeyWithUppercaseDigits = `0x${tree.keys[targetIndex].slice(2).toUpperCase()}`;

    // The key bytes are identical. A raw JavaScript string comparison nevertheless places
    // uppercase A-F before lowercase a-f and can make the member appear left of itself.
    assert.deepEqual(ethers.getBytes(sameKeyWithUppercaseDigits), ethers.getBytes(tree.keys[targetIndex]));
    assert.equal(sameKeyWithUppercaseDigits < tree.keys[targetIndex], true, 'fixture must expose string ordering');
    assert.equal(verifyNonInclusion(tree.root, target, {
      left: inclusionProof(tree, targetIndex),
      leftKey: sameKeyWithUppercaseDigits,
      leftMark: tree.marks[targetIndex],
      right: inclusionProof(tree, targetIndex + 1),
      rightKey: tree.keys[targetIndex + 1],
      rightMark: tree.marks[targetIndex + 1],
    }), false, 'a textual encoding must not alter bytes32 ordering');
  });

  test('internal nodes at any depth cannot impersonate adjacent leaves', () => {
    for (const size of [2, 5, 6, 9]) {
      const tree = buildRoster(set(size));
      const nodes = tree.layers.slice(0, -1).flatMap((layer, level) => layer.map((_, index) => {
        let idx = index;
        const siblings: string[] = [];
        for (let l = level; l < tree.layers.length - 1; l++) {
          siblings.push(tree.layers[l][idx ^ 1] ?? tree.layers[l][idx]);
          idx >>= 1;
        }
        return {
          proof: { index, leafCount: tree.leaves.length, siblings },
          key: level ? tree.layers[level - 1][index * 2] : tree.keys[index],
          mark: level ? (tree.layers[level - 1][index * 2 + 1] ?? tree.layers[level - 1][index * 2]) : tree.marks[index],
        };
      }));
      for (const target of tree.entries) for (const left of nodes) for (const right of nodes) {
        if (right.proof.index !== left.proof.index + 1) continue;
        assert.equal(verifyNonInclusion(tree.root, target.subject, {
          left: left.proof, leftKey: left.key, leftMark: left.mark,
          right: right.proof, rightKey: right.key, rightMark: right.mark,
        }), false);
      }
      const node = ethers.keccak256(ethers.solidityPacked(
        ['bytes1', 'bytes32', 'bytes32'], ['0x01', tree.leaves[0], tree.leaves[1]],
      ));
      assert.notEqual(leafOf(tree.leaves[0], tree.leaves[1]), node);
    }
  });

  test('rejects the exact public epoch-1 review exploit', () => {
    const p = {
      left: { index: 0, leafCount: 4, siblings: [
        '0xbb18114919f158d7c2b3f1895fe76e2e67dc753800ac843eda5479d4fdbfd75d',
        '0xa09637336041ba36b37e6a41cb44622df981df1b35506054ef79a3cf75f4f59a',
      ] }, leftKey: MIN_KEY, leftMark: ethers.ZeroHash,
      right: { index: 1, leafCount: 4, siblings: [
        '0xee435ed92c2d049d1ab2ab0c480df0eaa5f35376441b38f789754b706878ede0',
      ] },
      rightKey: '0x9e1dc5ce841b03a33bab09d4a206c67a0afe3d7f0aab857a58ced05925237d45',
      rightMark: '0xbbd6e7dddd4326dd7c827841ab9733c6e3fcdf38a516374bd10feec8f674ea8a',
    };
    assert.equal(verifyNonInclusion(
      '0xfe6cf3e0fc518c85ec822fd119fa8291461ff5fc1e0a5d6dbe6be1e7e8f5364d',
      '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2', p,
    ), false);
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
