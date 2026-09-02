/**
 * Bakes a slim index holding only what screening needs.
 * Parsing 57MB of XML per request is not something a serverless function can do.
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadLists } from './loader.js';

const { entries, listVersions, counts } = await loadLists();
const rawFiles = {
  OFAC_SDN: 'data/raw/ofac_sdn.xml',
  UN_CONSOLIDATED: 'data/raw/un_consolidated.xml',
  EU_FSF: 'data/raw/eu_fsf.xml',
};
const sourceUpdatedAt = Object.fromEntries(
  Object.entries(rawFiles).map(([id, path]) => [id, statSync(path).mtime.toISOString()]),
);

// Keep names, dates of birth, countries and crypto addresses. Programs, addresses and remarks
const slim = entries.map(e => ({
  l: e.listId === 'OFAC_SDN' ? 0 : e.listId === 'UN_CONSOLIDATED' ? 1 : 2,
  i: e.entryId,
  p: e.primaryName,
  n: e.names,
  d: e.dobs,
  c: e.countries,
  w: e.cryptoAddresses.filter(a => /^0x[0-9a-f]{40}$/.test(a)),
  t: e.type === 'individual' ? 0 : e.type === 'entity' ? 1 : 2,
}));

mkdirSync('web/data', { recursive: true });
const payload = JSON.stringify({ v: 2, builtAt: new Date().toISOString(), sourceUpdatedAt, listVersions, counts, entries: slim });
const gz = gzipSync(Buffer.from(payload), { level: 9 });
writeFileSync('web/data/sanctions-index.json.gz', gz);

console.log(`entries ${slim.length}, names ${slim.reduce((s,e)=>s+e.n.length,0)}`);
console.log(`raw JSON ${(payload.length/1e6).toFixed(1)}MB -> gzip ${(gz.length/1e6).toFixed(2)}MB`);
console.log(`list versions:`, listVersions);
