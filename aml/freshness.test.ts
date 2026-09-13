import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { refreshSnapshot, atomicFile } from './snapshot-store.js';
import { currentGeneration, loadLists, parseListBytes } from './loader.js';
import { LIST_IDS, SOURCES, assertProvenance, freshnessHours, freshnessHoursFor, publicEffectiveUrl, snapshotId, sha256, type ListProvenance } from './provenance.js';
import { readIndex } from './index-format.js';
import { IndexEngineCache } from './index-cache.js';
import { ListBackedAmlEngine, evidenceDigest } from './engine.js';
import type { ListId } from './types.js';

const key = 'synthetic-freshness-only-key-32-chars';
const subject = { fullName: 'Ordinary Sample', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '9'.repeat(40) };
function xml(id: ListId, name = 'Listed Example'): Buffer {
  return Buffer.from(id === 'OFAC_SDN' ? `<sdnList><sdnEntry><uid>1</uid><lastName>${name}</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>`
    : id === 'UN_CONSOLIDATED' ? `<CONSOLIDATED_LIST><INDIVIDUAL><DATAID>2</DATAID><FIRST_NAME>${name}</FIRST_NAME></INDIVIDUAL></CONSOLIDATED_LIST>`
    : `<export><sanctionEntity logicalId='3'><nameAlias wholeName='${name}'/><subjectType code='person'/></sanctionEntity></export>`);
}
function download(at: number, name?: string) {
  return async (id: ListId) => ({ bytes: xml(id, name), fetchedAt: new Date(at).toISOString(), effectiveUrl: SOURCES[id].url, httpLastModified: null });
}
const temp = () => mkdtempSync(join(tmpdir(), 'proofmark-freshness-test-'));
function rehash(p: ListProvenance): ListProvenance { const { snapshotId: _, ...body } = p; return { ...body, snapshotId: snapshotId(body) }; }

test('transport credentials are absent from manifest/index/evidence while exact URL hashes remain bound', async () => {
  const root = temp(), now = Date.now();
  const transport = 'https://PRIVATE_USER:PRIVATE_PASSWORD@cdn.example.test/official.xml?X-Amz-Signature=PRIVATE_SIG&sig=PRIVATE_SAS#PRIVATE_FRAGMENT';
  try {
    const p = await refreshSnapshot(root, async id => ({ ...await download(now)(id), effectiveUrl: transport }), () => now);
    assert.equal(p.v, 2);
    for (const id of LIST_IDS) {
      assert.equal(p.sources[id].effectiveUrl, 'https://cdn.example.test/official.xml');
      assert.equal(p.sources[id].effectiveUrlSha256, sha256(transport));
    }
    const dir = currentGeneration(root), bytes = readFileSync(join(dir, 'sanctions-index.json.gz'));
    const loaded = await loadLists(root), index = readIndex(bytes);
    const engine = new ListBackedAmlEngine({ ...loaded, evidenceKey: key });
    for (const text of [readFileSync(join(dir, 'manifest.json'), 'utf8'), gunzipSync(bytes).toString(), JSON.stringify(await engine.screen(subject))]) {
      assert.doesNotMatch(text, /PRIVATE_|X-Amz-Signature|[?&]sig=/);
    }
    assert.equal(index.meta.provenance.snapshotId, p.snapshotId);
    const changed = structuredClone(p); changed.sources.OFAC_SDN.effectiveUrlSha256 = sha256(transport + 'changed');
    assert.notEqual(rehash(changed).snapshotId, p.snapshotId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unsafe effective URLs and old manifests cannot be accepted by rehashing or warming an index', async () => {
  const root = temp(), now = Date.now();
  try {
    const p = await refreshSnapshot(root, download(now), () => now);
    for (const url of ['http://cdn.test/a', 'not-a-url', 'https://cdn.test/a\nPRIVATE_SECRET']) {
      assert.throws(() => publicEffectiveUrl(url), error => error instanceof Error && error.message === 'invalid sanctions transport URL');
    }
    for (const url of ['https://cdn.test/a?sig=PRIVATE_SECRET', 'https://PRIVATE_SECRET@cdn.test/a', 'https://cdn.test/a#PRIVATE_SECRET', 'https://cdn.test/a?']) {
      const bad = structuredClone(p); bad.sources.OFAC_SDN.effectiveUrl = url;
      assert.throws(() => assertProvenance(rehash(bad), now));
    }
    const old = { ...structuredClone(p), v: 1 } as unknown as ListProvenance;
    assert.throws(() => assertProvenance(rehash(old), now), /unsupported/);
    const path = join(currentGeneration(root), 'sanctions-index.json.gz'), cache = new IndexEngineCache();
    cache.get(path, key, 't1');
    const value = JSON.parse(gunzipSync(readFileSync(path)).toString()); value.provenance = rehash(old);
    atomicFile(path, gzipSync(JSON.stringify(value)));
    assert.throws(() => cache.get(path, key, 't1'), /unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all three fresh sources bind hashes, counts and engine evidence; caller mutation cannot alter a held engine', async () => {
  const root = temp();
  try {
    const p = await refreshSnapshot(root, download(Date.now()));
    const loaded = await loadLists(root);
    assert.equal(loaded.provenance.snapshotId, p.snapshotId);
    const e = new ListBackedAmlEngine({ ...loaded, evidenceKey: key });
    const before = await e.screen(subject);
    assert.equal(before.decision, 'ALLOW');
    assert.deepEqual(before.evidence.sourceSnapshot, p);
    loaded.entries[0].names.push(subject.fullName);
    loaded.provenance.sources.OFAC_SDN.checkedAt = '2099-01-01T00:00:00.000Z';
    before.evidence.sourceSnapshot!.sources.EU_FSF.sha256 = 'a'.repeat(64);
    assert.equal((await e.screen(subject)).decision, 'ALLOW');
    assert.deepEqual((await e.screen(subject)).evidence.sourceSnapshot, p);
    const evidence = (await e.screen(subject)).evidence;
    const changed = structuredClone(evidence); changed.sourceSnapshot!.sources.EU_FSF.sha256 = 'a'.repeat(64);
    assert.notEqual(evidenceDigest(evidence), evidenceDigest(changed));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale, future, wrong source IDs, bad chronology/hash/version and relaxed configuration fail closed', async () => {
  const root = temp(), now = Date.now();
  try {
    const p = await refreshSnapshot(root, download(now), () => now);
    assertProvenance(p, now + 168 * 3_600_000);
    assert.throws(() => assertProvenance(p, now + 168 * 3_600_000 + 1), /stale/);
    assert.throws(() => assertProvenance(p, now - 1), /future/);
    const mutations: ((p: ListProvenance) => void)[] = [
      p => { (p.sources as unknown as Record<string, unknown>).WRONG = p.sources.OFAC_SDN; delete (p.sources as Partial<typeof p.sources>).OFAC_SDN; },
      p => { p.sources.OFAC_SDN.checkedAt = new Date(now + 1).toISOString(); },
      p => { p.sources.OFAC_SDN.fetchedAt = new Date(now - 1).toISOString(); },
      p => { p.sources.EU_FSF.sourceUrl = 'https://untrusted.invalid'; },
      p => { p.sources.EU_FSF.sha256 = 'xyz'; },
      p => { p.sources.UN_CONSOLIDATED.entryCount = 0; },
      p => { p.parserVersion = 'future-version'; },
      p => { p.createdAt = 'September 7, 2026'; },
    ];
    for (const change of mutations) { const bad = structuredClone(p); change(bad); assert.throws(() => assertProvenance(rehash(bad), now)); }
    const tampered = structuredClone(p); tampered.sources.EU_FSF.bytes++;
    assert.throws(() => assertProvenance(tampered, now), /hash mismatch/);
    for (const s of ['0', '-1', '169', 'Infinity', 'NaN', '']) assert.throws(() => freshnessHours(s));
    assert.equal(freshnessHours('24'), 24);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('screen, issuance, rescreen and epoch select explicit purpose-specific freshness limits', () => {
  const env = {
    SANCTIONS_MAX_AGE_HOURS: '168', SANCTIONS_SCREEN_MAX_AGE_HOURS: '72', SANCTIONS_ISSUANCE_MAX_AGE_HOURS: '24',
    SANCTIONS_RESCREEN_MAX_AGE_HOURS: '12', SANCTIONS_EPOCH_MAX_AGE_HOURS: '6',
  };
  assert.equal(freshnessHoursFor('screen', env), 72);
  assert.equal(freshnessHoursFor('issuance', env), 24);
  assert.equal(freshnessHoursFor('rescreen', env), 12);
  assert.equal(freshnessHoursFor('epoch', env), 6);
  assert.equal(freshnessHoursFor('issuance', { SANCTIONS_MAX_AGE_HOURS: '48' }), 48);
  assert.throws(() => freshnessHoursFor('rescreen', { SANCTIONS_RESCREEN_MAX_AGE_HOURS: '169' }));
});

test('failed or partial refresh preserves the entire old generation; unchanged GET advances check evidence, not content versions', async () => {
  const root = temp(), now = Date.now() - 100;
  try {
    const p = await refreshSnapshot(root, download(now), () => now);
    const old = readFileSync(join(root, 'current.json'), 'utf8');
    await assert.rejects(refreshSnapshot(root, async id => {
      if (id === 'UN_CONSOLIDATED') throw new Error('simulated timeout');
      return download(now + 1, 'Different Entry')(id);
    }, () => now + 1), /timeout/);
    assert.equal(readFileSync(join(root, 'current.json'), 'utf8'), old);
    assert.equal((await loadLists(root)).provenance.snapshotId, p.snapshotId);
    const updated = await refreshSnapshot(root, download(now + 2), () => now + 2);
    assert.notEqual(updated.snapshotId, p.snapshotId);
    for (const id of LIST_IDS) assert.equal(updated.sources[id].sha256, p.sources[id].sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing manifest, mixed/tampered raw content and touching stale files cannot produce fresh data', async t => {
  const root = temp(), now = Date.now();
  try {
    for (const id of LIST_IDS) writeFileSync(join(root, SOURCES[id].file), xml(id));
    await assert.rejects(loadLists(root), /current.json/);
    await refreshSnapshot(root, download(now), () => now);
    const file = join(currentGeneration(root), SOURCES.OFAC_SDN.file);
    writeFileSync(file, xml('OFAC_SDN', 'Changed Person'));
    await assert.rejects(loadLists(root), /hash\/size mismatch/);
    await refreshSnapshot(root, download(now), () => now);
    const path = join(currentGeneration(root), SOURCES.OFAC_SDN.file);
    t.mock.method(Date, 'now', () => now + 169 * 3_600_000);
    utimesSync(path, new Date(Date.now()), new Date(Date.now()));
    await assert.rejects(loadLists(root), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exclusive refresh ownership and gross source count loss cannot switch the active pointer', async () => {
  const root = temp(), now = Date.now();
  try {
    await refreshSnapshot(root, async id => {
      const d = await download(now)(id);
      if (id === 'OFAC_SDN') {
        const entry = d.bytes.toString().slice('<sdnList>'.length, -'</sdnList>'.length);
        d.bytes = Buffer.from(`<sdnList>${[1, 2, 3, 4, 5].map(i => entry.replace('<uid>1</uid>', `<uid>${i}</uid>`)).join('')}</sdnList>`);
      }
      return d;
    }, () => now);
    const original = readFileSync(join(root, 'current.json'), 'utf8');
    writeFileSync(join(root, '.refresh.lock'), 'synthetic-other-owner');
    let called = false;
    await assert.rejects(refreshSnapshot(root, async id => { called = true; return download(now)(id); }), /EEXIST/);
    assert.equal(called, false);
    assert.equal(readFileSync(join(root, '.refresh.lock'), 'utf8'), 'synthetic-other-owner');
    rmSync(join(root, '.refresh.lock'));
    await assert.rejects(refreshSnapshot(root, download(now), () => now), /count dropped/);
    assert.equal(readFileSync(join(root, 'current.json'), 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed/partial XML, HTML, DTD, duplicate/missing IDs fail; single quotes and comments are parsed correctly', async () => {
  const good = xml('OFAC_SDN').toString();
  for (const bad of [good.slice(0, -10), good.replace('</uid>', '</wrong>'), '<html>login</html>',
    '<!DOCTYPE sdnList><sdnList/>', good.replace('<uid>1</uid>', ''), good.replace('</sdnList>', good.slice(9))]) {
    await assert.rejects(parseListBytes(Buffer.from(bad), 'OFAC_SDN'));
  }
  const withComment = good.replace('<sdnList>', '<sdnList><!-- <sdnEntry><uid>evil</uid><lastName>Ghost</lastName></sdnEntry> -->');
  assert.equal((await parseListBytes(Buffer.from(withComment), 'OFAC_SDN')).length, 1);
  assert.equal((await parseListBytes(xml('EU_FSF'), 'EU_FSF'))[0].primaryName, 'Listed Example');
});

test('warm cache reloads actual content; corrupt/missing replacement never falls back; returned metadata is detached', async () => {
  const root = temp(), cache = new IndexEngineCache(), path = join(root, 'active.gz');
  try {
    const first = await refreshSnapshot(root, download(Date.now()));
    atomicFile(path, readFileSync(join(currentGeneration(root), 'sanctions-index.json.gz')));
    const a = cache.get(path, key, 't1');
    a.meta.provenance.sources.OFAC_SDN.entryCount = 900;
    assert.equal(cache.get(path, key, 't1').meta.provenance.sources.OFAC_SDN.entryCount, 1);
    await refreshSnapshot(root, download(Date.now(), subject.fullName));
    atomicFile(path, readFileSync(join(currentGeneration(root), 'sanctions-index.json.gz')));
    const b = cache.get(path, key, 't1');
    assert.notEqual(b.meta.provenance.snapshotId, first.snapshotId);
    assert.notEqual(a.engine, b.engine);
    assert.equal((await b.engine.screen(subject)).decision, 'REVIEW');
    writeFileSync(path, 'corrupt');
    assert.throws(() => cache.get(path, key, 't1'));
    rmSync(path); assert.throws(() => cache.get(path, key, 't1'), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('held engine and warm cache expire without restart and cannot be refreshed by modifying a returned result', async t => {
  const root = temp(), now = Date.now(), cache = new IndexEngineCache();
  try {
    await refreshSnapshot(root, download(now), () => now);
    const path = join(currentGeneration(root), 'sanctions-index.json.gz');
    const { engine } = cache.get(path, key, 't1');
    t.mock.method(Date, 'now', () => now + 169 * 3_600_000);
    assert.throws(() => cache.get(path, key, 't1'), /stale/);
    await assert.rejects(engine.screen(subject), /stale/);
    await assert.rejects(engine.listVersions(), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('baked index rejects legacy version, wrong counts/versions, malformed entries and a fresh build over old evidence', async () => {
  const root = temp();
  try {
    await refreshSnapshot(root, download(Date.now()));
    const bytes = readFileSync(join(currentGeneration(root), 'sanctions-index.json.gz'));
    const source = JSON.parse(gunzipSync(bytes).toString());
    const changes: ((p: typeof source) => void)[] = [p => { p.v = 2; }, p => { p.v = 4; },
      p => { p.counts.OFAC_SDN++; }, p => { p.listVersions.OFAC_SDN++; },
      p => { p.entries[0].l = 3; p.entriesSha256 = sha256(JSON.stringify(p.entries)); },
      p => { p.entries[0].i = ''; p.entriesSha256 = sha256(JSON.stringify(p.entries)); },
      p => { p.entries[0].p = 'tampered'; }, p => { p.builtAt = '2099-01-01T00:00:00.000Z'; }];
    for (const change of changes) { const p = structuredClone(source); change(p); assert.throws(() => readIndex(gzipSync(JSON.stringify(p)))); }
    assert.throws(() => readIndex(bytes, Date.now() + 169 * 3_600_000), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
