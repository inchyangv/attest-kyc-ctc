import { assertProvenance, freshnessHoursFor, type ListProvenance } from '../aml/provenance.js';

export const EPOCH_SCHEMA_VERSION = 2;
export const MAX_EPOCH_AGE_SECONDS = 86_400;
export const MAX_PUBLICATION_LAG_SECONDS = 3_600;
export const EPOCH_SOURCE_ABI = [
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)',
  'function MAX_EPOCH_AGE() view returns (uint256)',
  'function publishEpoch(uint32 epoch,bytes32 root,uint32 listVersion,uint40 validUntil,uint40 sourceCutoff,bytes32 snapshotId)',
  'event RosterEpochPublished(uint32 indexed epoch,bytes32 indexed root,uint32 indexed listVersion,uint40 validUntil,uint40 sourceCutoff,uint40 publishedAt,bytes32 snapshotId)',
] as const;

export async function requireEpochV2(...readVersions: (() => Promise<unknown>)[]): Promise<void> {
  if (!readVersions.length) throw new Error('epoch compatibility requires a target');
  for (const read of readVersions) {
    let value: unknown;
    try { value = await read(); } catch { throw new Error('epoch schema v2 unavailable; migrate source/ASC/Registry together'); }
    if (Number(value) !== EPOCH_SCHEMA_VERSION) throw new Error('unsupported epoch schema; migrate source/ASC/Registry together');
  }
}

/** Source cutoff is the timestamp of the scanned source block, never the hub arrival time.
 * Binding the manifest is a publisher assertion, not proof every subject was re-screened. */
export function boundedEpochParams(sourceCutoff: number, provenance: ListProvenance, now = Date.now(), hours = '24') {
  assertProvenance(provenance, now, Math.min(24, freshnessHoursFor('epoch')));
  const at = Math.floor(now / 1000), duration = Number(hours) * 3600;
  if (!Number.isSafeInteger(sourceCutoff) || sourceCutoff <= 0 || sourceCutoff > at || at - sourceCutoff > MAX_PUBLICATION_LAG_SECONDS)
    throw new Error('epoch source cutoff is future, missing or too old');
  if (!hours.trim() || !Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_EPOCH_AGE_SECONDS)
    throw new Error('EPOCH_VALID_HOURS must yield a positive whole-second duration <=24 hours');
  const oldestListCheck = Math.floor(Math.min(...Object.values(provenance.sources)
    .map(source => Date.parse(source.checkedAt))) / 1000);
  // Source and list freshness are independent clocks. A recently scanned source block must not
  // repackage an almost-stale sanctions snapshot into another full-day assertion.
  const validUntil = Math.min(sourceCutoff + duration, oldestListCheck + MAX_EPOCH_AGE_SECONDS);
  if (validUntil <= at || validUntil >= 2 ** 40) throw new Error('epoch validity is already expired or outside uint40');
  return { sourceCutoff, snapshotId: `0x${provenance.snapshotId}`, listVersion: parseInt(provenance.snapshotId.slice(0, 8), 16),
    validUntil, validDays: (validUntil - sourceCutoff) / 86_400 };
}
