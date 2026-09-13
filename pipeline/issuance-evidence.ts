import type { EvidenceVault } from './vault.js';
import { IssuanceJournalError, type IssuanceEntry } from './issuance-journal.js';
import type { IssuanceEvidenceSink } from './issuance-delivery.js';

export function issuanceEvidenceSink(
  resolve: (entry: IssuanceEntry) => EvidenceVault | null,
  assertScreeningCurrent: (entry: IssuanceEntry) => Promise<void> | void = () => {},
): IssuanceEvidenceSink {
  return {
    async put(entry) {
      const vault = resolve(entry);
      if (entry.evidenceRecord && !vault) throw new IssuanceJournalError('EVIDENCE_VAULT_UNAVAILABLE');
      vault?.put(entry.evidenceRecord!);
    },
    async assertMayBroadcast(entry) {
      // Recheck the exact screening snapshot at each pre-sign/pre-send fence. A durable
      // preparation is recovery evidence, not permission to use an older list generation.
      await assertScreeningCurrent(entry);
      const vault = resolve(entry);
      if (!vault) {
        if (entry.evidenceRecord) throw new IssuanceJournalError('EVIDENCE_VAULT_UNAVAILABLE');
        return; // sandbox: the mandatory encrypted journal itself holds the original evidence
      }
      // Previously durable evidence does not authorize a send after a later ambiguous write.
      // This also checks the retained lock when resuming through a new vault instance.
      vault.assertWritable();
      const record = vault.get(entry.requestId);
      if (!record || record.evidenceHash !== entry.outcome.evidenceHash || record.retentionUntil <= Date.now()
        || (record.state !== 'pending' && record.state !== 'active')) throw new IssuanceJournalError('EVIDENCE_NOT_AUTHORIZED');
    },
    async sourceConfirmed(entry, confirmation) {
      const vault = resolve(entry);
      if (!vault) {
        if (entry.evidenceRecord) throw new IssuanceJournalError('EVIDENCE_VAULT_UNAVAILABLE');
        return;
      }
      if (entry.outcome.status !== 'ISSUED' || !entry.transaction) throw new IssuanceJournalError('SOURCE_CONFIRMATION_UNAVAILABLE');
      vault.recordSourceConfirmation(entry.requestId, entry.outcome.evidenceHash, {
        transactionHash: entry.transaction.hash, chainId: entry.target.chainId, source: entry.target.source,
        observedAt: confirmation.confirmedAt,
      });
    },
    async materialized(entry) {
      const vault = resolve(entry);
      if (entry.evidenceRecord && !vault) throw new IssuanceJournalError('EVIDENCE_VAULT_UNAVAILABLE');
      vault?.recordMaterialization(entry.requestId, entry.outcome.evidenceHash);
    },
  };
}
