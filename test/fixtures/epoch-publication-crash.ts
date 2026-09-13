// Isolated process harness, not a production publisher or an AML readiness bypass option.
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { issuanceProvider } from '../../pipeline/issuance-evm.js';
import { EpochPublicationJournal } from '../../pipeline/epoch-publication-journal.js';
import { advancePublication, evmPublicationTransport } from '../../pipeline/epoch-publication-delivery.js';

assert.ok(process.send && process.connected, 'requires owned test IPC child');
const url = new URL(process.env.TEST_SOURCE_RPC!);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
const provider = issuanceProvider(url.href);
assert.equal((await provider.getNetwork()).chainId, 11155111n);
const key = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/3").privateKey;
const wallet = new ethers.Wallet(key, provider);
const journal = new EpochPublicationJournal(process.env.TEST_JOURNAL_PATH!, process.env.TEST_JOURNAL_SECRET!,
  { chainId: 11155111, source: process.env.TEST_SOURCE_ADDRESS!, publisher: wallet.address });
const entry = journal.begin(JSON.parse(process.env.TEST_INTENT!));
const transport = evmPublicationTransport(provider, wallet, journal, 2, async () => {});
const original = transport.broadcast.bind(transport);
const afterAcceptance = process.env.TEST_CRASH_STAGE === 'accepted';
if (afterAcceptance) {
  assert.ok(entry.transaction, 'restart requires the original signed transaction');
  transport.prepare = async () => { throw new Error('restart must not sign again'); };
}
transport.broadcast = async e => {
  assert.equal(journal.snapshot()[0].transaction!.raw, e.transaction!.raw);
  if (afterAcceptance) await original(e);
  process.send!({ stage: afterAcceptance ? 'accepted' : 'presaved', hash: e.transaction!.hash });
  // Parent deliberately SIGKILLs this owned child. IPC keeps the process alive; no finally
  // cleanup can run, so the real exclusive lock and pre-confirmation ciphertext survive.
  await new Promise<never>(() => {});
};
await advancePublication(journal, entry.id, transport);
throw new Error('crash gate unexpectedly returned');
