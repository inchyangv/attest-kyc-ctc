import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { StatusFixture } from '../../test/fixtures/onchain-state.js';
import { ROSTER_SELECTORS } from '../../pipeline/roster-format.js';
import { GET } from '../app/api/onchain/route';

test('actual onchain route pins RPC reads, returns no-store, rejects reorg and labels legacy observations', async t => {
  const f = new StatusFixture(); const methods = new Set<string>();
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(parts).toString()); methods.add(rpc.method);
    let result: unknown;
    try {
      switch (rpc.method) {
        case 'eth_chainId': result = '0x18e8f'; break; // 102031
        case 'eth_getCode': assert.equal(rpc.params[1], '0x64'); result = '0x' + ROSTER_SELECTORS.join(''); break;
        case 'eth_call':
          assert.equal(rpc.params[1], '0x64');
          result = f.call(rpc.params[0].to, rpc.params[0].data, rpc.params[1]); break;
        case 'eth_getBlockByNumber':
          f.blockReads.push(rpc.params[0]);
          result = { number: '0x64', hash: f.reorg && f.blockReads.length > 1 ? ethers.id('fork') : f.hash,
            parentHash: ethers.id('parent'), timestamp: ethers.toQuantity(f.now), nonce: '0x0000000000000000',
            difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x', transactions: [], baseFeePerGas: '0x1' };
          break;
        default: throw new Error('unexpected RPC method');
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'synthetic failure' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const saved = { ...process.env };
  t.after(() => { for (const name of ['NEXT_PUBLIC_CC3_RPC', 'NEXT_PUBLIC_ASC', 'NEXT_PUBLIC_REGISTRY']) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  } });
  process.env.NEXT_PUBLIC_CC3_RPC = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.NEXT_PUBLIC_ASC = f.asc; process.env.NEXT_PUBLIC_REGISTRY = f.registry;
  const request = () => new Request(`http://localhost/api/onchain?subject=${f.subject}`, { headers: { 'x-forwarded-for': randomUUID() } });
  let response = await GET(request());
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json(); assert.equal(state.blockNumber, 100); assert.equal(state.policies[0].diagnosis, 'consistent');
  assert.equal(state.witness.epoch, 1); assert.equal(state.propagation.hubTransaction, null);
  assert.deepEqual(f.blockReads, ['latest', '0x64']);
  assert.ok(f.reads.every(read => read.blockTag === '0x64'));
  f.reorg = true; f.blockReads = [];
  response = await GET(request()); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(await response.json()), ['error']);
  f.reorg = false; f.legacy = true; f.blockReads = [];
  response = await GET(request()); assert.equal(response.status, 200);
  const legacy = await response.json(); assert.equal(legacy.registry.proofMode, false); assert.equal(legacy.policies[0].diagnosis, 'unavailable');
  assert.deepEqual([...methods].sort(), ['eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode']);
});
