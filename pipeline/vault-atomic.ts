import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export class VaultWriteError extends Error { constructor() { super('VAULT_WRITE_UNCONFIRMED'); this.name = 'VaultWriteError'; } }

/** Success only after file fsync, atomic rename and parent-directory fsync. No rollback after rename. */
export function writeVaultEnvelope(path: string, envelope: string): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file: number | undefined, directory: number | undefined;
  try {
    file = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(file, envelope); fs.fsyncSync(file); fs.closeSync(file); file = undefined;
    fs.renameSync(tmp, path);
    directory = fs.openSync(dirname(path), 'r'); fs.fsyncSync(directory); fs.closeSync(directory); directory = undefined;
  } catch {
    throw new VaultWriteError();
  } finally {
    if (file !== undefined) { try { fs.closeSync(file); } catch {} }
    if (directory !== undefined) { try { fs.closeSync(directory); } catch {} }
    // Only this invocation's temporary path, never the authoritative file. Failed cleanup may
    // leave an encrypted orphan for authorized recovery; it must not mask the original error.
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

/** Creates a new private durable file without replacing an existing recovery artifact. */
export function writeVaultEnvelopeExclusive(path: string, envelope: string): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file: number | undefined, directory: number | undefined;
  try {
    file = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(file, envelope); fs.fsyncSync(file); fs.closeSync(file); file = undefined;
    fs.linkSync(tmp, path);
    fs.unlinkSync(tmp);
    directory = fs.openSync(dirname(path), 'r'); fs.fsyncSync(directory); fs.closeSync(directory); directory = undefined;
  } catch {
    throw new VaultWriteError();
  } finally {
    if (file !== undefined) { try { fs.closeSync(file); } catch {} }
    if (directory !== undefined) { try { fs.closeSync(directory); } catch {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}
