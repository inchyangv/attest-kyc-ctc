import type { AmlEngine } from './aml.js';
import { EvidenceVault, type RevocationJob } from './vault.js';

/** Preview never persists screening timestamps, state, outbox entries or retention purges. */
export async function screenDue(vault: EvidenceVault, engine: AmlEngine, options: { now: number; intervalMs: number; persist: boolean }) {
  // Capture interval-due records before the first await so a concurrent review/deletion is fenced
  // against the case the runner actually selected, as it was before list-trigger support.
  const selected = new Map(vault.listForRescreen(options.now, options.intervalMs).map(record => [record.id, record]));
  const listVersions = await engine.listVersions();
  if (!listVersions || typeof listVersions !== 'object' || Array.isArray(listVersions)
    || Object.entries(listVersions).some(([id, version]) => !id || !Number.isSafeInteger(version) || version < 0)) {
    throw new Error('INVALID_SCREENING_LIST_VERSIONS');
  }
  for (const record of vault.listForRescreen(options.now, options.intervalMs, listVersions)) {
    if (!selected.has(record.id)) selected.set(record.id, record);
  }
  const results = [];
  for (const record of selected.values()) {
    const result = await engine.screen(record.screeningSubject);
    const resultKeys = Object.keys(result.listVersions).sort(), currentKeys = Object.keys(listVersions).sort();
    if (resultKeys.length !== currentKeys.length
      || resultKeys.some((key, index) => key !== currentKeys[index] || result.listVersions[key] !== listVersions[key])) {
      throw new Error('SCREENING_LIST_VERSIONS_CHANGED');
    }
    if (options.persist) vault.recordRescreen(record.id, {
      at: options.now, decision: result.decision, reason: result.reviewReason, listVersions: result.listVersions,
    }, record);
    results.push({ recordId: record.id, walletAddress: record.walletAddress, decision: result.decision, riskBand: result.riskBand });
  }
  return results;
}

export interface RevocationTransport {
  assertJob(job: RevocationJob, transaction: NonNullable<RevocationJob['transaction']>): void;
  prepare(job: RevocationJob): Promise<NonNullable<RevocationJob['transaction']>>;
  receipt(transaction: NonNullable<RevocationJob['transaction']>): Promise<'success' | 'reverted' | null>;
  broadcast(transaction: NonNullable<RevocationJob['transaction']>): Promise<void>;
  wait(transaction: NonNullable<RevocationJob['transaction']>): Promise<'success' | 'reverted' | null>;
}

/** Legacy unbound jobs still require operator deployment reconciliation. Never retarget a bound job. */
export function assertRevocationTarget(job: RevocationJob, target: { chainId: number; source: string }): void {
  if (job.sourceTarget && (job.sourceTarget.chainId !== target.chainId || job.sourceTarget.source.toLowerCase() !== target.source.toLowerCase())) {
    throw new Error('revocation target does not match retained source issuance');
  }
}

/** Caller must hold the single-runner lease. Sign -> durable prepare -> broadcast -> reconcile.
 * Re-broadcasts use the identical signed transaction/nonce; a timeout never authorizes a new one.
 * Confirmation here is SOURCE confirmation, not proof that the hub has enforced the revocation.
 */
export async function deliverRevocations(vault: EvidenceVault, transport: RevocationTransport, now = Date.now) {
  vault.assertWritable();
  let confirmed = 0;
  let failed = 0;
  for (let job of vault.listPendingRevocations()) {
    try {
      if (!job.transaction) job = vault.prepareRevocation(job.id, await transport.prepare(job));
      const transaction = job.transaction!;
      transport.assertJob(job, transaction);
      let receipt = await transport.receipt(transaction);
      if (receipt === null) {
        vault.assertWritable();
        try { await transport.broadcast(transaction); }
        catch {
          // Includes "already known" and a crash after the original broadcast. Reconcile by hash.
        }
        receipt = await transport.wait(transaction);
      }
      if (receipt === 'success') {
        vault.finishRevocation(job.id, now());
        confirmed++;
      } else {
        vault.failRevocation(job.id, receipt === 'reverted' ? 'source transaction reverted' : 'source confirmation pending', receipt === 'reverted');
        failed++;
        // Preserve ordering/nonces; do not sign later jobs behind an unknown pending transaction.
        if (receipt === null) break;
      }
    } catch {
      vault.failRevocation(job.id, 'transport or persistence failure; reconcile by stored transaction hash');
      failed++;
      break;
    }
  }
  return { confirmed, failed, pending: vault.listPendingRevocations().length };
}
