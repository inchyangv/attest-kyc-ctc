import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshSnapshot } from './snapshot-store.js';
import { SOURCES } from './provenance.js';

const exec = promisify(execFile);
const staging = mkdtempSync(join(tmpdir(), 'proofmark-fetch-'));
console.log(`download diagnostics retained at ${staging}`);
const provenance = await refreshSnapshot('data/raw', async id => {
  console.log(`fetching ${id}`);
  const file = join(staging, SOURCES[id].file), headers = `${file}.headers`;
  let stdout: string;
  try { ({ stdout } = await exec('curl', [
    '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '20', '--max-time', '180', '--max-filesize', String(128 * 1024 * 1024),
    '--retry', '3', '--retry-delay', '5', '--retry-max-time', '600', '--retry-all-errors',
    '--dump-header', headers, '--output', file, '--write-out', '%{json}', SOURCES[id].url,
  ], { maxBuffer: 1024 * 1024 })); }
  catch (error) {
    const e = error as { code?: number; stderr?: string };
    // Do not dump curl's complete response/connection metadata in job logs.
    throw new Error(`download failed for ${id} (curl ${e.code ?? 'unknown'}): ${(e.stderr ?? '').trim().slice(-400)}`);
  }
  const receipt = JSON.parse(stdout) as { http_code: number; url_effective: string; size_download: number };
  if (receipt.http_code !== 200) throw new Error(`full GET required for ${id}`);
  const bytes = readFileSync(file);
  if (receipt.size_download !== bytes.length) throw new Error(`download size mismatch ${id}`);
  const minimum = id === 'UN_CONSOLIDATED' ? 100_000 : 1_000_000;
  if (bytes.length < minimum) throw new Error(`download unexpectedly small for ${id}; operator review required`);
  const finalHeaders = readFileSync(headers, 'utf8').trim().split(/\r?\n\r?\n/).at(-1) ?? '';
  return { bytes, fetchedAt: new Date().toISOString(), effectiveUrl: receipt.url_effective,
    httpLastModified: finalHeaders.match(/^last-modified:\s*(.+)$/im)?.[1].trim() ?? null };
});
console.log(`activated CLI snapshot ${provenance.snapshotId}`);
console.log('Web is NOT switched by this command. Build/copy the verified v3 index and verify each runtime snapshot ID before rescreening.');
