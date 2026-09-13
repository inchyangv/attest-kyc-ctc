/** Chromium → built local HTTP route → actual AML decision engine, fictional corpus only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('sample demo executes the built fixed-input route without a wallet, clears prior verdicts and rejects non-training responses', async t => {
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: fileURLToPath(new URL('../web/', import.meta.url)), stdio: 'ignore', env: { ...process.env, KYC_DEMO: '1' },
  });
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await new Promise(r => app.once('exit', r)); } });
  // NextURL canonicalizes loopback IPs to localhost; use the matching browser origin.
  const base = `http://localhost:${port}`;
  for (let n = 0; ; n++) {
    try { if ((await fetch(base + '/demo')).ok) break; throw new Error('not ready'); }
    catch { if (app.exitCode !== null || n >= 100) throw new Error('local Next build did not start'); await delay(100); }
  }
  const probe = await fetch(base + '/api/demo/screen', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"scenario":"full-match"}' });
  const probeBody = await probe.json(); assert.equal(probe.status, 200, JSON.stringify(probeBody)); assert.equal(probeBody.trainingDecision, 'BLOCK');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript({ content: `Object.defineProperty(window, 'ethereum', { get() { throw new Error('training must not access a wallet'); } });` });
  const requests: string[] = []; let replacement: 'none' | 'failure' | 'wrong-scope' = 'none';
  await page.route('**/*', async route => {
    const req = route.request(), url = req.url();
    if (!url.startsWith(base)) return route.abort();
    if (!url.startsWith(base + '/api/')) return route.continue();
    const path = new URL(url).pathname; requests.push(path);
    if (path === '/api/onchain') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"network unavailable"}' });
    if (path === '/api/demo/screen') {
      assert.deepEqual(Object.keys(req.postDataJSON()), ['scenario']);
      if (replacement === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic failure"}' });
      if (replacement === 'wrong-scope') return route.fulfill({ contentType: 'application/json', body: '{"decision":"ALLOW","scope":"production"}' });
      return route.continue(); // Exercise actual built route and engine, not a canned decision.
    }
    return route.fulfill({ status: 500, body: 'unexpected API request' });
  });
  await page.goto(base + '/demo');
  assert.deepEqual(requests, [], 'the demo must wait for the user to start');
  assert.equal(await page.locator('input').count(), 0, 'sample screening must not collect personal data');
  assert.match(await page.locator('body').innerText(), /sample identities and a separate testnet credential/);
  const cases = [['Start demo', 'BLOCK', /sample name and birth date support a match/], ['Name only', 'REVIEW', /More identity information is needed/],
    ['Different birth date', 'REVIEW', /birth date is different/], ['No match', 'ALLOW', /does not match the sample record/]] as const;
  for (const [label, decision, explanation] of cases) {
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    const result = page.locator(`[data-demo-training="${decision}"]`);
    try { await result.waitFor({ timeout: 5000 }); } catch { throw new Error('sample rendering failed: ' + await page.locator('body').innerText()); }
    // REVIEW → REVIEW must wait for the specific case, not the previous result.
    try {
      await page.waitForFunction(({ pattern }) => new RegExp(pattern).test(document.querySelector('[data-demo-training]')?.textContent ?? ''), { pattern: explanation.source }, { timeout: 5000 });
    } catch { throw new Error(`sample ${label} did not render its result: ${await result.innerText()}`); }
    assert.match(await result.innerText(), explanation);
    assert.match(await page.locator('body').innerText(), /does not verify your identity or grant access/);
    assert.equal(await page.locator('input').count(), 0);
    assert.equal(await page.locator('[data-demo-policy]').count(), 0, 'sample results must not generate application eligibility');
  }
  for (const mode of ['failure', 'wrong-scope'] as const) {
    replacement = mode;
    await page.getByRole('button', { name: mode === 'failure' ? /^Full identity match/ : 'Try again', exact: mode !== 'failure' }).click();
    await page.getByText('The sample could not be checked. Please try again.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-demo-training]').count(), 0);
  }
  assert.equal(requests.filter(p => p === '/api/demo/screen').length, 6);
  assert.ok(requests.every(p => p === '/api/onchain' || p === '/api/demo/screen'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'demo must not overflow at 390px');
  assert.deepEqual(errors, []);
});
