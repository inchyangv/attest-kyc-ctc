import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { EvmRelayTransport, RelaySender } from '../worker/relay.js';
import { EvmHubRecoveryReader, initializeHubRecovery, reconcileHubRecovery } from '../worker/recovery.js';
import { Store, type WorkerScope } from '../worker/store.js';

test('actual hub refuses lost state, stale backup and released receipt removed by a deep reorg', async t => {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '102031', '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); } });
  const provider = issuanceProvider(`http://127.0.0.1:${port}`); t.after(() => provider.destroy());
  for (let n = 0; ; n++) {
    try { await provider.getBlockNumber(); break; } catch { if (n >= 30) throw new Error('isolated Anvil not ready'); await delay(100); }
  }
  const mnemonic = 'test test test test test test test test test test test junk';
  const wallet = (index: number) => new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`).privateKey, provider);
  const owner = wallet(0), deepSigner = wallet(1), staleSigner = wallet(2), lostSigner = wallet(3);
  const artifact = JSON.parse(readFileSync(new URL('../out/RelayReceiptFixture.sol/RelayReceiptFixture.json', import.meta.url), 'utf8'));
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(); await deployed.waitForDeployment();
  const target = new ethers.Contract(await deployed.getAddress(), artifact.abi, provider);
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-t16-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scope = (signer: string): WorkerScope => ({ sourceChainId: 11155111, hubChainId: 102031, chainKey: 1,
    source: owner.address.toLowerCase(), asc: String(target.target).toLowerCase(), signer: signer.toLowerCase(), startBlock: 1 });
  const open = async (name: string, signer: ethers.Wallet) => {
    const path = join(dir, `${name}.json`), store = new Store(path), reader = new EvmHubRecoveryReader(provider, target);
    store.bindScope(scope(signer.address)); await initializeHubRecovery(store, reader); await reconcileHubRecovery(store, reader, 2);
    return { path, store, reader };
  };
  const complete = async (store: Store, signer: ethers.Wallet, id: string) => {
    const txHash = ethers.id(`source-${id}`), queryId = ethers.id(`query-${id}`);
    store.add({ txHash, blockNumber: 1, blockHash: ethers.id('synthetic-source-block'), transactionIndex: 0,
      action: 0, eventName: 'synthetic', logCount: 1, state: 'attested', attempts: 0 });
    const transport = new EvmRelayTransport(provider, signer, target, 2), sender = new RelaySender(store, transport);
    const preparation = { queryId, data: target.interface.encodeFunctionData('execute', [queryId, false]), gasLimit: 150000n };
    await sender.step(txHash, preparation); await provider.send('evm_mine', []); await sender.step(txHash);
    assert.equal(store.get(txHash)?.state, 'done'); return store.get(txHash)!.ascTxHash!;
  };

  // A terminal transaction was released locally, then removed together with its consumed nonce.
  const deep = await open('deep', deepSigner), beforeTerminal = await provider.send('evm_snapshot', []);
  const removedHash = await complete(deep.store, deepSigner, 'deep');
  assert.ok(await provider.getTransactionReceipt(removedHash));
  assert.equal(await provider.send('evm_revert', [beforeTerminal]), true);
  await provider.send('evm_mine', []); await provider.send('evm_mine', []);
  await assert.rejects(reconcileHubRecovery(new Store(deep.path), deep.reader, 2), /HUB_TERMINAL_HISTORY_NOT_CANONICAL/);
  assert.throws(() => new Store(deep.path).assertHubReady(), /HUB_TERMINAL_HISTORY_NOT_CANONICAL/);

  // Restoring a pre-second-transaction backup cannot hide the signer's later canonical nonce.
  const stale = await open('stale', staleSigner); await complete(stale.store, staleSigner, 'stale-0');
  const oldBackup = readFileSync(stale.path); await complete(stale.store, staleSigner, 'stale-1');
  writeFileSync(stale.path, oldBackup);
  await assert.rejects(reconcileHubRecovery(new Store(stale.path), stale.reader, 2), /HUB_SIGNER_NONCE_DIVERGED/);
  assert.throws(() => new Store(stale.path).assertHubReady(), /HUB_SIGNER_NONCE_DIVERGED/);

  // A missing file cannot silently claim a nonzero dedicated signer as a clean baseline.
  const lostQuery = ethers.id('lost-state');
  await (await target.connect(lostSigner).getFunction('execute')(lostQuery, false)).wait();
  const lostPath = join(dir, 'lost.json'), lost = new Store(lostPath); lost.bindScope(scope(lostSigner.address));
  await assert.rejects(reconcileHubRecovery(lost, new EvmHubRecoveryReader(provider, target), 2), /HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION/);
  assert.throws(() => new Store(lostPath).assertHubReady(), /HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION/);
});
