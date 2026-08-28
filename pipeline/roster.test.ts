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

describe('명부 트리 — 포함 증명', () => {
  for (const n of [1, 2, 3, 7, 8, 33]) {
    test(`${n}건: 모든 항목의 포함 증명이 검증된다`, () => {
      const tree = buildRoster(set(n));
      for (let i = 0; i < tree.entries.length; i++) {
        const li = leafIndexOf(i);
        assert.ok(verifyInclusion(tree.root, tree.leaves[li], inclusionProof(tree, li)),
          `항목 ${i} 포함 증명 실패`);
      }
    });
  }

  test('리프를 위조하면 검증이 실패한다', () => {
    const tree = buildRoster(set(5));
    const p = inclusionProof(tree, leafIndexOf(2));
    const fake = ethers.keccak256(ethers.toUtf8Bytes('fake'));
    assert.ok(!verifyInclusion(tree.root, fake, p));
  });

  test('다른 인덱스의 증명은 통하지 않는다', () => {
    const tree = buildRoster(set(5));
    const p = inclusionProof(tree, leafIndexOf(1));
    assert.ok(!verifyInclusion(tree.root, tree.leaves[leafIndexOf(2)], p));
  });
});

describe('명부 트리 — 비포함 증명 (폐기 표현)', () => {
  test('명부에 없는 주체는 비포함이 증명된다', () => {
    const tree = buildRoster(set(10));
    const outsider = ethers.getAddress('0x' + 'ab'.repeat(20));
    const p = nonInclusionProof(tree, outsider);
    assert.ok(verifyNonInclusion(tree.root, outsider, p));
  });

  test('여러 외부 주체 모두 증명된다', () => {
    const tree = buildRoster(set(20));
    for (let i = 100; i < 110; i++) {
      const out = ethers.getAddress('0x' + i.toString(16).padStart(40, '0'));
      assert.ok(verifyNonInclusion(tree.root, out, nonInclusionProof(tree, out)), `${out} 실패`);
    }
  });

  test('명부에 있는 주체는 비포함 증명을 만들 수 없다', () => {
    const tree = buildRoster(set(5));
    assert.throws(() => nonInclusionProof(tree, tree.entries[2].subject), /명부에 있습니다/);
  });

  test('★ 인접하지 않은 두 리프로는 통과하지 못한다', () => {
    // 이 검사가 없으면 중간을 건너뛴 위조가 통과한다
    const tree = buildRoster(set(10));
    const target = tree.entries[4].subject;           // 실제로는 명부에 있다
    const p = {
      left:  inclusionProof(tree, leafIndexOf(2)), leftLeaf:  tree.leaves[leafIndexOf(2)], leftKey:  tree.keys[leafIndexOf(2)],
      right: inclusionProof(tree, leafIndexOf(7)), rightLeaf: tree.leaves[leafIndexOf(7)], rightKey: tree.keys[leafIndexOf(7)],
    };
    assert.ok(!verifyNonInclusion(tree.root, target, p), '비인접 리프로 비포함이 통과했다');
  });

  test('★ 센티넬 덕분에 경계 케이스가 없다 — 최소·최대 키 바깥이 존재하지 않는다', () => {
    const tree = buildRoster(set(6));
    assert.equal(tree.keys[0], MIN_KEY);
    assert.equal(tree.keys[tree.keys.length - 1], MAX_KEY);
    // 어떤 주소든 센티넬 사이에 들어온다
    for (const seed of [0xffff, 0x1, 0xdeadbeef]) {
      const a = ethers.getAddress('0x' + seed.toString(16).padStart(40, '0'));
      const k = subjectKey(a);
      assert.ok(MIN_KEY < k && k < MAX_KEY);
    }
  });
});

describe('명부 트리 — 결정성과 무결성', () => {
  test('입력 순서가 달라도 같은 루트 — 정렬이 결정적이다', () => {
    const a = buildRoster(set(9));
    const b = buildRoster([...set(9)].reverse());
    assert.equal(a.root, b.root);
  });

  test('한 항목이라도 바뀌면 루트가 달라진다', () => {
    const base = set(5);
    const a = buildRoster(base);
    const mutated = base.map((e, i) => i === 2 ? { ...e, attrs: ethers.ZeroHash } : e);
    assert.notEqual(buildRoster(mutated).root, a.root);
  });

  test('폐기 = 루트에서 빠지는 것', () => {
    const base = set(8);
    const before = buildRoster(base);
    const revoked = base[3].subject;

    // 폐기 전에는 포함이 증명된다
    assert.ok(verifyInclusion(before.root, before.leaves[leafIndexOf(3)], inclusionProof(before, leafIndexOf(3))));

    // 다음 에폭에서 빼면 비포함이 증명된다
    const after = buildRoster(base.filter((e) => e.subject !== revoked));
    assert.ok(verifyNonInclusion(after.root, revoked, nonInclusionProof(after, revoked)));
    assert.notEqual(after.root, before.root);
  });

  test('중복 주체는 거부한다', () => {
    const dup = [entry(1), entry(1)];
    assert.throws(() => buildRoster(dup), /중복/);
  });

  test('빈 명부도 센티넬만으로 성립한다 — 전원 비포함', () => {
    const tree = buildRoster([]);
    const anyone = ethers.getAddress('0x' + '11'.repeat(20));
    assert.ok(verifyNonInclusion(tree.root, anyone, nonInclusionProof(tree, anyone)));
  });

  test('규모 확인 — 1000건에서 깊이가 로그로 유지된다', () => {
    const tree = buildRoster(set(1000));
    assert.equal(tree.leaves.length, 1002);              // + 센티넬 2
    assert.ok(tree.layers.length - 1 <= 11, `깊이 ${tree.layers.length - 1}`);
    const p = inclusionProof(tree, 500);
    assert.ok(p.siblings.length <= 11);
    assert.ok(verifyInclusion(tree.root, tree.leaves[500], p));
  });
});
