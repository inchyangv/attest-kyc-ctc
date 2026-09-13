import { randomUUID } from 'node:crypto';
import { Transaction } from 'ethers';
import { IssuanceJournalError, type IssuanceEntry, type IssuanceJournal, type JournalSnapshot, type SignedIssuance, type SourceConfirmation } from './issuance-journal.js';
import { IssuanceBudgetError, type IssuanceBudget } from './issuance-budget.js';

export type IssuanceReceipt = { status: 'pending' } | { status: 'reverted'; confirmation: SourceConfirmation }
  | { status: 'success'; confirmation: SourceConfirmation };
export interface IssuanceTransport {
  assertTarget(entry: IssuanceEntry): Promise<void>;
  processed(entry: IssuanceEntry): Promise<boolean>;
  prepare(entry: IssuanceEntry): Promise<SignedIssuance>;
  broadcast(transaction: SignedIssuance): Promise<void>;
  receipt(entry: IssuanceEntry): Promise<IssuanceReceipt>;
  materialized(entry: IssuanceEntry, confirmation: SourceConfirmation): Promise<boolean>;
}
export interface IssuanceEvidenceSink {
  /** Idempotent: persist exactly this evidence, never regenerate salts or screening timestamps. */
  put(entry: IssuanceEntry): Promise<void>;
  assertMayBroadcast(entry: IssuanceEntry): Promise<void>;
  /** Persist source success before declaring source-confirmed; retry repairs interrupted writes. */
  sourceConfirmed(entry: IssuanceEntry, confirmation: SourceConfirmation): Promise<void>;
  materialized(entry: IssuanceEntry): Promise<void>;
}

const gasLimitOf = (transaction: SignedIssuance): bigint => {
  if (transaction.gasLimit && /^\d+$/.test(transaction.gasLimit)) return BigInt(transaction.gasLimit);
  try { return Transaction.from(transaction.raw).gasLimit; }
  catch { throw new IssuanceJournalError('GAS_LIMIT_MISSING'); }
};

/** One bounded step; callers/worker resume with the same request ID. No signature or broadcast is
 * attempted until the original payload is durable. The shared signer gate serializes different
 * requests while this one's nonce is unresolved. Errors preserve the last authoritative snapshot.
 */
export async function advanceIssuance(
  journal: IssuanceJournal, requestId: string, transport: IssuanceTransport, evidence: IssuanceEvidenceSink,
  options: { retryFailed?: boolean; now?: () => number; budget?: IssuanceBudget } = {},
): Promise<JournalSnapshot> {
  const now = options.now ?? Date.now;
  const owner = randomUUID();
  let budgetReservedThisPass = false;
  let snapshot = await journal.acquire(requestId, owner);
  let entry = snapshot.entry;
  const save = async () => {
    snapshot = await journal.save({ revision: snapshot.revision, entry }, owner);
    entry = snapshot.entry;
  };
  try {
    if (entry.phase === 'failed' && (!options.retryFailed || entry.lastError !== 'SOURCE_REVERTED')) return snapshot;
    if (entry.phase === 'prepared' && !entry.transaction && entry.outcome.status === 'ISSUED' && now() >= entry.prepareUntil) {
      entry.phase = 'failed'; entry.lastError = 'PREPARATION_EXPIRED'; await save(); return snapshot;
    }
    if (!entry.evidenceStored) {
      await evidence.put(entry);
      entry.evidenceStored = true;
      await save();
    }
    if (entry.outcome.status !== 'ISSUED') {
      entry.phase = 'failed'; entry.lastError = 'NOT_APPROVED'; await save(); return snapshot;
    }
    await transport.assertTarget(entry);
    if (entry.phase === 'failed') {
      if (!options.retryFailed || entry.lastError !== 'SOURCE_REVERTED') return snapshot;
      if (entry.transaction) entry.revertedTransactions.push({ hash: entry.transaction.hash, nonce: entry.transaction.nonce, at: now() });
      delete entry.transaction; delete entry.sourceConfirmation; delete entry.broadcastAcceptedAt;
      entry.phase = 'prepared'; delete entry.lastError;
      // Atomically reacquires the signer gate; a competing request may be using it by now.
      await save();
    }
    if (!entry.transaction) {
      if (now() >= entry.prepareUntil || entry.outcome.expiry * 1000 <= now()) {
        entry.phase = 'failed'; entry.lastError = 'PREPARATION_EXPIRED'; await save(); return snapshot;
      }
      if (await transport.processed(entry)) {
        entry.phase = 'failed'; entry.lastError = 'REQUEST_ALREADY_USED_UNRECONCILED'; await save(); return snapshot;
      }
      await evidence.assertMayBroadcast(entry);
      const transaction = await transport.prepare(entry);
      if (transaction.chainId !== entry.target.chainId || transaction.source.toLowerCase() !== entry.target.source.toLowerCase() || transaction.issuer.toLowerCase() !== entry.target.issuer.toLowerCase()) throw new IssuanceJournalError('TARGET_CONFLICT');
      if (options.budget) {
        await options.budget.reserve({ requestId: transaction.hash, issuer: entry.target.issuer, gasLimit: gasLimitOf(transaction) });
        budgetReservedThisPass = true;
      }
      entry.transaction = transaction;
      await save(); // stale lease, CAS failure or disk failure means these signed bytes MUST NOT leave.
    }
    if (options.budget && entry.transaction && !budgetReservedThisPass) {
      await options.budget.reserve({ requestId: entry.transaction.hash, issuer: entry.target.issuer, gasLimit: gasLimitOf(entry.transaction) });
    }
    let receipt = await transport.receipt(entry);
    if (receipt.status === 'pending') {
      await evidence.assertMayBroadcast(entry);
      entry.phase = 'submitted'; delete entry.sourceConfirmation;
      await save(); // durable broadcast intent, including the original hash/nonce.
      // The journal may be remote: recheck after that await, outside the broadcast catch.
      // A local evidence fence is not a lost network acknowledgement and must prevent send.
      await evidence.assertMayBroadcast(entry);
      try {
        await transport.broadcast(entry.transaction!);
        entry.broadcastAcceptedAt ??= now(); delete entry.lastError;
      } catch { entry.lastError = 'BROADCAST_UNCONFIRMED'; }
      await save();
      receipt = await transport.receipt(entry);
    }
    if (receipt.status === 'pending') return snapshot;
    if (options.budget) {
      if (!receipt.confirmation.gasUsed || !/^\d+$/.test(receipt.confirmation.gasUsed)) throw new IssuanceJournalError('GAS_USED_MISSING');
      await options.budget.reconcile({ requestId: entry.transaction!.hash, issuer: entry.target.issuer, gasUsed: BigInt(receipt.confirmation.gasUsed) });
    }
    if (receipt.status === 'reverted') {
      entry.phase = 'failed'; entry.lastError = 'SOURCE_REVERTED'; entry.sourceConfirmation = receipt.confirmation;
      await save(); return snapshot;
    }
    await evidence.sourceConfirmed(entry, receipt.confirmation);
    if (entry.phase === 'materialized') {
      // This is a historical propagation acknowledgement, not today's eligibility verdict.
      // Do not extend completed-journal retention on every status/resume request.
      await evidence.materialized(entry);
      return snapshot;
    }
    entry.phase = 'source-confirmed'; entry.sourceConfirmation = receipt.confirmation; delete entry.lastError;
    await save(); // source confirmation releases the shared signer gate, not the subject's gate.
    if (await transport.materialized(entry, receipt.confirmation)) {
      // The retained evidence state is part of completion. Keep the journal nonterminal and in
      // the recovery queue until activation is durable (or an ambiguous activation is replayed).
      // Writing `materialized` first could strand a pending vault record because terminal journal
      // entries are removed from the runner's pending set.
      await evidence.materialized(entry);
      entry.phase = 'materialized'; entry.materializedAt ??= now();
      delete entry.lastError;
      await save();
    }
    return snapshot;
  } catch (error) {
    // A failed save may have committed remotely despite the lost response. Never broadcast new
    // bytes or overwrite a higher revision based on this in-memory copy; the next call reloads it.
    if (error instanceof IssuanceJournalError || error instanceof IssuanceBudgetError) throw error;
    const current = await journal.get(requestId);
    if (!current) throw new IssuanceJournalError('NOT_FOUND');
    if (current.revision === snapshot.revision && current.entry.phase !== 'failed') {
      const safe = structuredClone(current);
      safe.entry.lastError = 'DEPENDENCY_UNAVAILABLE';
      snapshot = await journal.save(safe, owner);
    } else snapshot = current;
    return snapshot;
  } finally {
    // Failure leaves only a 30s request lease; the persistent signer gate remains until reconciled.
    await journal.release(requestId, owner).catch(() => {});
  }
}
