import { readFileSync, statSync } from 'node:fs';

import {
  AuditEvidenceError,
  auditExportObservation,
  verifyAuditExport,
  type AuditExportEnvelopeV1,
  type AuditTrustConfig,
  type OnchainCommitmentObservationV1,
} from '../pipeline/audit-evidence.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function readBoundedJson(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_FILE_BYTES) throw new Error('INVALID_INPUT_FILE');
  return JSON.parse(readFileSync(path, 'utf8'));
}

const [exportPath, trustPath, observationPath] = process.argv.slice(2);
if (!exportPath || !trustPath || !observationPath || process.argv.length !== 5) {
  process.stderr.write('usage: npm run verify:audit-export -- <export.json> <public-trust-pins.json> <independent-onchain-observation.json>\n');
  process.exitCode = 2;
} else {
  try {
    const envelope = readBoundedJson(exportPath) as AuditExportEnvelopeV1;
    const trust = readBoundedJson(trustPath) as AuditTrustConfig;
    const observation = readBoundedJson(observationPath) as OnchainCommitmentObservationV1;
    const result = verifyAuditExport(envelope, trust, observation);
    process.stdout.write(`${JSON.stringify(auditExportObservation(result))}\n`);
  } catch (error) {
    const code = error instanceof AuditEvidenceError ? error.code : 'AUDIT_EXPORT_UNVERIFIED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
