import { ethers } from 'ethers';
import { EPOCH_SOURCE_ABI } from './epoch.js';
import { ROSTER_AUTH_ABI } from './roster-authorization.js';
import { EpochPublicationJournal, PublicationJournalError, type PublicationEntry, type PublicationConfirmation } from './epoch-publication-journal.js';

export const PUBLICATION_ABI = new ethers.Interface([...EPOCH_SOURCE_ABI, ...ROSTER_AUTH_ABI]);
export type PublicationObservation = { state: 'absent' | 'confirming' } | { state: 'confirmed'; confirmation: PublicationConfirmation };
export interface PublicationTransport {
  observe(entry: PublicationEntry): Promise<PublicationObservation>;
  assertReady(entry: PublicationEntry): Promise<void>;
  prepare(entry: PublicationEntry): Promise<string>;
  broadcast(entry: PublicationEntry): Promise<void>;
}
const fail = (code: string): never => { throw new PublicationJournalError(code); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Read-only final fence after slow hub/replay work. Never persists, prepares or rebroadcasts. */
export async function reobservePublication(transport: Pick<PublicationTransport, 'observe'>,
  entry: PublicationEntry, expected: PublicationConfirmation): Promise<PublicationConfirmation> {
  if (entry.abandonment || !entry.transaction || entry.transaction.hash !== expected.transactionHash || expected.status !== 1)
    fail('PUBLICATION_CONFIRMATION_CHANGED');
  const observed = await transport.observe(entry);
  if (observed.state !== 'confirmed' || observed.confirmation.status !== 1
    || observed.confirmation.transactionHash !== expected.transactionHash
    || observed.confirmation.blockNumber !== expected.blockNumber || observed.confirmation.blockHash !== expected.blockHash)
    return fail('PUBLICATION_CONFIRMATION_CHANGED');
  return observed.confirmation;
}

/** One bounded recovery step. The caller holds the journal's exclusive lease throughout.
 * A previously confirmed entry is re-observed but never automatically sent again after a reorg.
 */
export async function advancePublication(journal: EpochPublicationJournal, id: string, transport: PublicationTransport): Promise<PublicationObservation> {
  let entry = journal.snapshot().find(e => e.id === id);
  if (!entry) return fail('PUBLICATION_NOT_FOUND');
  if (entry.abandonment) return fail('PUBLICATION_ABANDONED');
  const finish = (observation: PublicationObservation): PublicationObservation => {
    if (entry!.confirmation) {
      const c = entry!.confirmation;
      if (observation.state !== 'confirmed' || observation.confirmation.transactionHash !== c.transactionHash
        || observation.confirmation.blockHash !== c.blockHash || observation.confirmation.blockNumber !== c.blockNumber
        || observation.confirmation.status !== c.status) fail('PUBLICATION_CONFIRMATION_CHANGED');
    } else if (observation.state === 'confirmed') journal.confirm(id, observation.confirmation);
    return observation;
  };
  let observation = await transport.observe(entry);
  if (entry.confirmation || observation.state !== 'absent') return finish(observation);
  await transport.assertReady(entry);
  journal.snapshot();
  if (!entry.transaction) {
    const raw = await transport.prepare(entry);
    entry = journal.prepare(id, raw); // No broadcast after an unacknowledged signature save.
  }
  await transport.assertReady(entry);
  // A receipt may have appeared while preparing/checking dependencies. Shallow receipt = wait.
  observation = await transport.observe(entry);
  if (observation.state !== 'absent') return finish(observation);
  journal.snapshot(); // Synchronous poison/closed check at the network boundary.
  try { await transport.broadcast(entry); } catch { /* Unknown acceptance: reconcile only these bytes. */ }
  observation = await transport.observe(entry);
  return finish(observation);
}

/** RPC consistency/canonical-depth checks, not an authenticated chain light client. Caller's
 * readiness callback must verify original roster, current official data and approval coverage.
 */
export function evmPublicationTransport(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet | ethers.VoidSigner,
  journal: EpochPublicationJournal, confirmations: number,
  ready: (entry: PublicationEntry) => Promise<void>): PublicationTransport {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || wallet.provider !== provider
    || !same(wallet.address, journal.scope.publisher)) fail('PUBLICATION_TRANSPORT_CONFIG');
  const scope = journal.scope;
  async function cutoff(entry: PublicationEntry) {
    if ((await provider.getNetwork()).chainId !== BigInt(scope.chainId) || await provider.getCode(scope.source) === '0x') fail('PUBLICATION_TARGET_CHANGED');
    const block = await provider.getBlock(entry.intent.sourceCutoff.blockNumber);
    const call = PUBLICATION_ABI.parseTransaction({ data: entry.intent.calldata })!;
    if (!block || block.number !== entry.intent.sourceCutoff.blockNumber || block.hash !== entry.intent.sourceCutoff.blockHash
      || !Number.isSafeInteger(block.timestamp) || BigInt(block.timestamp) !== call.args.sourceCutoff) fail('PUBLICATION_SOURCE_CUTOFF_CHANGED');
    return call;
  }
  function signed(entry: PublicationEntry) {
    const tx = entry.transaction;
    if (!tx) return fail('PUBLICATION_SIGNATURE_MISSING');
    const parsed = ethers.Transaction.from(tx.raw);
    if (!parsed.isSigned() || parsed.hash !== tx.hash || parsed.nonce !== tx.nonce
      || parsed.chainId !== BigInt(scope.chainId) || !same(parsed.from!, scope.publisher)
      || !parsed.to || !same(parsed.to, scope.source) || parsed.data !== entry.intent.calldata || parsed.value !== 0n) fail('PUBLICATION_TRANSACTION_MISMATCH');
    return tx;
  }
  return {
    async assertReady(entry) {
      await cutoff(entry); await ready(entry);
      await provider.call({ to: scope.source, from: scope.publisher, value: 0n, data: entry.intent.calldata });
      await cutoff(entry);
    },
    async prepare(entry) {
      const populated = await wallet.populateTransaction({ to: scope.source, value: 0n, data: entry.intent.calldata });
      return wallet.signTransaction(populated);
    },
    async broadcast(entry) {
      const tx = signed(entry);
      if ((await provider.broadcastTransaction(tx.raw)).hash !== tx.hash) fail('PUBLICATION_BROADCAST_UNCONFIRMED');
    },
    async observe(entry): Promise<PublicationObservation> {
      const call = await cutoff(entry);
      if (!entry.transaction) return { state: 'absent' };
      const tx = signed(entry), receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) return { state: 'absent' };
      if (receipt.hash !== tx.hash || !receipt.to || !same(receipt.to, scope.source) || !same(receipt.from, scope.publisher)
        || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 1 || !ethers.isHexString(receipt.blockHash, 32)
        || ![0, 1].includes(receipt.status ?? -1)) fail('PUBLICATION_RECEIPT_MISMATCH');
      const sourceTx = await provider.getTransaction(tx.hash);
      if (!sourceTx || sourceTx.nonce !== tx.nonce || sourceTx.data !== entry.intent.calldata || sourceTx.value !== 0n
        || sourceTx.chainId !== BigInt(scope.chainId) || !sourceTx.to || !same(sourceTx.to, scope.source)
        || !same(sourceTx.from, scope.publisher) || sourceTx.hash !== tx.hash) fail('PUBLICATION_RECEIPT_MISMATCH');
      const block = await provider.getBlock(receipt.blockNumber), head = await provider.getBlockNumber();
      if (!block || block.number !== receipt.blockNumber || block.hash !== receipt.blockHash || !Number.isSafeInteger(head) || head - receipt.blockNumber + 1 < confirmations) return { state: 'confirming' };
      if (receipt.status === 0 && receipt.logs.length) fail('PUBLICATION_RECEIPT_MISMATCH');
      if (receipt.status === 1) {
        const expected = PUBLICATION_ABI.encodeEventLog(PUBLICATION_ABI.getEvent('RosterEpochPublished')!, [
          call.args.epoch, call.args.root, call.args.listVersion, call.args.validUntil, call.args.sourceCutoff, block.timestamp, call.args.snapshotId,
        ]);
        const own = receipt.logs.filter(l => same(l.address, scope.source));
        const epochLogs = own.filter(l => l.topics[0] === expected.topics[0]);
        if (epochLogs.length !== 1 || epochLogs[0].data !== expected.data
          || JSON.stringify(epochLogs[0].topics) !== JSON.stringify(expected.topics)) fail('PUBLICATION_EVENT_MISMATCH');
        const issuers: string[] = call.name === 'publishEpoch' ? [scope.publisher] : call.args.approvals.map((a: { issuer: string }) => a.issuer.toLowerCase());
        const auth = PUBLICATION_ABI.getEvent('RosterIssuerAuthorized')!;
        const authLogs = own.filter(l => l.topics[0] === auth.topicHash);
        if (authLogs.length !== issuers.length || new Set(issuers).size !== issuers.length) fail('PUBLICATION_AUTH_EVENT_MISMATCH');
        for (const issuer of issuers) {
          const expectedAuth = PUBLICATION_ABI.encodeEventLog(auth, [call.args.epoch, call.args.root, issuer]);
          if (authLogs.filter(l => l.data === expectedAuth.data && JSON.stringify(l.topics) === JSON.stringify(expectedAuth.topics)).length !== 1) fail('PUBLICATION_AUTH_EVENT_MISMATCH');
        }
      }
      await cutoff(entry);
      const finalHead = await provider.getBlockNumber();
      if (!Number.isSafeInteger(finalHead) || finalHead - receipt.blockNumber + 1 < confirmations
        || (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) return { state: 'confirming' };
      return { state: 'confirmed', confirmation: { transactionHash: tx.hash, blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash, status: receipt.status as 0 | 1, confirmations: finalHead - receipt.blockNumber + 1, observedAt: Date.now() } };
    },
  };
}
