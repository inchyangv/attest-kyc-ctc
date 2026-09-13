import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { refreshSnapshot, atomicFile } from '../../aml/snapshot-store';
import { currentGeneration } from '../../aml/loader';
import { SOURCES } from '../../aml/provenance';
import type { IssuanceEntry } from '../../pipeline/issuance-journal';

process.env.EVIDENCE_HMAC_KEY = 'synthetic-screen-route-key-at-least-32-characters';
process.env.SANCTIONS_MAX_AGE_HOURS = '168';
delete process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID;
const { GET, POST } = await import('../app/api/screen/route');
const { issuanceEvidenceSink } = await import('../lib/evidence-vault');

test('actual screen handlers expose the pinned fresh generation, reload warm content, and return 503 for corrupt, old-format or expired data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proofmark-screen-route-')), cwd = process.cwd(), now = Date.now();
  const path = join(root, 'data', 'sanctions-index.json.gz');
  try {
    process.chdir(root);
    const publish = async (name: string) => {
      const p = await refreshSnapshot(join(root, 'raw'), async id => ({
        bytes: Buffer.from(id === 'OFAC_SDN' ? `<sdnList><sdnEntry><uid>1</uid><lastName>${name}</lastName></sdnEntry></sdnList>`
          : id === 'UN_CONSOLIDATED' ? `<CONSOLIDATED_LIST><ENTITY><DATAID>2</DATAID><FIRST_NAME>${name}</FIRST_NAME></ENTITY></CONSOLIDATED_LIST>`
          : `<export><sanctionEntity logicalId="3"><nameAlias wholeName="${name}"/></sanctionEntity></export>`),
        effectiveUrl: id === 'OFAC_SDN' ? 'https://PRIVATE_USER:PRIVATE_PASSWORD@cdn.example.test/list.xml?sig=PRIVATE_SAS#PRIVATE_FRAGMENT' : SOURCES[id].url,
        fetchedAt: new Date(now).toISOString(), httpLastModified: null,
      }), () => now);
      atomicFile(path, readFileSync(join(currentGeneration(join(root, 'raw')), 'sanctions-index.json.gz')));
      return p;
    };
    const status = () => GET(new Request('http://localhost/api/screen'));
    const screen = () => POST(new Request('http://localhost/api/screen', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Synthetic Ordinary', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '8'.repeat(40) }) }));
    const first = await publish('Listed Example');
    const initialStatus = await status(); assert.equal(initialStatus.status, 200);
    assert.doesNotMatch(await initialStatus.text(), /PRIVATE_|[?&]sig=/);
    let response = await screen(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    let body = await response.json(); assert.equal(body.decision, 'ALLOW'); assert.equal(body.sourceSnapshot.snapshotId, first.snapshotId);
    assert.equal(body.sourceSnapshot.v, 2);
    assert.equal(body.sourceSnapshot.sources.OFAC_SDN.effectiveUrl, 'https://cdn.example.test/list.xml');
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|[?&]sig=/);
    const prepared = {
      outcome: { status: 'ISSUED', screeningSnapshotId: first.snapshotId }, evidenceRecord: undefined,
    } as unknown as IssuanceEntry;
    await issuanceEvidenceSink.assertMayBroadcast(prepared);
    const second = await publish('Synthetic Ordinary');
    await assert.rejects(issuanceEvidenceSink.assertMayBroadcast(prepared), /SANCTIONS_SNAPSHOT_CHANGED/);
    response = await screen(); body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.decision, 'REVIEW'); assert.equal(body.sourceSnapshot.snapshotId, second.snapshotId);
    process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID = first.snapshotId;
    assert.equal((await status()).status, 503); assert.equal((await screen()).status, 503);
    delete process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID;
    atomicFile(path, 'broken');
    assert.equal((await status()).status, 503); assert.equal((await screen()).status, 503);
    atomicFile(path, gzipSync(JSON.stringify({ v: 2, builtAt: new Date(now).toISOString() })));
    assert.equal((await screen()).status, 503);
    await publish('Listed Example');
    t.mock.method(Date, 'now', () => now + 169 * 3_600_000);
    assert.equal((await status()).status, 503); assert.equal((await screen()).status, 503);
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
