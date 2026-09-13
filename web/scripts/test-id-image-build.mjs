// A clean temporary deployment tree: never copies .env files, never calls a real vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Wallet, keccak256 } from 'ethers';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(web, '..');
const traces = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? traces(path) : entry.name.endsWith('.nft.json') ? [path] : [];
});

test('traced native worker and built wallet→ID HTTP route run in an env-free deployment copy', { timeout: 30_000 }, async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'proofmark-id-build-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const closed = new Promise(r => app.once('close', r)); app.kill('SIGKILL'); await closed;
    }
    rmSync(temporary, { recursive: true, force: true });
  });
  const appDir = join(temporary, 'web'); mkdirSync(appDir);
  const idTrace = join(web, '.next/server/app/api/kyc/id/route.js.nft.json');
  const idFiles = JSON.parse(readFileSync(idTrace, 'utf8')).files;
  assert.ok(idFiles.some(f => f.endsWith('/scripts/validate-id-image.mjs')));
  assert.ok(idFiles.some(f => f.endsWith('/lib/id-image-policy.json')));
  assert.ok(idFiles.some(f => /@img\/sharp-.*\.node$/.test(f)));
  const copyTrace = trace => {
    for (const item of JSON.parse(readFileSync(trace, 'utf8')).files) {
      const source = resolve(dirname(trace), item); const rel = relative(repo, source);
      assert.ok(!rel.startsWith('..') && !rel.split(sep).some(p => p.startsWith('.env')), 'trace must not copy secrets or escape repository');
      assert.ok(!relative(realpathSync(repo), realpathSync(source)).startsWith('..'), 'symlinks must stay inside repository');
      const destination = join(temporary, rel); mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  };
  // Check the native worker using ONLY the ID route's trace before copying Next runtime traces.
  copyTrace(idTrace);
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'white' } }).png().toBuffer();
  const decoded = spawnSync(process.execPath, [join(appDir, 'scripts/validate-id-image.mjs')], {
    cwd: appDir, input: png, env: {}, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.deepEqual(JSON.parse(decoded.stdout), { format: 'png', width: 40, height: 30 });
  for (const trace of traces(join(web, '.next/server'))) copyTrace(trace);
  copyTrace(join(web, '.next/next-server.js.nft.json'));
  cpSync(join(web, '.next'), join(appDir, '.next'), { recursive: true,
    filter: source => !['cache', 'diagnostics', 'types'].includes(relative(join(web, '.next'), source).split(sep)[0]) });
  assert.equal(existsSync(join(appDir, '.env.local')), false);
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  app = spawn(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: appDir, stdio: 'ignore', env: { NODE_ENV: 'production', KYC_DEMO: '1', KYC_DEMO_BITS: '1',
      EVIDENCE_HMAC_KEY: 'synthetic-build-http-only-at-least-32-chars',
      SERVER_TOKEN_KEY: 'synthetic-build-server-token-key-at-least-32-chars', SERVER_TOKEN_KEY_ID: 'build-token-k1' },
  });
  // NextURL canonicalizes loopback IPs to localhost; browser Origin must match that URL.
  const base = `http://localhost:${port}`;
  const local = (path, options) => fetch(base + path, { ...options, signal: AbortSignal.timeout(5000), redirect: 'error' });
  for (let i = 0; ; i++) {
    try { const response = await local('/api/kyc/wallet'); if (response.status === 400) break; throw new Error('not ready'); }
    catch { if (app.exitCode !== null || app.signalCode !== null || i > 100) throw new Error('isolated built Next server failed to start'); await delay(100); }
  }
  const wallet = Wallet.createRandom();
  const challengeResponse = await local(`/api/kyc/wallet?address=${wallet.address}`);
  assert.equal(challengeResponse.headers.get('cache-control'), 'no-store');
  const challenge = await challengeResponse.json();
  const signed = await local('/api/kyc/wallet', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ token: challenge.token, signature: await wallet.signMessage(challenge.message) }) });
  const signedBody = await signed.json();
  assert.equal(signed.headers.get('cache-control'), 'no-store');
  assert.equal(signed.status, 200, JSON.stringify({ error: signedBody.error, domain: challenge.message.split('\n')[0], uri: challenge.message.split('\n').find(line => line.startsWith('URI:')) }));
  const { walletProof } = signedBody;
  const form = new FormData(); form.set('walletProof', walletProof); form.set('action', 'ocr'); form.set('docType', 'RRC');
  form.set('image', new File([png], 'synthetic.png', { type: 'image/png' }));
  const result = await local('/api/kyc/id', { method: 'POST', headers: { origin: base }, body: form });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.status, 200); assert.equal((await result.json()).docHash, keccak256(png));
  form.set('image', new File([Buffer.from('<svg/>')], 'synthetic.png', { type: 'image/png' }));
  const rejected = await local('/api/kyc/id', { method: 'POST', headers: { origin: base }, body: form });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
});
