import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentGeneration, parseListBytes } from './loader.js';
import { buildIndex } from './index-format.js';
import { LIST_IDS, PARSER_VERSION, SOURCES, assertProvenance, publicEffectiveUrl, sha256, snapshotId, type ListProvenance, type SourceEvidence } from './provenance.js';
import type { ListId } from './types.js';
import type { SanctionEntry } from './ingest/parse.js';

export function atomicFile(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`, fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export interface DownloadedList { bytes: Buffer; fetchedAt: string; effectiveUrl: string; httpLastModified: string | null }
export type ListDownloader = (id: ListId) => Promise<DownloadedList>;
/** Local single-writer activation. Failed candidates and previous generations are retained.
 * Publication time is unknown; freshness proves a successful full GET, not publisher correctness. */
export async function refreshSnapshot(root: string, download: ListDownloader, now = () => Date.now()): Promise<ListProvenance> {
  mkdirSync(root, { recursive: true });
  const lease = openSync(join(root, '.refresh.lock'), 'wx', 0o600);
  try {
    writeFileSync(lease, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() })); fsyncSync(lease);
    const generation = randomUUID(), dir = join(root, 'generations', generation);
    mkdirSync(dir, { recursive: true });
    const sources = {} as Record<ListId, SourceEvidence>, entries: SanctionEntry[] = [];
    const previous: ListProvenance | undefined = existsSync(join(root, 'current.json'))
      ? JSON.parse(readFileSync(join(currentGeneration(root), 'manifest.json'), 'utf8')) : undefined;
    for (const id of LIST_IDS) {
      const d = await download(id);
      if (d.bytes.length > 128 * 1024 * 1024) throw new Error(`sanctions download too large ${id}`);
      const parsed = await parseListBytes(d.bytes, id);
      // Gross-loss circuit breaker; not a proof of feed completeness. No automatic override.
      if (previous && parsed.length < previous.sources[id].entryCount * 0.8) throw new Error(`sanctions count dropped >20%; operator review required for ${id}`);
      sources[id] = { sourceUrl: SOURCES[id].url, effectiveUrl: publicEffectiveUrl(d.effectiveUrl), effectiveUrlSha256: sha256(d.effectiveUrl), fetchedAt: d.fetchedAt, checkedAt: d.fetchedAt,
        publishedAt: null, httpLastModified: d.httpLastModified, sha256: sha256(d.bytes), bytes: d.bytes.length, entryCount: parsed.length };
      atomicFile(join(dir, SOURCES[id].file), d.bytes);
      entries.push(...parsed);
    }
    const body = { v: 2 as const, parserVersion: PARSER_VERSION, createdAt: new Date(now()).toISOString(), sources };
    const provenance: ListProvenance = { ...body, snapshotId: snapshotId(body) };
    assertProvenance(provenance, now());
    atomicFile(join(dir, 'sanctions-index.json.gz'), buildIndex(entries, provenance, now()));
    atomicFile(join(dir, 'manifest.json'), JSON.stringify(provenance));
    const generations = openSync(join(root, 'generations'), 'r');
    try { fsyncSync(generations); } finally { closeSync(generations); }
    // One pointer, after ALL files and index validate. No flat-file three-move window.
    atomicFile(join(root, 'current.json'), JSON.stringify({ generation }));
    return provenance;
  } finally { closeSync(lease); unlinkSync(join(root, '.refresh.lock')); }
}
