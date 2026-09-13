import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import {
  exportRosterBundle,
  MAX_BUNDLE_BYTES,
  type RosterBundle,
  type RosterScope,
} from './roster-bundle.js';

type RosterRecord = Omit<RosterBundle, 'bundleVersion' | 'scope'>;
export type PrepublicationRosterRecord = Omit<RosterRecord, 'publishedAt'> & { publishedAt?: number };

interface RosterBundleSeed {
  seedVersion: 1;
  rosterFormatVersion: 2;
  epochSchemaVersion: 2;
  rosterAuthVersion: 1;
  scope: RosterScope;
  epoch: number;
  root: string;
  listVersion: number;
  sourceCutoff: number;
  validUntil: number;
  snapshotId: string;
  approvedIssuers: string[];
  entries: RosterBundle['entries'];
}

export interface StagedRosterBundleReplicas {
  version: 1;
  seedHash: string;
  seedFiles: string[];
  replicaDirectories: string[];
  replicaCount: number;
}

export interface FinalizedRosterBundleReplicas {
  version: 1;
  seedHash: string;
  contentHash: string;
  files: string[];
  replicaCount: number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const seedKeys = [
  'seedVersion', 'rosterFormatVersion', 'epochSchemaVersion', 'rosterAuthVersion', 'scope',
  'epoch', 'root', 'listVersion', 'sourceCutoff', 'validUntil', 'snapshotId',
  'approvedIssuers', 'entries',
].sort();

function seedBytes(record: PrepublicationRosterRecord, scope: RosterScope): Buffer {
  // publishedAt is source-block derived and unknowable before broadcast. Reuse the bundle's full
  // validation/canonicalization with the earliest permitted value, then omit only that field.
  const normalized = JSON.parse(exportRosterBundle({ ...record, publishedAt: record.sourceCutoff }, scope).bytes.toString('utf8')) as RosterBundle;
  const { bundleVersion: _bundleVersion, publishedAt: _publishedAt, ...rest } = normalized;
  const seed: RosterBundleSeed = { seedVersion: 1, ...rest };
  return Buffer.from(`${JSON.stringify(seed)}\n`);
}

function loadSeed(bytes: Uint8Array, expectedHash: string): RosterBundleSeed {
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || bytes.length === 0 || bytes.length > MAX_BUNDLE_BYTES || sha256(bytes) !== expectedHash) {
    throw new Error('roster replica seed size/content pin mismatch');
  }
  let parsed: RosterBundleSeed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as RosterBundleSeed; }
  catch { throw new Error('invalid roster replica seed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.seedVersion !== 1 ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(seedKeys)) throw new Error('invalid roster replica seed');
  const canonical = seedBytes(parsed, parsed.scope);
  if (!Buffer.from(bytes).equals(canonical)) throw new Error('noncanonical roster replica seed');
  return parsed;
}

function replicaDirectories(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 2) throw new Error('at least two distinct replica directories are required');
  const directories = paths.map(path => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new Error('invalid roster replica directory');
    const directory = resolve(path);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('roster replica destination must be a real directory');
    return fs.realpathSync(directory);
  });
  if (new Set(directories).size !== directories.length) throw new Error('at least two distinct replica directories are required');
  return directories;
}

/** Create a durable, content-addressed file without replacing a pre-existing path. Existing exact
 * bytes make retries idempotent, but broad permissions or non-regular files fail closed. */
function writeImmutable(path: string, bytes: Uint8Array): void {
  const verifyExisting = () => {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size !== bytes.length ||
        !fs.readFileSync(path).equals(bytes)) throw new Error('immutable roster replica path conflict');
  };
  try { verifyExisting(); return; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file: number | undefined, directory: number | undefined;
  try {
    file = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(file, bytes); fs.fsyncSync(file); fs.closeSync(file); file = undefined;
    try { fs.linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyExisting();
    }
    fs.unlinkSync(temporary);
    directory = fs.openSync(dirname(path), 'r');
    fs.fsyncSync(directory); fs.closeSync(directory); directory = undefined;
    verifyExisting();
  } catch (error) {
    throw new Error(`roster replica write unconfirmed: ${(error as Error).message}`);
  } finally {
    if (file !== undefined) { try { fs.closeSync(file); } catch {} }
    if (directory !== undefined) { try { fs.closeSync(directory); } catch {} }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

/** Prepublication fence: complete leaves and provenance must be recoverable in every explicitly
 * configured destination before a caller is allowed to create/sign a publication intent. */
export function stageRosterBundleReplicas(record: PrepublicationRosterRecord, scope: RosterScope, paths: string[]): StagedRosterBundleReplicas {
  const directories = replicaDirectories(paths);
  const bytes = seedBytes(record, scope), seedHash = sha256(bytes);
  const files = directories.map(directory => join(directory, `${seedHash}.seed.json`));
  for (const file of files) writeImmutable(file, bytes);
  // Re-open every copy only after all writes; success is the publication-ready boundary.
  for (const file of files) {
    try { loadSeed(fs.readFileSync(file), seedHash); }
    catch { throw new Error('replica seed unavailable after staging'); }
  }
  return { version: 1, seedHash, seedFiles: files, replicaDirectories: directories, replicaCount: files.length };
}

/** Finalize exact bundle bytes once the source receipt supplies publishedAt. This reads and pins
 * every prepublication copy before writing any final bundle, so drift cannot be reported ready. */
export function finalizeRosterBundleReplicas(staged: StagedRosterBundleReplicas, publishedAt: number): FinalizedRosterBundleReplicas {
  if (!staged || staged.version !== 1 || staged.replicaCount < 2 || staged.seedFiles.length !== staged.replicaCount ||
      staged.replicaDirectories.length !== staged.replicaCount || !/^[0-9a-f]{64}$/.test(staged.seedHash)) {
    throw new Error('invalid staged roster replicas');
  }
  let seeds: RosterBundleSeed[];
  try { seeds = staged.seedFiles.map(file => loadSeed(fs.readFileSync(file), staged.seedHash)); }
  catch { throw new Error('replica seed unavailable or changed; publication availability is unconfirmed'); }
  const canonical = JSON.stringify(seeds[0]);
  if (seeds.some(seed => JSON.stringify(seed) !== canonical)) throw new Error('replica seed unavailable or changed; publication availability is unconfirmed');
  const { seedVersion: _seedVersion, scope, ...record } = seeds[0];
  const bundle = exportRosterBundle({ ...record, publishedAt }, scope);
  const files = staged.replicaDirectories.map(directory => join(directory, `${bundle.contentHash}.json`));
  for (const file of files) writeImmutable(file, bundle.bytes);
  return { version: 1, seedHash: staged.seedHash, contentHash: bundle.contentHash, files, replicaCount: files.length };
}

/** Offline recovery primitive for a surviving seed replica; no publisher key, origin record or RPC
 * is required once an independently observed source receipt timestamp is supplied. */
export function recoverRosterBundleFromSeed(bytes: Uint8Array, expectedSeedHash: string, publishedAt: number) {
  const { seedVersion: _seedVersion, scope, ...record } = loadSeed(bytes, expectedSeedHash);
  return exportRosterBundle({ ...record, publishedAt }, scope);
}
