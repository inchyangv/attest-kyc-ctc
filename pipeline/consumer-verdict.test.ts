import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { ethers } from 'ethers';
import { readConsumerVerdict } from './consumer-verdict.js';
import { STATUS_ASC_ABI, STATUS_REGISTRY_ABI } from './onchain-state.js';

function fixture() {
  const address = (n: number) => ethers.toBeHex(n, 20);
  const config = { registry: address(1), asc: address(2), source: address(3),
    registryCodeHash: ethers.keccak256('0x6001'), ascCodeHash: ethers.keccak256('0x6002') };
  const block = { number: 55, hash: ethers.id('block'), timestamp: 1800000000 };
  const state = { chain: 102031n, finalChain: 102031n, finalBlock: { ...block }, code: '0x6001' };
  const values: Record<string, unknown[]> = {
    ATTRS_SCHEMA_VERSION: [0], POLICY_SCHEMA_VERSION: [2], ROSTER_FORMAT_VERSION: [2], EPOCH_SCHEMA_VERSION: [2],
    ROSTER_AUTH_VERSION: [1], ISSUER_KEY_PROVENANCE_VERSION: [1], ROSTER_WITNESS_VERSION: [1], TRANSACTION_PROCESSING_VERSION: [2],
    ASC: [config.asc], sourceContract: [config.source], expectedChainKey: [1],
    policies: [65572, 2, 604800, 2, 410, address(4), true, true], policyKind: [1], policyFrozen: [true], isVerified: [true],
  };
  const tags: unknown[] = [], ids: bigint[] = [];
  let networks = 0;
  const registry = new ethers.Interface(STATUS_REGISTRY_ABI), asc = new ethers.Interface(STATUS_ASC_ABI);
  const provider = {
    getNetwork: async () => ({ chainId: networks++ === 0 ? state.chain : state.finalChain }),
    getBlock: async (tag: unknown) => tag === 'latest' ? block : state.finalBlock,
    getCode: async (target: string, tag: unknown) => { tags.push(tag); return target === config.registry ? state.code : '0x6002'; },
    call: async (tx: { to: string; data: string; blockTag: unknown }) => {
      tags.push(tx.blockTag);
      const abi = tx.to.toLowerCase() === config.registry ? registry : asc;
      const call = abi.parseTransaction({ data: tx.data })!;
      if (call.name === 'isVerified') ids.push(call.args[1]);
      if (['policies', 'policyKind', 'policyFrozen'].includes(call.name)) ids.push(call.args[0]);
      return abi.encodeFunctionResult(call.fragment, values[call.name]);
    },
  } as unknown as ethers.Provider;
  return { config, block, state, values, tags, ids, provider, subject: address(5) };
}

test('consumer observes one frozen policy with full uint256 ID and code/calls at the same block', async () => {
  const f = fixture();
  const result = await readConsumerVerdict(f.provider, f.config, f.subject, ethers.MaxUint256);
  assert.equal(result.verdict, 'accepted'); assert.equal(result.verified, true);
  assert.equal(result.policy.id, ethers.MaxUint256.toString()); assert.equal(result.policy.kind, 1);
  assert.equal(result.policy.requireAll, 65572); assert.equal(result.policy.trustedIssuer, f.values.policies[5]);
  assert.equal(result.observation.blockHash, f.block.hash); assert.equal(result.observation.registryCodeHash, f.config.registryCodeHash);
  assert.ok(f.tags.length > 15 && f.tags.every(tag => tag === 55));
  assert.deepEqual(f.ids, Array(4).fill(ethers.MaxUint256)); assert.match(result.meaning, /not-asset/);
});

test('consumer false is a completed rejection, supports typed entity policy and labels Direct freshness limits', async () => {
  const f = fixture(); f.values.isVerified = [false]; f.values.policyKind = [2]; f.values.policies[6] = false;
  const result = await readConsumerVerdict(f.provider, f.config, f.subject, 3n);
  assert.equal(result.verdict, 'rejected'); assert.equal(result.verified, false);
  assert.equal(result.policy.kind, 2); assert.equal(result.policy.requireRoster, false);
  assert.match(result.warning, /does not establish continued revocation freshness/);
});

test('consumer refuses configuration, schema, runtime, binding and policy faults instead of reporting a boolean', async () => {
  for (const patch of [{ registry: ethers.ZeroAddress }, { asc: 'invalid' }, { registryCodeHash: ethers.ZeroHash }, { ascCodeHash: '0x' }]) {
    const f = fixture(); await assert.rejects(readConsumerVerdict(f.provider, { ...f.config, ...patch }, f.subject, 1n), /CONSUMER_CONFIG_INVALID/);
    assert.equal(f.tags.length, 0);
  }
  for (const id of [0n, -1n, ethers.MaxUint256 + 1n]) {
    const f = fixture(); await assert.rejects(readConsumerVerdict(f.provider, f.config, f.subject, id), /CONSUMER_CONFIG_INVALID/);
  }
  for (const [name, value, code] of [
    ['ATTRS_SCHEMA_VERSION', [1], 'SCHEMA_UNSUPPORTED'], ['ROSTER_WITNESS_VERSION', [0], 'SCHEMA_UNSUPPORTED'],
    ['ASC', [ethers.ZeroAddress], 'BINDING_MISMATCH'], ['sourceContract', [ethers.ZeroAddress], 'BINDING_MISMATCH'],
    ['expectedChainKey', [2], 'BINDING_MISMATCH'], ['policyFrozen', [false], 'POLICY_UNAPPROVED'], ['policyKind', [0], 'POLICY_UNAPPROVED'],
    ['policies', [0, 0, 0, 0, 0, ethers.ZeroAddress, false, false], 'POLICY_UNAPPROVED'],
  ] as const) {
    const f = fixture(); f.values[name] = [...value];
    await assert.rejects(readConsumerVerdict(f.provider, f.config, f.subject, 1n), new RegExp(`CONSUMER_${code}`));
  }
  for (const code of ['0x', '0x6003', '0xabc']) {
    const f = fixture(); f.state.code = code;
    await assert.rejects(readConsumerVerdict(f.provider, f.config, f.subject, 1n), /CONSUMER_RUNTIME_MISMATCH/);
  }
});

test('consumer rejects initial wrong network and final number/hash/time/network drift', async () => {
  const first = fixture(); first.state.chain = 1n;
  await assert.rejects(readConsumerVerdict(first.provider, first.config, first.subject, 1n), /CONSUMER_CHAIN_MISMATCH/);
  for (const patch of [{ number: 56 }, { hash: ethers.id('fork') }, { timestamp: 1800000001 }]) {
    const f = fixture(); Object.assign(f.state.finalBlock, patch);
    await assert.rejects(readConsumerVerdict(f.provider, f.config, f.subject, 1n), /CONSUMER_OBSERVATION_CHANGED/);
  }
  const f = fixture(); f.state.finalChain = 1n;
  await assert.rejects(readConsumerVerdict(f.provider, f.config, f.subject, 1n), /CONSUMER_OBSERVATION_CHANGED/);
});

test('consumer CLI rejects missing/invalid explicit arguments and configuration with structured unavailable, not false', () => {
  for (const args of [[], [ethers.toBeHex(5, 20), '-1'], [ethers.toBeHex(5, 20), '2'], [ethers.toBeHex(5, 20), '2', 'extra']]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'examples/consumer/check.ts', ...args], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 2, run.stderr);
    const result = JSON.parse(run.stdout); assert.equal(result.verdict, 'unavailable'); assert.equal(result.verified, null);
    assert.match(result.error, /^CONSUMER_(ARGUMENTS|CONFIG)_INVALID$/); assert.equal(run.stderr, '');
  }
});

test('consumer CLI projects RPC failure without leaking provider diagnostics or creating a false rejection', async t => {
  const methods: string[] = [], secret = 'SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body); methods.push(call.method);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(call.method === 'eth_chainId'
      ? { result: ethers.toQuantity(102031) } : { error: { code: -32000, message: secret } }) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const f = fixture();
  const child = spawn(process.execPath, ['--import', 'tsx', 'examples/consumer/check.ts', f.subject, '2'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH,
      CREDITCOIN_RPC_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/${secret}`,
      REGISTRY_CONTRACT_ADDRESS: f.config.registry, ASC_CONTRACT_ADDRESS: f.config.asc, SOURCE_CONTRACT_ADDRESS: f.config.source,
      DEMO_REGISTRY_CODEHASH: f.config.registryCodeHash, DEMO_ASC_CODEHASH: f.config.ascCodeHash }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  assert.equal(await exit, 2, stderr);
  assert.deepEqual(JSON.parse(stdout), { verdict: 'unavailable', verified: null, error: 'CONSUMER_DEPENDENCY_UNAVAILABLE' });
  assert.equal((stdout + stderr).includes(secret), false);
  assert.ok(methods.includes('eth_getBlockByNumber')); assert.ok(methods.every(method => ['eth_chainId', 'eth_getBlockByNumber'].includes(method)));
});
