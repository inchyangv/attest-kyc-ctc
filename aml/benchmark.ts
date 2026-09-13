/** Read-only local cost observation. Not an SLA, load test or independent match evaluation. */
import { performance } from 'node:perf_hooks';
import { loadHistoricalLists as loadLists } from './loader.js';
import { ListBackedAmlEngine } from './engine.js';
import { ENGINE_VERSION } from './normalize.js';
import { DEFAULT_MATCH_LIMITS } from './match.js';

const { entries, listVersions } = await loadLists();
const rssBefore = process.memoryUsage().rss;
const start = performance.now();
const engine = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'synthetic-benchmark-key' });
const buildMs = performance.now() - start;
const candidates = entries.filter(e => e.type === 'individual' && e.dobs.length && e.countries.length && e.primaryName.length >= 10).slice(0, 200);
if (candidates.length !== 200) throw new Error('benchmark requires 200 eligible entries');
const times: number[] = []; let maximumHits = 0;
const queryStart = performance.now();
for (const entry of candidates) {
  const begin = performance.now();
  const result = await engine.screen({ fullName: entry.primaryName, dateOfBirth: entry.dobs[0], nationality: entry.countries[0],
    residence: entry.countries[0], walletAddress: '0x' + '12'.repeat(20) });
  times.push(performance.now() - begin); maximumHits = Math.max(maximumHits, result.hits.length);
}
times.sort((a, b) => a - b);
const queryMs = performance.now() - queryStart;
const rssAfter = process.memoryUsage().rss;
console.log(JSON.stringify({ engine: ENGINE_VERSION, node: process.version, entries: entries.length, listVersions,
  queryCount: times.length, buildMs, queryMs, queriesPerSecond: times.length / (queryMs / 1000),
  p50Ms: times[99], p95Ms: times[189], maxMs: times.at(-1), maximumHits,
  rssBeforeMiB: rssBefore / 1024 / 1024, rssAfterMiB: rssAfter / 1024 / 1024, rssDeltaMiB: (rssAfter - rssBefore) / 1024 / 1024,
  failClosedMatchLimits: DEFAULT_MATCH_LIMITS,
  scope: 'single local process, ordered in-list names, no concurrent HTTP requests, no independent holdout; RSS includes XML parsing/runtime' }, null, 2));
