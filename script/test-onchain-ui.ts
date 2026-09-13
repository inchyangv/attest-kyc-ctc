/** Local rendered-page smoke with synthetic API responses. No external RPC, wallet or vendor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readOnchainState } from '../pipeline/onchain-state.js';
import { StatusFixture } from '../test/fixtures/onchain-state.js';

test('rendered onchain page distinguishes witness, missing proof, legacy, unexplained verdict and failed refresh', async t => {
  let base = process.env.ONCHAIN_UI_BASE_URL?.replace(/\/$/, '');
  let app: ReturnType<typeof spawn> | undefined;
  if (base) {
    const url = new URL(base);
    assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname), 'the UI smoke requires a local server');
    assert.equal(url.pathname, '/');
    base = url.origin;
  } else {
    const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
    const web = fileURLToPath(new URL('../web/', import.meta.url));
    app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: web, stdio: 'ignore' });
    t.after(async () => { if (app?.exitCode === null) { app.kill('SIGTERM'); await new Promise(r => app!.once('exit', r)); } });
    base = `http://localhost:${port}`;
  }
  for (let n = 0; ; n++) {
    try { const r = await fetch(base + '/onchain'); if (r.ok) break; throw new Error('not ready'); }
    catch { if ((app && app.exitCode !== null) || n >= 100) throw new Error('local Next server did not become ready'); await delay(100); }
  }
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let f = new StatusFixture(); let state = await readOnchainState(f.provider(), f.config()); let failed = false;
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base + '/api/onchain')) return route.fulfill({ status: failed ? 503 : 200,
      contentType: 'application/json', body: JSON.stringify(failed ? { error: 'synthetic observation unavailable' } : state) });
    return route.request().url().startsWith(base) ? route.continue() : route.abort();
  });
  await page.goto(base + '/onchain');
  await page.getByRole('heading', { name: 'Wallet lookup', exact: true }).waitFor();
  const card = page.locator('[data-policy]').first();
  await card.waitFor(); assert.equal(await card.getAttribute('data-result'), 'PASS');
  assert.match(await card.innerText(), /Requirements met/);
  assert.match(await card.innerText(), /Complete/); assert.doesNotMatch(await card.innerText(), /Required/);
  const networkDetails = page.locator('summary').filter({ hasText: /^Network & technical details$/ });
  assert.equal(await networkDetails.locator('..').getAttribute('open'), null);
  assert.doesNotMatch(await page.locator('body').innerText(), /not a finality guarantee/);
  await networkDetails.click();
  assert.match(await page.locator('body').innerText(), /not a finality guarantee/);
  await networkDetails.click();
  const address = page.getByRole('textbox', { name: 'Wallet address', exact: true });
  await address.fill('invalid-address');
  await page.getByRole('button', { name: 'Look up wallet', exact: true }).click();
  assert.equal(await address.evaluate(input => (input as HTMLInputElement).validity.patternMismatch), true);
  assert.equal(new URL(page.url()).search, '');
  await address.fill(f.subject);
  await Promise.all([
    page.waitForURL(url => url.searchParams.get('subject') === f.subject),
    page.getByRole('button', { name: 'Look up wallet', exact: true }).click(),
  ]);
  await card.waitFor(); assert.equal(await card.getAttribute('data-result'), 'PASS');
  const refresh = async () => {
    await Promise.all([
      page.waitForResponse(response => response.url().startsWith(base + '/api/onchain')),
      page.getByRole('button', { name: 'Refresh observation', exact: true }).click(),
    ]);
    await card.waitFor();
  };
  f = new StatusFixture(); f.witnessEpoch = 0; f.verified = false; state = await readOnchainState(f.provider(), f.config());
  await refresh(); assert.equal(await card.getAttribute('data-result'), 'FAIL');
  assert.match(await card.innerText(), /An updated verification proof is needed/); assert.match(await card.innerText(), /Unknown/);
  f = new StatusFixture(); f.legacy = true; state = await readOnchainState(f.provider(), f.config());
  await refresh(); assert.equal(await card.getAttribute('data-result'), 'UNCONFIRMED');
  assert.match(await card.innerText(), /Unconfirmed/); assert.doesNotMatch(await card.innerText(), /Requirements met|CHAIN TRUE/);
  await card.locator('summary').filter({ hasText: /^Policy details$/ }).click();
  assert.match(await card.innerText(), /CHAIN TRUE/);
  f = new StatusFixture(); f.tombstone = true; state = await readOnchainState(f.provider(), f.config());
  await refresh(); assert.equal(await card.getAttribute('data-result'), 'UNCONFIRMED'); assert.match(await card.innerText(), /do not agree/);
  assert.doesNotMatch(await page.locator('body').innerText(), /8m 43s|hand-authored/);
  await page.getByRole('heading', { name: 'Wallet restricted', exact: true }).waitFor();
  const pendingAddress = '0x' + '55'.repeat(20);
  await address.fill(pendingAddress);
  await refresh(); assert.equal(await address.inputValue(), pendingAddress);
  failed = true; await page.getByRole('button', { name: 'Refresh observation', exact: true }).click();
  await page.getByRole('button', { name: 'Retry observation' }).waitFor(); assert.equal(await page.locator('[data-policy]').count(), 0);
  assert.equal(await address.inputValue(), pendingAddress);
  assert.deepEqual(errors, []);
});
