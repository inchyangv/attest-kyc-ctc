import 'dotenv/config';
import { EvidenceVault } from '../pipeline/vault.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const vault = new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
const [command, id, outcome, ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(' ').trim();

if (command === 'list') {
  console.log(vault.counts());
} else if (command === 'decide') {
  if (!id || (outcome !== 'cleared' && outcome !== 'blocked') || !reason) {
    throw new Error('usage: vault:admin -- decide <recordId> <cleared|blocked> <reason>');
  }
  const record = vault.decideReview(id, {
    at: Date.now(),
    operator: process.env.COMPLIANCE_OPERATOR_ID ?? 'local-operator',
    outcome,
    reason,
  });
  console.log(`${record.id} -> ${record.state}`);
} else if (command === 'erase') {
  if (!id || !outcome) throw new Error('usage: vault:admin -- erase <recordId> <reason>');
  const eraseReason = [outcome, ...reasonParts].join(' ');
  console.log(vault.erase(id, eraseReason) ? `${id} erased` : `${id} not found`);
} else if (command === 'purge') {
  console.log(`purged ${vault.purgeExpired()} expired record(s)`);
} else {
  throw new Error('usage: vault:admin -- <list|decide|erase|purge> ...');
}
