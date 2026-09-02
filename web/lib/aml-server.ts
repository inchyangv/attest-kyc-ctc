/**
 * Server-only AML engine. Reads the baked index (1.1 MB gzip) once and keeps it in the module cache.
 * The 57 MB source XML is never parsed per request.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ListBackedAmlEngine } from '@aml/engine.js';
import type { SanctionEntry } from '@aml/ingest/parse.js';
import type { ListId } from '@aml/types.js';

const LIST_IDS: ListId[] = ['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_FSF'];

interface Slim {
  v: number;
  builtAt: string;
  sourceUpdatedAt: Record<string, string>;
  listVersions: Record<string, number>;
  counts: Record<string, number>;
  entries: { l: number; i: string; p: string; n: string[]; d: string[]; c: string[]; w: string[]; t: number }[];
}

let cached: { engine: ListBackedAmlEngine; meta: Omit<Slim, 'entries'> } | null = null;

function assertFresh(meta: Omit<Slim, 'entries'>): void {
  if (meta.v < 2 || !meta.builtAt || Object.keys(meta.sourceUpdatedAt ?? {}).length !== LIST_IDS.length) {
    throw new Error('sanctions index has no provenance timestamps; rebuild it');
  }
  const maxAgeHours = Number(process.env.SANCTIONS_MAX_AGE_HOURS ?? '168');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('SANCTIONS_MAX_AGE_HOURS must be positive');
  const oldest = Math.min(...Object.values(meta.sourceUpdatedAt).map((value) => Date.parse(value)));
  const ageHours = (Date.now() - oldest) / 3_600_000;
  if (!Number.isFinite(oldest) || ageHours > maxAgeHours) {
    throw new Error(`sanctions index is stale (${ageHours.toFixed(1)}h; maximum ${maxAgeHours}h)`);
  }
}

export function getEngine() {
  if (cached) { assertFresh(cached.meta); return cached; }
  const raw = gunzipSync(readFileSync(join(process.cwd(), 'data', 'sanctions-index.json.gz'))).toString('utf8');
  const slim = JSON.parse(raw) as Slim;
  assertFresh(slim);
  const entries: SanctionEntry[] = slim.entries.map(e => ({
    listId: LIST_IDS[e.l], entryId: e.i, primaryName: e.p, names: e.n,
    dobs: e.d, countries: e.c, programs: [], cryptoAddresses: e.w,
    type: e.t === 0 ? 'individual' : e.t === 1 ? 'entity' : 'unknown',
  }));
  const key = process.env.EVIDENCE_HMAC_KEY;
  if (!key || key.length < 32) {
    throw new Error('EVIDENCE_HMAC_KEY is required (32+ chars). Generate one with: openssl rand -hex 32');
  }
  cached = {
    engine: new ListBackedAmlEngine({ entries, listVersions: slim.listVersions, evidenceKey: key, keyId: 'web-k1' }),
    meta: {
      v: slim.v,
      builtAt: slim.builtAt,
      sourceUpdatedAt: slim.sourceUpdatedAt,
      listVersions: slim.listVersions,
      counts: slim.counts,
    },
  };
  return cached;
}
