import { createHash } from 'node:crypto';
import type { ListId } from './types.js';

export const LIST_IDS: readonly ListId[] = ['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_FSF'];
export const PARSER_VERSION = 'proofmark-lists-2';
export const MAX_AGE_HOURS = 168; // Operational ceiling, not a regulatory approval.
export type SanctionsUse = 'screen' | 'issuance' | 'rescreen' | 'epoch';
const USE_MAX_AGE_ENV: Record<SanctionsUse, string> = {
  screen: 'SANCTIONS_SCREEN_MAX_AGE_HOURS',
  issuance: 'SANCTIONS_ISSUANCE_MAX_AGE_HOURS',
  rescreen: 'SANCTIONS_RESCREEN_MAX_AGE_HOURS',
  epoch: 'SANCTIONS_EPOCH_MAX_AGE_HOURS',
};
export const SOURCES = {
  OFAC_SDN: { file: 'ofac_sdn.xml', url: 'https://www.treasury.gov/ofac/downloads/sdn.xml', root: 'sdnList' },
  UN_CONSOLIDATED: { file: 'un_consolidated.xml', url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml', root: 'CONSOLIDATED_LIST' },
  EU_FSF: { file: 'eu_fsf.xml', url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw', root: 'export' },
} as const;

export interface SourceEvidence {
  sourceUrl: string;
  /** HTTPS origin/path only; transport query/fragment/userinfo must never be published. */
  effectiveUrl: string;
  effectiveUrlSha256: string;
  fetchedAt: string;
  checkedAt: string;
  /** Unknown is explicit. HTTP Last-Modified and local mtime are NOT publication dates. */
  publishedAt: null;
  httpLastModified: string | null;
  sha256: string;
  bytes: number;
  entryCount: number;
}
export interface ListProvenance {
  v: 2;
  parserVersion: string;
  createdAt: string;
  sources: Record<ListId, SourceEvidence>;
  snapshotId: string;
}

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function publicEffectiveUrl(value: string): string {
  try {
    if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error();
    return url.origin + url.pathname;
  } catch { throw new Error('invalid sanctions transport URL'); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function snapshotId(value: Omit<ListProvenance, 'snapshotId'>): string { return sha256(JSON.stringify(canonical(value))); }
function timestamp(value: unknown): number {
  if (typeof value !== 'string') throw new Error('sanctions timestamp missing');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('sanctions timestamp must be a canonical UTC instant');
  return ms;
}
export function freshnessHours(value = process.env.SANCTIONS_MAX_AGE_HOURS ?? String(MAX_AGE_HOURS)): number {
  const hours = Number(value);
  if (!value.trim() || !Number.isFinite(hours) || hours <= 0 || hours > MAX_AGE_HOURS) throw new Error(`SANCTIONS_MAX_AGE_HOURS must be > 0 and <= ${MAX_AGE_HOURS}`);
  return hours;
}
/** Purpose-specific policy with the shared ceiling as a backwards-compatible fallback.
 * Runtime deployments must set and pin all four values from one reviewed release plan. */
export function freshnessHoursFor(use: SanctionsUse, env: NodeJS.ProcessEnv = process.env): number {
  const specific = env[USE_MAX_AGE_ENV[use]];
  return freshnessHours(specific === undefined ? env.SANCTIONS_MAX_AGE_HOURS ?? String(MAX_AGE_HOURS) : specific);
}
/** One fail-closed rule for raw CLI, baked web index and every screen on a held engine. */
export function assertProvenance(value: ListProvenance, now = Date.now(), maxAgeHours = freshnessHours()): void {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > MAX_AGE_HOURS) throw new Error('invalid sanctions freshness policy');
  if (!value || value.v !== 2 || value.parserVersion !== PARSER_VERSION || !value.sources ||
    Object.keys(value.sources).sort().join() !== [...LIST_IDS].sort().join()) throw new Error('unsupported or incomplete sanctions provenance');
  const { snapshotId: id, ...body } = value;
  if (id !== snapshotId(body)) throw new Error('sanctions manifest hash mismatch');
  const created = timestamp(value.createdAt);
  if (created > now) throw new Error('sanctions snapshot is from the future');
  for (const list of LIST_IDS) {
    const s = value.sources[list];
    if (!s || s.sourceUrl !== SOURCES[list].url || typeof s.effectiveUrl !== 'string' || publicEffectiveUrl(s.effectiveUrl) !== s.effectiveUrl ||
      typeof s.effectiveUrlSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.effectiveUrlSha256) ||
      !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.bytes) || s.bytes <= 0 ||
      !Number.isSafeInteger(s.entryCount) || s.entryCount <= 0 || s.publishedAt !== null ||
      !(s.httpLastModified === null || typeof s.httpLastModified === 'string')) throw new Error(`invalid sanctions source ${list}`);
    const fetched = timestamp(s.fetchedAt), checked = timestamp(s.checkedAt);
    // Current fetcher performs full GET only. A bare 304 or file touch cannot refresh age.
    if (fetched !== checked || checked > created || checked > now) throw new Error(`invalid sanctions chronology ${list}`);
    if (now - checked > maxAgeHours * 3_600_000) throw new Error(`sanctions source is stale: ${list}`);
  }
}
export function listVersionsOf(p: ListProvenance): Record<string, number> {
  return Object.fromEntries(LIST_IDS.map(id => [id, parseInt(p.sources[id].sha256.slice(0, 8), 16)]));
}
