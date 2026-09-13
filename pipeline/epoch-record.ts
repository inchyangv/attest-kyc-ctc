import { mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeVaultEnvelope } from './vault-atomic.js';

const observationFields = ['cc3AcceptedAt', 'propagationSeconds', 'propagationMethod',
  'checks', 'offChainChecks', 'registryProofMode', 'checkedAt', 'hubObservation', 'policyObservation', 'runtimeObservation', 'hubCarry', 'sourcePublicationObservation'] as const;
const identityFields = ['epoch', 'root', 'listVersion', 'validUntil', 'sourceCutoff', 'publishedAt',
  'snapshotId', 'rosterFormatVersion', 'epochSchemaVersion', 'rosterAuthVersion',
  'publishEpochTx', 'sepoliaBlock', 'sourceSnapshot', 'proofAvailability'] as const;

/** Carry only source facts into a new observation. Old hub measurements/verdicts do not become
 * results of this invocation merely because they shared the same epoch filename.
 */
export function sourceEpochRecord<T extends object>(record: T): T {
  const result = { ...record };
  for (const field of observationFields) delete (result as Record<string, unknown>)[field];
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Replace the complete derived record, never merge previous observations. Source identity
 * conflicts/corrupt existing evidence fail closed. This is not a transaction journal or a
 * distributed writer lease; the caller supplies already-verified source facts.
 */
export function writeEpochRecord(path: string, record: object): void {
  if (!path.endsWith('.json')) throw new Error('EPOCH_RECORD_PATH_INVALID');
  let previous: Record<string, unknown> | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('invalid existing record');
    previous = JSON.parse(readFileSync(path, 'utf8'));
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('invalid existing record');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('EPOCH_RECORD_UNAVAILABLE');
  }
  const next = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('EPOCH_RECORD_TOO_LARGE');
  if (previous) for (const field of identityFields) {
    if (previous[field] !== undefined && canonical(previous[field]) !== canonical(next[field])) throw new Error('EPOCH_RECORD_IDENTITY_CHANGED');
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Invalidate a prior submission snippet before publishing new source-only/partial results.
    // Two files cannot be replaced atomically: a failed write can leave this conservative marker
    // with the older JSON, but must not leave old PASS prose beside new unverified evidence.
    writeVaultEnvelope(path.replace(/\.json$/, '.md'), '# Epoch verification not established by this record write\n\n'
      + 'This invocation has not produced a submission-ready verification snippet. Source confirmation, '
      + 'hub propagation and current policy checks are separate evidence. Inspect the JSON and run '
      + 'the required current checks; do not reuse an older PASS snippet.\n');
    writeVaultEnvelope(path, serialized);
  } catch { throw new Error('EPOCH_RECORD_WRITE_UNCONFIRMED'); }
}
