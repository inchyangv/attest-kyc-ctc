import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfac, parseUn, parseEu } from './ingest/parse.js';
import type { SanctionEntry } from './ingest/parse.js';
import { validateXml } from './ingest/validate.js';
import { LIST_IDS, SOURCES, assertProvenance, freshnessHoursFor, sha256, type ListProvenance, type SanctionsUse } from './provenance.js';
import type { ListId } from './types.js';

const parsers = { OFAC_SDN: parseOfac, UN_CONSOLIDATED: parseUn, EU_FSF: parseEu };
export async function parseListBytes(bytes: Buffer, id: ListId): Promise<SanctionEntry[]> {
  const entries = await parsers[id]({ xml: validateXml(bytes, id) });
  const ids = new Set<string>();
  if (!entries.length) throw new Error(`empty sanctions list ${id}`);
  for (const e of entries) {
    if (!e.entryId || !e.primaryName || !e.names.length || ids.has(e.entryId)) throw new Error(`missing/duplicate sanctions identity in ${id}`);
    ids.add(e.entryId);
  }
  return entries;
}
export function currentGeneration(root = 'data/raw'): string {
  const p = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')) as { generation: string };
  if (!/^[0-9a-f-]{36}$/.test(p.generation)) throw new Error('invalid sanctions generation pointer');
  return join(root, 'generations', p.generation);
}
async function readLists(dir: string, provenance?: ListProvenance) {
  const entries: SanctionEntry[] = [];
  const counts = {} as Record<ListId, number>, listVersions: Record<string, number> = {}, sourceSha256: Record<string, string> = {};
  for (const id of LIST_IDS) {
    const bytes = readFileSync(join(dir, SOURCES[id].file));
    const hash = sha256(bytes);
    if (provenance && (hash !== provenance.sources[id].sha256 || bytes.length !== provenance.sources[id].bytes)) throw new Error(`sanctions source hash/size mismatch ${id}`);
    const parsed = await parseListBytes(bytes, id); // Parse exactly the bytes hashed.
    if (provenance && parsed.length !== provenance.sources[id].entryCount) throw new Error(`sanctions source count mismatch ${id}`);
    counts[id] = parsed.length; listVersions[id] = parseInt(hash.slice(0, 8), 16); sourceSha256[id] = hash;
    entries.push(...parsed);
  }
  return { entries, counts, listVersions, sourceSha256 };
}
export async function loadLists(root = 'data/raw', use: SanctionsUse = 'screen') {
  const dir = currentGeneration(root);
  const provenance = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ListProvenance;
  const maxAgeHours = freshnessHoursFor(use);
  assertProvenance(provenance, Date.now(), maxAgeHours);
  if (process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID && process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID !== provenance.snapshotId) throw new Error('sanctions snapshot differs from runtime pin');
  const lists = await readLists(dir, provenance);
  assertProvenance(provenance, Date.now(), maxAgeHours);
  return { ...lists, provenance, maxAgeHours };
}
/** OFFLINE REGRESSION ONLY. No freshness claim; never use for issuance/rescreening. */
export async function loadHistoricalLists(root = 'data/raw') {
  return readLists(existsSync(join(root, 'current.json')) ? currentGeneration(root) : root);
}
