import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { loadLists } from './loader.js';
import { ListBackedAmlEngine } from './engine.js';
import { containsPii } from '../pipeline/pii-guard.js';

const HAVE = existsSync('data/raw/ofac_sdn.xml');

// 탐지기는 pipeline/pii-guard.ts 가 정본이다 — 중복 정의는 언젠가 갈라진다.
const leaks = (h: unknown, n: string) => containsPii(h, n);

test('★ 증적에 이름 원문이 없다 — NFC/NFD 가로질러 확인', { skip: !HAVE }, async () => {
  const { entries, listVersions } = await loadLists();
  const e = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'k', keyId: 't' });
  const name = '박서준';
  const r = await e.screen({ fullName: name, dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '0x'+'9'.repeat(40) });
  const ev = JSON.stringify(r.evidence);
  assert.equal(leaks(ev, name), false, '증적에 이름 원문이 남아 있다');
  for (const t of ['bak','seo','jun','park']) assert.equal(leaks(ev, t), false, `로마자 조각 "${t}" 유출`);
  assert.ok(r.evidence.nameDigest.startsWith('0x'));
  assert.ok(r.evidence.variantDigests.length > 0, '전개 다이제스트는 남아야 재현 가능하다');
});

test('★ 탐지기 자체 검증 — 순진한 includes 는 NFD 를 놓친다', () => {
  const nfd = '박서준'.normalize('NFD');
  assert.equal(nfd.includes('박서준'), false, '전제: 단순 비교는 실패한다');
  assert.equal(leaks(nfd, '박서준'), true, '탐지기는 잡아야 한다');
});

test('증적 키가 다르면 다이제스트가 다르다 (무염 해시가 아니다)', { skip: !HAVE }, async () => {
  const { entries, listVersions } = await loadLists();
  const s = { fullName: '홍길동', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x'+'8'.repeat(40) };
  const a = await new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'key-A' }).screen(s);
  const b = await new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'key-B' }).screen(s);
  assert.notEqual(a.evidence.nameDigest, b.evidence.nameDigest);
});

test('키 없이는 엔진을 만들 수 없다', () => {
  assert.throws(() => new ListBackedAmlEngine({ entries: [], listVersions: {}, evidenceKey: '' }));
});
