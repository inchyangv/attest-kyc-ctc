import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { Store } from '../worker/store.js';
import { scanSourceStep } from '../worker/source-scan.js';

test('actual source RPC checkpoints recover an unsigned transaction relocated by an Anvil reorg', async t => {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111', '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); } });
  const provider = issuanceProvider(`http://127.0.0.1:${port}`); t.after(() => provider.destroy());
  for (let n = 0; ; n++) {
    try { await provider.getBlockNumber(); break; } catch { if (n >= 30) throw new Error('isolated Anvil not ready'); await delay(100); }
  }
  const mnemonic = 'test test test test test test test test test test test junk';
  const owner = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic).privateKey, provider);
  const issuer = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").privateKey, provider);
  const artifact = JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8'));
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(owner.address); await deployed.waitForDeployment();
  const source = new ethers.Contract(await deployed.getAddress(), artifact.abi, owner);
  await (await source.setIssuer(issuer.address, true)).wait();
  const startBlock = await provider.getBlockNumber() + 1;
  const snapshot = await provider.send('evm_snapshot', []);
  const unsigned = await issuer.populateTransaction({ to: await source.getAddress(), data: source.interface.encodeFunctionData('revoke', [owner.address, 2, 0]), value: 0n });
  const raw = await issuer.signTransaction(unsigned); const hash = ethers.keccak256(raw);
  const original = await (await provider.broadcastTransaction(raw)).wait(); assert.ok(original);
  for (let n = 0; n < 80; n++) await provider.send('evm_mine', []);
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-source-reorg-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); let store = new Store(path);
  const options = { address: await source.getAddress(), startBlock, confirmations: 2, chunk: 16 };
  const catchUp = async () => {
    let rewound = 0;
    for (let n = 0; n < 20; n++) {
      const result = await scanSourceStep(store, provider, source.interface, options); rewound += result.rewound;
      if (!result.scanned) return rewound;
    }
    throw new Error('fixture scan did not reach finalized head');
  };
  await catchUp(); assert.equal(store.get(hash)?.blockHash, original.blockHash);
  const finalized = await provider.getBlock('finalized'); assert.ok(finalized); assert.ok(store.cursor <= finalized.number);
  assert.equal(await provider.send('evm_revert', [snapshot]), true);
  await provider.send('evm_mine', []);
  const moved = await (await provider.broadcastTransaction(raw)).wait(); assert.ok(moved);
  assert.equal(moved.hash, hash); assert.notEqual(moved.blockNumber, original.blockNumber);
  for (let n = 0; n < 80; n++) await provider.send('evm_mine', []);
  store = new Store(path);
  assert.equal(await catchUp(), 1);
  assert.equal(store.get(hash)?.blockHash, moved.blockHash); assert.equal(store.get(hash)?.blockNumber, moved.blockNumber);
  assert.equal(store.get(hash)?.transactionIndex, moved.index); assert.equal(store.pending().length, 1);
});
