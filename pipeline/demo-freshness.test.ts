import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { StatusFixture } from '../test/fixtures/onchain-state.js';
import { checkDemoFreshness, DEMO_NOTE_ABI, parseMinFreshHours } from './demo-freshness.js';
import { readOnchainState } from './onchain-state.js';
import { packAttrs } from './attrs.js';

class DemoFixture extends StatusFixture {
  note = '0x' + '55'.repeat(20); holderB = '0x' + '66'.repeat(20); control = '0x' + '77'.repeat(20);
  until = this.now + 1000; cutoff = this.now - 100; published = this.now - 90;
  root = ethers.id('root'); snapshot = ethers.id('snapshot');
  frozen = true; policyAge = 604800; policyMethods = 65572; rosterRequired = true;
  policyIssuer = this.issuer; source = this.issuer; noteRegistry = this.registry; notePolicy = 2;
  allowControl = false; allowHolders = true; allowProduction = false; allowPilot = true;
  readonly noteAbi = new ethers.Interface(DEMO_NOTE_ABI);
  constructor() { super(); this.attrs.regime = 2; this.attrs.methods = 65572; this.attrs.expiry = this.now + 604800; }
  demoConfig() { return { asc: this.asc, registry: this.registry, note: this.note, source: this.issuer,
    expectedIssuer: this.issuer, holders: [this.subject, this.holderB] as const, control: this.control, minFreshSeconds: 900 }; }
  override call(to: string, data: string, blockTag: unknown): string {
    const abi = to.toLowerCase() === this.note ? this.noteAbi : to.toLowerCase() === this.asc ? this.ascAbi : this.regAbi;
    const f = abi.getFunction(data.slice(0, 10))!; const args = abi.decodeFunctionData(f, data);
    let value: unknown[];
    switch (f.name) {
      case 'REGISTRY': value = [this.noteRegistry]; break;
      case 'POLICY_ID': value = [this.notePolicy]; break;
      case 'canTransfer': value = [String(args[1]).toLowerCase() === this.control ? this.allowControl : this.allowHolders]; break;
      case 'sourceContract': value = [this.source]; break;
      case 'epochValidUntil': value = [this.until]; break;
      case 'epochSourceCutoff': value = [this.cutoff]; break;
      case 'epochPublishedAt': value = [this.published]; break;
      case 'epochRoots': value = [this.root]; break;
      case 'epochSnapshotId': value = [this.snapshot]; break;
      case 'policies': value = [this.policyMethods, 2, args[0] === 1n ? 2592000 : this.policyAge,
        Number(args[0]), 410, this.policyIssuer, this.rosterRequired, true]; break;
      case 'policyFrozen': value = [this.frozen]; break;
      case 'isVerified': value = [String(args[0]).toLowerCase() === this.control ? false : args[1] === 1n ? this.allowProduction : this.allowPilot]; break;
      case 'getRosterWitness':
        value = [String(args[0]).toLowerCase() === this.control ? 0 : this.witnessEpoch,
          [packAttrs(this.attrs), ethers.id('claims'), ethers.id('evidence'), this.issuer]]; break;
      default: return super.call(to, data, blockTag);
    }
    this.reads.push({ method: f.name, blockTag });
    return abi.encodeFunctionResult(f, value);
  }
  run() { return checkDemoFreshness(this.provider(), this.demoConfig(), this.now); }
}

test('freshness uses current witnesses and epoch, with all subjects and note calls at one block', async () => {
  const f = new DemoFixture(); const r = await f.run();
  assert.equal(r.scheduledUntilExclusive, f.now + 1000);
  assert.equal(r.holders[0].remainingSeconds, 1000);
  assert.equal(r.holders[0].limits.credentialExpiry, f.now + 604800);
  assert.ok(f.reads.every(r => r.blockTag === 100));
  assert.equal(f.blockReads.filter(b => b === 'latest').length, 1);
  assert.equal(r.observation.blockHash, f.hash); assert.match(r.guarantee, /none/);
  assert.ok(r.notVerified.includes('actual transfer or balance changes'));
});

test('long credential cannot hide epoch expiry or an insufficient window', async () => {
  for (const seconds of [-1, 0, 899]) {
    const f = new DemoFixture(); f.until = f.now + seconds;
    await assert.rejects(f.run(), /stale roster|scheduled freshness/);
  }
  const f = new DemoFixture(); f.until = f.now + 900;
  assert.equal((await f.run()).holders[0].remainingSeconds, 900, 'end is exclusive, not valid at the end instant');
});

test('witness expiry and policy maxAge can each shorten the scheduled horizon', async () => {
  const f = new DemoFixture(); f.attrs.expiry = f.now + 950;
  assert.equal((await f.run()).holders[0].remainingSeconds, 950);
  f.attrs.expiry = f.now + 899; await assert.rejects(f.run(), /scheduled freshness/);
  const g = new DemoFixture(); g.attrs.issuedAt = g.now - 604800 + 950;
  assert.equal((await g.run()).holders[0].remainingSeconds, 950);
  g.attrs.issuedAt = g.now - 604800; await assert.rejects(g.run(), /scheduled freshness/);
});

test('missing/stale/unapproved witness, tombstone, invalid attrs and dishonest boolean fail', async () => {
  const scenarios: ((f: DemoFixture) => void)[] = [
    f => { f.witnessEpoch = 0; }, f => { f.witnessEpoch = 2; }, f => { f.approved = false; },
    f => { f.tombstone = true; }, f => { f.fresh = false; }, f => { f.attrs.regime = 1; },
    f => { f.attrs.methods = 0; }, f => { f.attrs.expiry = f.now; }, f => { f.attrs.issuedAt = f.now + 1; },
    f => { f.allowPilot = false; }, f => { f.allowProduction = true; },
  ];
  for (const change of scenarios) { const f = new DemoFixture(); change(f); await assert.rejects(f.run()); }
});

test('epoch provenance must obey nonzero, ordering, publication lag and cutoff lifetime bounds', async () => {
  const scenarios: ((f: DemoFixture) => void)[] = [
    f => { f.cutoff = 0; }, f => { f.cutoff = f.published + 1; }, f => { f.published = f.now + 1; },
    f => { f.cutoff = f.published - 3601; }, f => { f.until = f.cutoff + 86401; },
    f => { f.until = f.published; }, f => { f.root = ethers.ZeroHash; }, f => { f.snapshot = ethers.ZeroHash; },
  ];
  for (const change of scenarios) { const f = new DemoFixture(); change(f); await assert.rejects(f.run(), /roster epoch/); }
});

test('schema, network, source, issuer and frozen policy assumptions cannot drift', async () => {
  const scenarios: ((f: DemoFixture) => void)[] = [
    f => { f.legacy = true; }, f => { f.chainId = 1n; }, f => { f.source = f.control; },
    f => { f.policyIssuer = f.control; }, f => { f.frozen = false; }, f => { f.policyAge++; },
    f => { f.policyMethods = 65536; }, f => { f.rosterRequired = false; }, f => { f.wrongBinding = true; },
    f => { f.failMethod = 'ROSTER_WITNESS_VERSION'; },
  ];
  for (const change of scenarios) { const f = new DemoFixture(); change(f); await assert.rejects(f.run()); }
});

test('note binding, control rejection and holder acceptance are mandatory', async () => {
  for (const change of [(f: DemoFixture) => { f.noteRegistry = f.control; }, (f: DemoFixture) => { f.notePolicy = 1; },
    (f: DemoFixture) => { f.allowControl = true; }, (f: DemoFixture) => { f.allowHolders = false; }]) {
    const f = new DemoFixture(); change(f); await assert.rejects(f.run(), /note/);
  }
});

test('reorg after individual state reads but before combined completion returns no report', async () => {
  const f = new DemoFixture(); const provider = f.provider(); let reads = 0;
  provider.getBlock = (async () => ({ number: 100, timestamp: f.now, hash: ++reads === 8 ? ethers.id('late fork') : f.hash })) as unknown as typeof provider.getBlock;
  await assert.rejects(checkDemoFreshness(provider, f.demoConfig(), f.now), /observation block changed/);
  assert.equal(reads, 8);
});

test('unavailable block never falls back to host time and inconsistent observations fail', async () => {
  for (const value of [null, { number: 100, timestamp: 0, hash: ethers.id('bad') }]) {
    const f = new DemoFixture(); const p = f.provider(); p.getBlock = (async () => value) as typeof p.getBlock;
    await assert.rejects(checkDemoFreshness(p, f.demoConfig(), f.now), /observation block unavailable/);
  }
  const f = new DemoFixture(); const p = f.provider(); let reads = 0;
  p.getBlock = (async () => ({ number: 100, timestamp: f.now + (++reads === 2 ? 1 : 0), hash: f.hash })) as unknown as typeof p.getBlock;
  await assert.rejects(checkDemoFreshness(p, f.demoConfig(), f.now), /mixed observation blocks/);
});

test('explicit window rejects absent, zero, fractional-second, excessive and malformed thresholds', async () => {
  assert.equal(parseMinFreshHours('0.25'), 900); assert.equal(parseMinFreshHours('24'), 86400);
  for (const value of [undefined, '', ' ', '0', '-1', '25', 'Infinity', 'NaN', '1e0', '0x1', '0.0001']) {
    assert.throws(() => parseMinFreshHours(value));
  }
  const f = new DemoFixture();
  for (const seconds of [0, -1, NaN, Infinity, 0.5, 86401]) {
    await assert.rejects(checkDemoFreshness(f.provider(), { ...f.demoConfig(), minFreshSeconds: seconds }));
  }
  await assert.rejects(checkDemoFreshness(f.provider(), { ...f.demoConfig(), control: f.subject }), /distinct/);
});

test('stalled and future RPC blocks fail; tolerated lag is deducted from the remaining window', async () => {
  const f = new DemoFixture();
  for (const now of [f.now + 301, f.now - 31]) {
    await assert.rejects(checkDemoFreshness(f.provider(), f.demoConfig(), now), /stale or ahead/);
  }
  const r = await checkDemoFreshness(f.provider(), f.demoConfig(), f.now + 100);
  assert.equal(r.holders[0].remainingSeconds, 900);
  await assert.rejects(checkDemoFreshness(f.provider(), f.demoConfig(), f.now + 101), /scheduled freshness/);
  await assert.rejects(checkDemoFreshness(f.provider(), f.demoConfig(), NaN), /observation clock/);
});

test('optional shared observation block preserves explicit block zero and rejects invalid or substituted numbers', async () => {
  const f = new StatusFixture(); await readOnchainState(f.provider(), f.config(), 100);
  assert.deepEqual(f.blockReads, [100, 100]);
  for (const n of [-1, NaN, 0.1, Infinity]) await assert.rejects(readOnchainState(f.provider(), f.config(), n), /invalid observation/);
  await assert.rejects(readOnchainState(f.provider(), f.config(), 0), /block number mismatch/);
});

test('freshness CLI rejects missing approval inputs before RPC access', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CREDITCOIN_RPC_URL: 'http://127.0.0.1:1' };
  delete env.MIN_FRESH_HOURS; delete env.DEMO_EXPECTED_ISSUER;
  const first = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-demo-freshness.ts'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(first.status, 1); assert.match(first.stderr, /MIN_FRESH_HOURS/); assert.doesNotMatch(first.stderr, /ECONNREFUSED/);
  const second = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-demo-freshness.ts'], { env: { ...env, MIN_FRESH_HOURS: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(second.status, 1); assert.match(second.stderr, /DEMO_EXPECTED_ISSUER/); assert.doesNotMatch(second.stderr, /ECONNREFUSED/);
});

test('actual freshness CLI and ethers JSON-RPC transport pass synthetic state, then reject wrong chain', async () => {
  const f = new DemoFixture(); const manifest = JSON.parse(readFileSync('deployments/cc3-testnet.json', 'utf8'));
  f.asc = manifest.contracts.ProofmarkASC.toLowerCase(); f.registry = manifest.contracts.ProofmarkRegistry.toLowerCase();
  f.source = manifest.contracts.ComplianceSource.toLowerCase(); f.note = manifest.contracts.GatedRwaNote.toLowerCase(); f.noteRegistry = f.registry;
  f.subject = '0x4816b6e3acb775f65da888f185f708e2c8d7a3e2'; f.holderB = '0x77858131d1e0eaaae2c38c2cce508c358c9b58ee';
  f.control = '0x00000000000000000000000000000000deadbeef';
  f.now = Math.floor(Date.now() / 1000); f.cutoff = f.now - 100; f.published = f.now - 90; f.until = f.now + 1000;
  f.attrs.issuedAt = f.now - 100; f.attrs.expiry = f.now + 604800;
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body);
    const respond = async (r: { id: number; method: string; params: unknown[] }) => {
      methods.push(r.method); let result: unknown;
      switch (r.method) {
        case 'eth_chainId': result = ethers.toQuantity(f.chainId); break;
        case 'eth_getBlockByNumber': result = {
          number: '0x64', timestamp: ethers.toQuantity(f.now), hash: f.hash, parentHash: ethers.id('parent'),
          nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
          miner: ethers.ZeroAddress, extraData: '0x', transactions: [],
        }; break;
        case 'eth_getCode': result = await f.provider().getCode(String(r.params[0]), r.params[1] as string); break;
        case 'eth_call': {
          const tx = r.params[0] as { to: string; data: string }; result = f.call(tx.to, tx.data, r.params[1]); break;
        }
        default: return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'unsupported synthetic method' } };
      }
      return { jsonrpc: '2.0', id: r.id, result };
    };
    try {
      const output = Array.isArray(input) ? await Promise.all(input.map(respond)) : await respond(input);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(output));
    } catch { res.statusCode = 500; res.end('synthetic RPC failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'script/check-demo-freshness.ts'], {
      env: { ...process.env, CREDITCOIN_RPC_URL: `http://127.0.0.1:${port}`, MIN_FRESH_HOURS: '0.25', DEMO_EXPECTED_ISSUER: f.issuer },
      timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    const good = await run(); assert.equal(good.code, 0, good.stderr); assert.match(good.stdout, /PASS: observed pilot state/);
    assert.match(good.stdout, /does not guarantee future/); assert.ok(methods.includes('eth_chainId'));
    assert.equal(methods.filter(m => m === 'eth_getBlockByNumber').length, 9, 'one pinned generation probe, then eight canonical rechecks that must reach RPC, not a provider cache');
    assert.ok(f.reads.every(r => r.blockTag === '0x64'));
    f.chainId = 1n; const wrong = await run(); assert.equal(wrong.code, 1); assert.match(wrong.stderr, /wrong hub chain/);
    assert.doesNotMatch(wrong.stdout, /PASS/); assert.ok(methods.every(m => !/send|sign/i.test(m)));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
