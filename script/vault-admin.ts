import 'dotenv/config';
import { createHash } from 'node:crypto';
import { EvidenceVault, ReviewConflictError, type DeletionRequest } from '../pipeline/vault.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const vault = new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
const [command, id, outcome, ...reasonParts] = process.argv.slice(2);

if (command === 'list') {
  console.log(vault.counts());
} else if (command === 'outbox') {
  console.log(vault.listPendingRevocations().map(job => ({
    id: job.id, recordId: job.recordId, state: job.state, createdAt: job.createdAt,
    wallet: `${job.walletAddress.slice(0, 8)}…${job.walletAddress.slice(-4)}`,
    transactionHash: job.transaction?.hash, chainId: job.transaction?.chainId,
    source: job.transaction?.source, lastError: job.lastError,
  })));
  console.log(`legacy blocked records without outbox: ${vault.listLegacyBlocked().length}`);
} else if (command === 'review-snapshot' || command === 'decide') {
  try {
    if (!id) throw new Error('missing case');
    const caseDigest = createHash('sha256').update(id).digest('hex');
    if (command === 'review-snapshot') {
      if (outcome || reasonParts.length) throw new Error('unexpected argument');
      const snapshot = vault.reviewSnapshot(id), record = snapshot.record;
      console.log(JSON.stringify({ scope: 'local-review-snapshot', caseDigest, revision: snapshot.revision, state: record.state,
        createdAt: record.createdAt, lastScreenedAt: record.lastScreenedAt, reviews: record.reviews.length, rescreens: record.rescreens.length,
        identityEvidence: 'NOT_INCLUDED', operatorAuthentication: 'NOT_CHECKED' }));
    } else {
      if ((outcome !== 'cleared' && outcome !== 'blocked') || reasonParts.length !== 2) throw new Error('invalid decision arguments');
      const record = vault.decideReview(id, { at: Date.now(), operator: required('COMPLIANCE_OPERATOR_ID'), outcome, reason: reasonParts[1] }, reasonParts[0]);
      console.log(JSON.stringify({ caseDigest, state: record.state, operatorAuthentication: 'NOT_CHECKED', currentEnforcement: 'NOT_CHECKED' }));
    }
  } catch (error) {
    console.error(error instanceof ReviewConflictError ? error.message : 'REVIEW_OPERATION_UNAVAILABLE'); process.exitCode = 1;
  }
} else if (command === 'deletion-preview') {
  if (id) throw new Error('usage: vault:admin -- deletion-preview');
  console.log(vault.deletionPreview());
} else if (command === 'hold' || command === 'release-hold' || command === 'extend-retention') {
  if (!id || !outcome || reasonParts.length !== 1) throw new Error(`usage: vault:admin -- ${command} <recordId> <holdId|untilUnixMs> <caseRef>`);
  const operator = required('COMPLIANCE_OPERATOR_ID');
  if (command === 'hold') vault.placeHold(id, outcome, operator, reasonParts[0]);
  else if (command === 'release-hold') vault.releaseHold(id, outcome, operator, reasonParts[0]);
  else {
    if (!/^\d+$/.test(outcome)) throw new Error('retention deadline must be integer Unix milliseconds');
    vault.extendRetention(id, Number(outcome), operator, reasonParts[0]);
  }
  console.log(`${command} recorded; previous deletion requests are invalidated`);
} else if (command === 'request-deletion') {
  const [disposition, serviceRef, mode] = reasonParts;
  if (!id || !outcome || reasonParts.length !== 3 || !['unchanged', 'source-revoked', 'not-issued'].includes(disposition)
    || !['manual', 'automatic'].includes(mode)) throw new Error('usage: vault:admin -- request-deletion <recordId> <policyRef> <unchanged|source-revoked|not-issued> <serviceDecisionRef> <manual|automatic>');
  console.log(vault.requestDeletion(id, { operator: required('COMPLIANCE_OPERATOR_ID'), policyRef: outcome, serviceRef,
    disposition: disposition as DeletionRequest['disposition'], automatic: mode === 'automatic' }));
} else if (command === 'approve-deletion') {
  if (!id || !outcome || reasonParts.length) throw new Error('usage: vault:admin -- approve-deletion <recordId> <requestId>');
  vault.approveDeletion(id, outcome, required('COMPLIANCE_OPERATOR_ID'));
  console.log('local deletion approved; operator labels are not authenticated identities');
} else if (command === 'erase') {
  if (!id || !outcome || reasonParts.length !== 1 || reasonParts[0] !== '--execute') throw new Error('usage: vault:admin -- erase <recordId> <approvedRequestId> --execute');
  console.log(vault.erase(id, outcome) ? `${id} removed from current vault only; journal, backups, outbox and onchain data are not erased` : `${id} not found`);
} else if (command === 'purge') {
  if (outcome || reasonParts.length || (id && id !== '--execute')) throw new Error('usage: vault:admin -- purge [--execute]');
  if (id === '--execute') console.log(`purged ${vault.purgeExpired()} approved automatic record(s) from current vault only; not global deletion`);
  else console.log(vault.deletionPreview());
} else {
  throw new Error('usage: vault:admin -- <list|outbox|review-snapshot|decide|deletion-preview|hold|release-hold|extend-retention|request-deletion|approve-deletion|erase|purge> ...');
}
