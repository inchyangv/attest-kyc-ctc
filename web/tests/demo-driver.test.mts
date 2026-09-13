import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const k of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|BANK_STATE_)/.test(k)) delete process.env[k];
process.env.KYC_DEMO = '1'; process.env.KYC_DEMO_BITS = '1';
process.env.EVIDENCE_HMAC_KEY = 'synthetic-driver-integration-key-at-least-32-chars';
process.env.SERVER_TOKEN_KEY = 'synthetic-driver-server-token-key-at-least-32-chars';
process.env.SERVER_TOKEN_KEY_ID = 'driver-token-k1';
globalThis.fetch = async () => { throw new Error('unexpected external vendor request'); };
const wallet = await import('../app/api/kyc/wallet/route');
const id = await import('../app/api/kyc/id/route');
const bank = await import('../app/api/kyc/bank/route');
const { open, assertSameFlow, flowFromWalletToken } = await import('../lib/kyc-server');

test('actual driver runs real wallet signature, native PNG validation, demo ID/bank and negative paths before an explicit issuance stub', async () => {
  const calls: string[] = []; let issueCalls = 0; let mixed = false; let badNegative = false;
  const side = (name: string) => ({ configured: true, demo: true, live: false, vendor: `demo:${name}` });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = `http://${req.headers.host}${req.url}`; const path = new URL(url).pathname; calls.push(path);
    const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>,
      ...(req.method === 'GET' ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
    let response: Response;
    try {
      if (path === '/api/kyc/status') response = Response.json({ demo: true, sandboxBits: true, id: side('id'),
        bank: mixed ? { ...side('bank'), vendor: 'openbanking:test' } : side('bank'),
        bankState: { configured: true }, issuer: { configured: true }, issuanceJournal: { configured: true },
        tokenKey: { configured: true, mode: 'versioned-dedicated' } });
      else if (path === '/api/kyc/wallet') response = req.method === 'GET' ? await wallet.GET(request) : await wallet.POST(request);
      else if (path === '/api/kyc/id') response = await id.POST(request);
      else if (path === '/api/kyc/bank') {
        const body = await request.clone().json();
        response = badNegative && body.action === 'start' && body.accountNumber.endsWith('99')
          ? Response.json({ status: 'unexpectedly-accepted' }) : await bank.POST(request);
      }
      else if (path === '/api/kyc/issue') {
        issueCalls++; const body = await request.json(); const flow = flowFromWalletToken(body.walletProof);
        type Bound = import('../lib/kyc-server').FlowBinding & Record<string, unknown>;
        const identity = open<Bound>('id', body.idProof), account = open<Bound>('bank', body.bankProof);
        assertSameFlow(flow, identity, 'id'); assertSameFlow(flow, account, 'bank');
        assert.equal(identity.vendor, 'demo:id'); assert.equal(identity.authentic, true); assert.equal(identity.live, false);
        assert.equal(account.vendor, 'demo:bank'); assert.equal(account.oneWonVerified, true); assert.equal(account.live, false);
        assert.equal(body.declared.fullName, 'PROOFMARK SAMPLE PERSON');
        response = Response.json({ error: 'SYNTHETIC_STOP_BEFORE_ANY_ISSUANCE_OR_CHAIN_CALL' }, { status: 503 });
      } else response = Response.json({ error: 'unexpected path' }, { status: 500 });
    } catch { response = Response.json({ error: 'synthetic harness failure' }, { status: 500 }); }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['deploy/verify-demo.mjs', `http://localhost:${port}`, '--execute-issuance'],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], timeout: 12000 });
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  try {
    const r = await run(); assert.equal(r.code, 1, r.output);
    for (const stage of ['b wallet control', 'c id document', 'd denial A', 'e bank one-won code', 'f denial B']) assert.match(r.output, new RegExp('PASS  ' + stage));
    assert.match(r.output, /FAIL  g issue — HTTP 503/); assert.equal(issueCalls, 1); assert.equal(calls.includes('/api/onchain'), false);
    calls.length = 0; mixed = true; const stopped = await run(); assert.equal(stopped.code, 1);
    assert.deepEqual(calls, ['/api/kyc/status'], 'institutional testbed must stop before wallet, image or bank requests');
    calls.length = 0; mixed = false; badNegative = true; const bad = await run(); assert.equal(bad.code, 1);
    assert.match(bad.output, /FAIL  f denial B/); assert.equal(issueCalls, 1);
    assert.equal(calls.includes('/api/kyc/issue'), false, 'failed negative checks must stop before creating an issuance');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
