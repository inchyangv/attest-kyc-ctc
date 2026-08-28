import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from './store.js';
import { Backoff } from './retry.js';
import { computeQueryId, txIndexFromProof } from './proof.js';

function tmpStore(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-'));
  return { path: join(dir, 'worker.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('queryId — ASC 와 바이트 단위 일치', () => {
  test('고정 벡터가 Solidity 결과와 같다', () => {
    // test/QueryId.t.sol:test_QueryIdKnownVector 의 기대값
    assert.equal(
      computeQueryId(1, 11597452, 7),
      '0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159',
    );
  });

  test('chainKey 가 다르면 queryId 도 다르다', () => {
    assert.notEqual(computeQueryId(1, 100, 5), computeQueryId(3, 100, 5));
  });

  test('blockHeight 가 다르면 queryId 도 다르다', () => {
    assert.notEqual(computeQueryId(1, 100, 5), computeQueryId(1, 101, 5));
  });
});

describe('txIndexFromProof', () => {
  test('빈 증명은 인덱스 0', () => {
    assert.equal(txIndexFromProof([]), 0n);
  });

  test('isLeft 비트열을 인덱스로 복원한다', () => {
    // siblings[0] 이 최하위 비트
    assert.equal(txIndexFromProof([{ isLeft: true }]), 1n);
    assert.equal(txIndexFromProof([{ isLeft: false }, { isLeft: true }]), 2n);
    assert.equal(txIndexFromProof([{ isLeft: true }, { isLeft: true }]), 3n);
  });
});

describe('Store — 영속성', () => {
  test('재시작 후 커서와 작업이 복원된다', () => {
    const { path, cleanup } = tmpStore();
    try {
      const a = new Store(path);
      a.setCursor(1000);
      a.add({ txHash: '0xaa', blockNumber: 900, action: 0, eventName: 'MarkIssued',
              logCount: 2, state: 'discovered', attempts: 0 });

      // 프로세스가 죽었다고 가정하고 새 인스턴스로 읽는다
      const b = new Store(path);
      assert.equal(b.cursor, 1000);
      assert.equal(b.get('0xaa')?.eventName, 'MarkIssued');
      assert.equal(b.get('0xaa')?.logCount, 2);
      assert.equal(b.pending().length, 1);
    } finally { cleanup(); }
  });

  test('커서는 되돌아가지 않는다', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.setCursor(500);
      s.setCursor(400);          // 되돌리기 시도
      assert.equal(s.cursor, 500);
    } finally { cleanup(); }
  });

  test('done/dead/skipped 는 pending 에서 빠진다', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      for (const [h, st] of [['0x1', 'discovered'], ['0x2', 'done'], ['0x3', 'dead'], ['0x4', 'skipped']] as const) {
        s.add({ txHash: h, blockNumber: 1, action: 0, eventName: 'MarkIssued',
                logCount: 1, state: st, attempts: 0 });
      }
      assert.equal(s.pending().length, 1);
      assert.equal(s.pending()[0].txHash, '0x1');
    } finally { cleanup(); }
  });

  test('쓰기는 원자적이다 — tmp 파일이 남지 않는다', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.setCursor(1);
      assert.ok(existsSync(path));
      assert.ok(!existsSync(`${path}.tmp`), 'tmp 파일이 남아 있으면 안 된다');
      JSON.parse(readFileSync(path, 'utf8'));   // 항상 파싱 가능해야 한다
    } finally { cleanup(); }
  });

  test('상태 전이가 영속화된다', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.add({ txHash: '0xbb', blockNumber: 5, action: 1, eventName: 'MarkRevoked',
              logCount: 1, state: 'discovered', attempts: 0 });
      s.update('0xbb', { state: 'submitted', ascTxHash: '0xcc' });

      const reopened = new Store(path);
      assert.equal(reopened.get('0xbb')?.state, 'submitted');
      assert.equal(reopened.get('0xbb')?.ascTxHash, '0xcc');
    } finally { cleanup(); }
  });
});

describe('Backoff', () => {
  test('지수적으로 증가하고 상한을 넘지 않는다', () => {
    const b = new Backoff(1000, 10_000, 2);
    for (let i = 0; i < 12; i++) {
      const d = b.delayFor(i);
      assert.ok(d > 0, '양수여야 한다');
      assert.ok(d <= 10_000, `상한 초과: ${d}`);
    }
    // 지터가 있으므로 여러 번 뽑아 평균 경향을 본다
    const avg = (n: number) => Array.from({ length: 50 }, () => b.delayFor(n)).reduce((a, c) => a + c) / 50;
    assert.ok(avg(3) > avg(0), '시도가 늘면 대기도 늘어야 한다');
  });
});
