/** T-25's separately routed synthetic matrix. It exercises the evaluator and declared matching
 * boundaries; it is deliberately not described as an independent or production holdout. */
import { pathToFileURL } from 'node:url';
import { ListBackedAmlEngine } from './engine.js';
import type { SanctionEntry } from './ingest/parse.js';
import { ENGINE_VERSION } from './normalize.js';

type Expected = 'ESCALATE' | 'ALLOW';
type Scope = 'supported' | 'exact-only-boundary' | 'unmodeled';
interface MatrixCase {
  id: string;
  category: string;
  language: string;
  scope: Scope;
  listed: string;
  supplied: string;
  expected: Expected;
  aliases?: string[];
}

const repeated = (length: number, last = 'x') => 'x'.repeat(length - 1) + last;
export const T25_SYNTHETIC_MATRIX: readonly MatrixCase[] = [
  { id: 'substitution-1', category: 'single-edit', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Viktor Sampleton', expected: 'ESCALATE' },
  { id: 'insertion-1', category: 'single-edit', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Victorr Sampleton', expected: 'ESCALATE' },
  { id: 'deletion-1', category: 'single-edit', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Vctor Sampleton', expected: 'ESCALATE' },
  { id: 'transpose-1', category: 'single-edit', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Vicotr Sampleton', expected: 'ESCALATE' },
  { id: 'substitution-2', category: 'two-edit-token', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Wiktor Sampleton', expected: 'ESCALATE' },
  { id: 'two-changed-tokens', category: 'two-tokens', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Viktor Sampelton', expected: 'ESCALATE' },
  { id: 'missing-part', category: 'missing-token', language: 'Latin', scope: 'supported', listed: 'Victor Alexander Sampleton', supplied: 'Victor Sampleton', expected: 'ESCALATE' },
  { id: 'alias', category: 'alias', language: 'Latin', scope: 'supported', listed: 'Unrelated Primary', aliases: ['Victor Sampleton'], supplied: 'Viktor Sampleton', expected: 'ESCALATE' },
  { id: 'cyrillic', category: 'single-edit', language: 'Cyrillic', scope: 'supported', listed: 'Александр Петрович', supplied: 'Александп Петрович', expected: 'ESCALATE' },
  { id: 'arabic', category: 'single-edit', language: 'Arabic', scope: 'supported', listed: 'عبدالرحمن منصوري', supplied: 'عبدالرحمن منصورب', expected: 'ESCALATE' },
  { id: 'hangul-long', category: 'single-edit', language: 'Hangul', scope: 'supported', listed: '가나다라마 바사아자차', supplied: '가나다라마 바사아자카', expected: 'ESCALATE' },
  { id: 'long-64', category: 'length-boundary', language: 'Latin', scope: 'supported', listed: `Victor ${repeated(64, 'b')}`, supplied: `Victor ${repeated(64, 'c')}`, expected: 'ESCALATE' },
  { id: 'unrelated', category: 'clean-negative', language: 'Latin', scope: 'supported', listed: 'Victor Sampleton', supplied: 'Zorvax Quenlith', expected: 'ALLOW' },
  { id: 'one-part-only', category: 'clean-negative', language: 'Latin', scope: 'supported', listed: 'Victor Alexander Sampleton', supplied: 'Sampleton', expected: 'ALLOW' },
  { id: 'short-exact', category: 'length-boundary', language: 'Latin', scope: 'exact-only-boundary', listed: 'Li Na', supplied: 'Li Na', expected: 'ESCALATE' },
  { id: 'short-edit', category: 'length-boundary', language: 'Latin', scope: 'exact-only-boundary', listed: 'Li Na', supplied: 'Lu Na', expected: 'ALLOW' },
  { id: 'over-64-exact', category: 'length-boundary', language: 'Latin', scope: 'exact-only-boundary', listed: `Victor ${repeated(65)}`, supplied: `Victor ${repeated(65)}`, expected: 'ESCALATE' },
  { id: 'over-64-edit', category: 'length-boundary', language: 'Latin', scope: 'exact-only-boundary', listed: `Victor ${repeated(65, 'b')}`, supplied: `Victor ${repeated(65, 'c')}`, expected: 'ALLOW' },
  { id: 'phonetic-only', category: 'phonetic', language: 'Latin', scope: 'unmodeled', listed: 'Sean Sampleton', supplied: 'John Sampleton', expected: 'ALLOW' },
] as const;

export interface T25Evaluation {
  engineVersion: string;
  dataset: 'internal-synthetic-regression-not-independent-holdout';
  total: number;
  supportedEscalations: number;
  supportedMissed: number;
  supportedAllows: number;
  supportedFalseHolds: number;
  boundaryOrUnmodeled: number;
  byCategory: Record<string, { total: number; passed: number }>;
  byLanguage: Record<string, { total: number; passed: number }>;
}

const entry = (row: MatrixCase): SanctionEntry => ({ listId: 'OFAC_SDN', entryId: row.id, primaryName: row.listed,
  names: [row.listed, ...(row.aliases ?? [])], dobs: ['1980-02-29'], countries: ['KR'], programs: [], cryptoAddresses: [], type: 'individual' });

export async function evaluateT25Synthetic(): Promise<T25Evaluation> {
  const byCategory: T25Evaluation['byCategory'] = {}, byLanguage: T25Evaluation['byLanguage'] = {};
  let supportedEscalations = 0, supportedMissed = 0, supportedAllows = 0, supportedFalseHolds = 0, boundaryOrUnmodeled = 0;
  for (const row of T25_SYNTHETIC_MATRIX) {
    const engine = new ListBackedAmlEngine({ entries: [entry(row)], listVersions: { OFAC_SDN: 1 }, evidenceKey: 'synthetic-t25-evaluation-key' });
    const result = await engine.screen({ fullName: row.supplied, dateOfBirth: '1980-02-29', nationality: 'KR', residence: 'KR', walletAddress: '' });
    const actual: Expected = result.decision === 'ALLOW' ? 'ALLOW' : 'ESCALATE', passed = actual === row.expected;
    for (const [key, target] of [[row.category, byCategory], [row.language, byLanguage]] as const) {
      target[key] ??= { total: 0, passed: 0 }; target[key].total++; if (passed) target[key].passed++;
    }
    if (row.scope === 'supported') {
      if (row.expected === 'ESCALATE') { supportedEscalations++; if (!passed) supportedMissed++; }
      else { supportedAllows++; if (!passed) supportedFalseHolds++; }
    } else boundaryOrUnmodeled++;
  }
  return { engineVersion: ENGINE_VERSION, dataset: 'internal-synthetic-regression-not-independent-holdout', total: T25_SYNTHETIC_MATRIX.length,
    supportedEscalations, supportedMissed, supportedAllows, supportedFalseHolds, boundaryOrUnmodeled, byCategory, byLanguage };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await evaluateT25Synthetic();
  console.log(JSON.stringify(result, null, 2));
  if (result.supportedMissed || result.supportedFalseHolds || Object.values(result.byCategory).some(v => v.passed !== v.total)) process.exitCode = 1;
}
