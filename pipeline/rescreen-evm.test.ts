import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createEvmRevocationTransport, RESCREEN_SOURCE_ABI } from './rescreen-evm.js';

async function fixture() {
  const source = '0x' + '11'.repeat(20), subject = '0x' + '22'.repeat(20);
  const key = '0x' + '33'.repeat(32), abi = new ethers.Interface(RESCREEN_SOURCE_ABI);
  const signer = new ethers.Wallet(key), blockHash = ethers.id('canonical-source-block');
  const unsigned = { chainId: 11155111, to: source, value: 0n, nonce: 0, gasLimit: 100000, gasPrice: 1000000000,
    data: abi.encodeFunctionData('revokeBatch', [[subject], [2], 1]) };
  const raw = await signer.signTransaction(unsigned);
  const transaction = { raw, hash: ethers.keccak256(raw), chainId: 11155111, source };
  const event = abi.encodeEventLog(abi.getEvent('MarkRevoked')!, [subject, 2, 1]);
  const f = { chainId: 11155111n, code: '0x6000', head: 200, blockReads: 0, reorgAt: 0, broadcasts: 0,
    broadcastHash: transaction.hash, missing: false, waits: 0,
    receipt: { hash: transaction.hash, to: source, from: signer.address, blockNumber: 190, blockHash, status: 1,
      logs: [{ address: source, ...event }] } };
  const provider = {
    getNetwork: async () => ({ chainId: f.chainId }), getCode: async () => f.code,
    getTransactionReceipt: async () => f.missing ? null : f.receipt,
    getBlockNumber: async () => f.head,
    getBlock: async () => ({ hash: ++f.blockReads === f.reorgAt ? ethers.id('fork') : blockHash }),
    broadcastTransaction: async () => { f.broadcasts++; return { hash: f.broadcastHash }; },
    waitForTransaction: async () => { f.waits++; return { status: 1 }; },
  } as unknown as ethers.JsonRpcProvider;
  const attached = signer.connect(provider);
  const config = { chainId: 11155111, source, confirmations: 6 };
  const transport = await createEvmRevocationTransport(provider, attached, config);
  return Object.assign(f, { transport, transaction, source, subject, signer, attached, provider, config, abi, unsigned });
}

test('production revocation transport validates signed intent, signer, target, chain and zero value before broadcast', async () => {
  const f = await fixture();
  const job = { id: 'synthetic', recordId: 'synthetic', state: 'prepared' as const, walletAddress: f.subject, createdAt: 1000 };
  f.transport.assertJob(job, f.transaction);
  assert.throws(() => f.transport.assertJob({ ...job, walletAddress: f.source }, f.transaction), /signed subject/);
  await f.transport.broadcast(f.transaction); assert.equal(f.broadcasts, 1);
  for (const change of [{ to: f.subject }, { chainId: 1 }, { value: 1n }, { data: '0x' },
    { data: f.abi.encodeFunctionData('revokeBatch', [[f.subject], [3], 1]) },
    { data: f.abi.encodeFunctionData('revokeBatch', [[ethers.ZeroAddress], [2], 1]) },
    { data: f.abi.encodeFunctionData('revokeBatch', [[f.subject, f.source], [2, 2], 1]) },
    { data: f.abi.encodeFunctionData('revokeBatch', [[f.subject], [2], 0]) }]) {
    const raw = await f.signer.signTransaction({ ...f.unsigned, ...change });
    await assert.rejects(f.transport.broadcast({ ...f.transaction, raw, hash: ethers.keccak256(raw) }));
  }
  const foreign = await ethers.Wallet.createRandom().signTransaction(f.unsigned);
  await assert.rejects(f.transport.broadcast({ ...f.transaction, raw: foreign, hash: ethers.keccak256(foreign) }));
  await assert.rejects(f.transport.broadcast({ ...f.transaction, hash: ethers.id('wrong') }));
  assert.equal(f.broadcasts, 1);
  f.broadcastHash = ethers.id('wrong'); await assert.rejects(f.transport.broadcast(f.transaction), /broadcast hash/);
});

test('source success requires canonical depth and exact revocation event; mismatches do not become confirmed', async () => {
  const f = await fixture(); assert.equal(await f.transport.receipt(f.transaction), 'success'); assert.equal(f.blockReads, 2);
  const a = await fixture(); a.missing = true; assert.equal(await a.transport.receipt(a.transaction), null);
  const b = await fixture(); b.head = 194; assert.equal(await b.transport.receipt(b.transaction), null);
  for (const reorgAt of [1, 2]) { const c = await fixture(); c.reorgAt = reorgAt; assert.equal(await c.transport.receipt(c.transaction), null); }
  const changes: ((value: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    g => { g.receipt.from = g.subject; }, g => { g.receipt.to = g.subject; }, g => { g.receipt.hash = ethers.id('wrong'); },
    g => { g.receipt.status = 2; }, g => { g.receipt.logs = []; }, g => { g.receipt.logs.push(g.receipt.logs[0]); },
    g => { g.receipt.logs[0].topics[1] = ethers.zeroPadValue(g.source, 32); },
    g => { g.receipt.logs[0].topics[3] = ethers.zeroPadValue('0x02', 32); },
    g => { g.receipt.logs[0].data = '0xab'; },
  ];
  for (const change of changes) { const g = await fixture(); change(g); await assert.rejects(g.transport.receipt(g.transaction)); }
});

test('wait reconciles again instead of trusting wait status, including reverted receipt reorg', async () => {
  const a = await fixture(); a.receipt.logs = []; await assert.rejects(a.transport.wait(a.transaction), /event mismatch/); assert.equal(a.waits, 1);
  const b = await fixture(); b.receipt.status = 0; assert.equal(await b.transport.wait(b.transaction), 'reverted'); assert.equal(b.blockReads, 2);
  const c = await fixture(); c.receipt.status = 0; c.reorgAt = 2; assert.equal(await c.transport.wait(c.transaction), null);
  const d = await fixture(); assert.equal(await d.transport.wait(d.transaction), 'success');
});

test('transport initialization and preparation reject wrong network, missing source, config, signer provider and bound job target', async () => {
  const f = await fixture();
  for (const config of [{ ...f.config, chainId: 1 }, { ...f.config, confirmations: 0 }, { ...f.config, epoch: 0 },
    { ...f.config, epoch: 0x100000000 }, { ...f.config, source: ethers.ZeroAddress }]) {
    await assert.rejects(createEvmRevocationTransport(f.provider, f.attached, config));
  }
  await assert.rejects(createEvmRevocationTransport(f.provider, f.signer, f.config), /provider mismatch/);
  f.code = '0x'; await assert.rejects(createEvmRevocationTransport(f.provider, f.attached, f.config), /no code/);
  await assert.rejects(f.transport.prepare({ id: 'synthetic', recordId: 'synthetic', state: 'pending',
    walletAddress: f.subject, createdAt: 1000, sourceTarget: { chainId: 1, source: f.source } }), /does not match/);
});
