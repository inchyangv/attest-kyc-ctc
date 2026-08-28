/**
 * 엔진 성질 테스트. 평가 스크립트의 수치를 CI 가 지키게 한다.
 * 실제 명단 3종이 data/raw 에 있어야 한다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { loadLists } from './loader.js';
import { ListBackedAmlEngine, evidenceDigest } from './engine.js';
import { nameScore } from './match.js';
import { M } from './types.js';

const HAVE_LISTS = existsSync('data/raw/ofac_sdn.xml');
let engine: ListBackedAmlEngine;
let entries: Awaited<ReturnType<typeof loadLists>>['entries'];

before(async () => {
  if (!HAVE_LISTS) return;
  const l = await loadLists();
  entries = l.entries;
  engine = new ListBackedAmlEngine({ entries, listVersions: l.listVersions, evidenceKey: 'test-only-evidence-key', keyId: 'test-k1' });
});

const clean = { dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '2'.repeat(40) };

test('짧은 이름에 포함 보정을 주지 않는다 (오탐 33%의 원인이었다)', () => {
  assert.ok(nameScore(['ji'], ['ji']) <= 1);
  // 2토큰끼리 부분 겹침이 만점 근처로 가면 안 된다
  assert.ok(nameScore(['kim','chol'], ['chol','ri']) < 0.5, '2토큰 부분 겹침이 과대평가된다');
  // 3토큰 이상에서는 포함 보정이 살아 있어야 재현율이 유지된다
  assert.ok(nameScore(['kim','jong','un'], ['kim','jong','un','marshal']) > 0.8);
});

test('재현율 — 명단 개인을 자기 정보로 조회하면 전원 걸린다', { skip: !HAVE_LISTS }, async () => {
  const inds = entries.filter(e => e.type === 'individual' && e.dobs.length && e.countries.length && e.primaryName.split(/\s+/).length >= 2);
  const step = Math.max(1, Math.floor(inds.length / 100));
  const sample = inds.filter((_, i) => i % step === 0).slice(0, 100);
  let caught = 0;
  for (const e of sample) {
    const r = await engine.screen({
      fullName: e.primaryName,
      dateOfBirth: e.dobs[0].length === 4 ? `${e.dobs[0]}-01-01` : e.dobs[0],
      nationality: e.countries[0], residence: e.countries[0], walletAddress: '0x' + '1'.repeat(40),
    });
    if (r.decision !== 'ALLOW') caught++;
  }
  assert.equal(caught, sample.length, `${sample.length - caught}건 통과 — 재현율 100% 유지되어야 한다`);
});

test('특이도 — 평범한 한국 이름 600명에 오탐이 없다', { skip: !HAVE_LISTS }, async () => {
  const SUR = ['김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권','황','안','송','전','홍','유','고','문','양','손','배','백','허','심','노'];
  const GIV = ['철수','영희','민준','서연','우진','지훈','현우','서준','하은','도윤','지민','세훈','지우','예은','나은','민서','준호','재현','다인','승우'];
  const fps: string[] = [];
  for (const s of SUR) for (const g of GIV) {
    const r = await engine.screen({ fullName: s + g, ...clean });
    if (r.decision !== 'ALLOW') fps.push(`${s}${g}→${r.decision}`);
  }
  assert.equal(fps.length, 0, `오탐 ${fps.length}건: ${fps.slice(0, 5).join(', ')}`);
});

test('★ 뒷받침 있는 한글 이름은 로마자 전개로 잡힌다', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: '김정은', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '0x' + '3'.repeat(40) });
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.riskBand, 5);
});

test('★ 뒷받침 없는 로마자 전개 적중은 사람을 붙잡지 않는다 — 단, 증적에는 남는다', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: '최영호', ...clean });
  assert.equal(r.decision, 'ALLOW', '우리가 만든 추론만으로 사람을 막으면 안 된다');
  assert.ok(r.hits.length > 0, '적중 자체는 기록되어야 한다 — 감사 경로');
  assert.equal(r.hits[0].corroborated, false);
});

test('회피 수법 — 동형문자·보이지 않는 문자·발음기호·어순', { skip: !HAVE_LISTS }, async () => {
  const t = entries.find(e => e.type === 'individual' && e.dobs.length && e.countries.length && /^[a-zA-Z ]+$/.test(e.primaryName) && e.primaryName.split(' ').length >= 3)!;
  const dob = t.dobs[0].length === 4 ? `${t.dobs[0]}-01-01` : t.dobs[0];
  const variants = [
    t.primaryName,
    t.primaryName.split('').join('​'),
    t.primaryName.replace(/a/gi, 'а').replace(/e/gi, 'е'),
    t.primaryName.replace(/a/gi, 'á'),
    t.primaryName.split(' ').reverse().join(' '),
  ];
  for (const v of variants) {
    const r = await engine.screen({ fullName: v, dateOfBirth: dob, nationality: t.countries[0], residence: t.countries[0], walletAddress: '0x' + '4'.repeat(40) });
    assert.equal(r.decision, 'BLOCK', `회피 통과: ${JSON.stringify(v)}`);
  }
});

test('제재 지갑 주소는 이름과 무관하게 차단된다', { skip: !HAVE_LISTS }, async () => {
  const e = entries.find(x => x.cryptoAddresses.some(a => /^0x[0-9a-f]{40}$/.test(a)))!;
  const addr = e.cryptoAddresses.find(a => /^0x[0-9a-f]{40}$/.test(a))!;
  const r = await engine.screen({ fullName: 'Totally Unrelated', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US', walletAddress: addr });
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.hits[0].matchType, 'wallet');
});

test('★ 하지 않은 심사는 비트를 세우지 않는다', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: 'Test Person', ...clean });
  assert.ok((r.methodsApplied & M.SANCTIONS_SCREENED) !== 0, '실명단으로 심사했으므로 세운다');
  assert.ok((r.methodsApplied & M.ONCHAIN_EXPOSURE) !== 0);
  assert.equal(r.methodsApplied & M.PEP_SCREENED, 0, 'PEP 데이터가 없는데 비트를 세우면 거짓말이다');
  assert.equal(r.methodsApplied & M.ADVERSE_MEDIA, 0);
});

test('증적은 결정적이다 — 같은 입력이면 같은 다이제스트', { skip: !HAVE_LISTS }, async () => {
  const s = { fullName: '홍길동', ...clean };
  const a = await engine.screen(s), b = await engine.screen(s);
  assert.equal(evidenceDigest(a.evidence), evidenceDigest(b.evidence));
  assert.ok(a.evidence.engineVersion.startsWith('aml-'));
});
