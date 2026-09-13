import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { EvidenceVault, type VaultCommitmentObservation, type VaultRestoreRequirements } from '../pipeline/vault.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value;
};
const integer = (value: string | undefined, name: string): number => {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is out of range`); return parsed;
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const [command, ...args] = process.argv.slice(2);
const path = required('EVIDENCE_VAULT_PATH'), secret = required('EVIDENCE_VAULT_KEY');

if (command === 'backup') {
  if (args.length !== 1) throw new Error('usage: vault:recovery -- backup <newBackupPath>');
  console.log(JSON.stringify(new EvidenceVault(path, secret).createBackup(args[0])));
} else if (command === 'restore') {
  if (args.length !== 4 || args[3] !== '--execute') {
    throw new Error('usage: vault:recovery -- restore <backupPath> <newDestinationPath> <requirementsJson> --execute');
  }
  const result = EvidenceVault.restoreBackup(args[0], args[1], secret, readJson<VaultRestoreRequirements>(args[2]));
  console.log(JSON.stringify({ ...result.manifest, matchedCommitments: result.matchedCommitments }));
} else if (command === 'rotate-key') {
  if (args.length !== 1 || args[0] !== '--execute') throw new Error('usage: vault:recovery -- rotate-key --execute');
  const result = new EvidenceVault(path, secret).rotateKey(required('EVIDENCE_VAULT_NEXT_KEY'), required('VAULT_KEY_CUSTODIAN_ID'));
  console.log(JSON.stringify(result));
} else if (command === 'drill') {
  if (args.length !== 6 || args[5] !== '--execute') {
    throw new Error('usage: vault:recovery -- drill <newBackupPath> <newDestinationPath> <commitmentsJson> <maxRpoMs> <maxRtoMs> --execute');
  }
  const maxRpoMs = integer(args[3], 'maxRpoMs'), maxRtoMs = integer(args[4], 'maxRtoMs');
  const vault = new EvidenceVault(path, secret), manifest = vault.createBackup(args[0]);
  const restoreStartedAt = Date.now(), rpoMs = restoreStartedAt - manifest.createdAt;
  const commitments = readJson<VaultCommitmentObservation[]>(args[2]);
  const restored = EvidenceVault.restoreBackup(args[0], args[1], secret, { expectedBackupId: manifest.backupId,
    expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision, commitments, erasedRecordIds: [] });
  const rtoMs = Date.now() - restoreStartedAt;
  if (rpoMs > maxRpoMs || rtoMs > maxRtoMs) throw new Error('VAULT_RECOVERY_OBJECTIVE_MISSED');
  console.log(JSON.stringify({ backupId: manifest.backupId, revision: manifest.revision, stateCommitment: manifest.stateCommitment,
    matchedCommitments: restored.matchedCommitments, rpoMs, rtoMs, objectives: 'MET' }));
} else {
  throw new Error('usage: vault:recovery -- <backup|restore|rotate-key|drill> ...');
}
