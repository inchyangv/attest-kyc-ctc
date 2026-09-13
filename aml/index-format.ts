import { gzipSync, gunzipSync } from 'node:zlib';
import type { SanctionEntry } from './ingest/parse.js';
import { LIST_IDS, assertProvenance, listVersionsOf, sha256, type ListProvenance } from './provenance.js';

export const INDEX_VERSION = 3;
export interface SlimEntry { l: number; i: string; p: string; n: string[]; d: string[]; c: string[]; w: string[]; t: number }
export interface IndexMeta {
  v: 3;
  builtAt: string;
  provenance: ListProvenance;
  entriesSha256: string;
  listVersions: Record<string, number>;
  counts: Record<string, number>;
  /** Compatibility display field: last full source GET, never publication time. */
  sourceUpdatedAt: Record<string, string>;
}
export function buildIndex(entries: SanctionEntry[], provenance: ListProvenance, now = Date.now()): Buffer {
  assertProvenance(provenance, now);
  const slim: SlimEntry[] = entries.map(e => ({
    l: LIST_IDS.indexOf(e.listId), i: e.entryId, p: e.primaryName, n: e.names, d: e.dobs, c: e.countries,
    w: e.cryptoAddresses.filter(a => /^0x[0-9a-f]{40}$/.test(a)), t: e.type === 'individual' ? 0 : e.type === 'entity' ? 1 : 2,
  }));
  const meta: IndexMeta = {
    v: INDEX_VERSION, builtAt: new Date(now).toISOString(), provenance, entriesSha256: sha256(JSON.stringify(slim)),
    listVersions: listVersionsOf(provenance),
    counts: Object.fromEntries(LIST_IDS.map(id => [id, provenance.sources[id].entryCount])),
    sourceUpdatedAt: Object.fromEntries(LIST_IDS.map(id => [id, provenance.sources[id].checkedAt])),
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify({ ...meta, entries: slim })), { level: 9 });
  readIndex(compressed, now); // Build cannot publish an artifact its reader rejects.
  return compressed;
}
export function readIndex(compressed: Buffer, now = Date.now()) {
  if (compressed.length > 32 * 1024 * 1024) throw new Error('sanctions compressed index too large');
  const value = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')) as IndexMeta & { entries: SlimEntry[] };
  if (value.v !== INDEX_VERSION) throw new Error('unsupported sanctions index; fetch and rebuild v3');
  assertProvenance(value.provenance, now);
  const built = Date.parse(value.builtAt);
  if (!Number.isFinite(built) || new Date(built).toISOString() !== value.builtAt || built > now || built < Date.parse(value.provenance.createdAt)) throw new Error('invalid sanctions build time');
  if (!Array.isArray(value.entries) || sha256(JSON.stringify(value.entries)) !== value.entriesSha256) throw new Error('sanctions index entry hash mismatch');
  const counts: Record<string, number> = {}, seen = new Set<string>();
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
  const entries: SanctionEntry[] = value.entries.map(e => {
    if (!e || !Number.isInteger(e.l) || e.l < 0 || e.l >= LIST_IDS.length || ![0, 1, 2].includes(e.t) ||
      typeof e.i !== 'string' || !e.i || typeof e.p !== 'string' || !e.p || !strings(e.n) || !e.n.length || e.n.some(n => !n) ||
      !strings(e.d) || !strings(e.c) || !strings(e.w) || e.w.some(w => !/^0x[0-9a-f]{40}$/.test(w))) throw new Error('invalid sanctions index entry');
    const listId = LIST_IDS[e.l], key = `${listId}:${e.i}`;
    if (seen.has(key)) throw new Error('duplicate sanctions index entry');
    seen.add(key); counts[listId] = (counts[listId] ?? 0) + 1;
    return { listId, entryId: e.i, primaryName: e.p, names: e.n, dobs: e.d, countries: e.c, cryptoAddresses: e.w, programs: [],
      type: e.t === 0 ? 'individual' : e.t === 1 ? 'entity' : 'unknown' };
  });
  const versions = listVersionsOf(value.provenance);
  for (const field of ['counts', 'listVersions', 'sourceUpdatedAt'] as const) {
    if (!value[field] || Object.keys(value[field]).sort().join() !== [...LIST_IDS].sort().join()) throw new Error(`invalid sanctions ${field}`);
  }
  for (const id of LIST_IDS) {
    if (counts[id] !== value.provenance.sources[id].entryCount || counts[id] !== value.counts[id] ||
      value.listVersions[id] !== versions[id] || value.sourceUpdatedAt[id] !== value.provenance.sources[id].checkedAt) throw new Error(`inconsistent sanctions index ${id}`);
  }
  const { entries: _slim, ...meta } = value;
  return { entries, meta };
}
