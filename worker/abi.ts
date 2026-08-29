import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');

function abiOf(file: string, name: string): any[] {
  const p = join(outDir, file, `${name}.json`);
  try {
    return JSON.parse(readFileSync(p, 'utf8')).abi;
  } catch {
    throw new Error(`ABI not found: ${p}. Run 'forge build' first.`);
  }
}

/** Read ABIs from the build output. Hand-copied ABIs drift. */
export const COMPLIANCE_SOURCE_ABI = abiOf('ComplianceSource.sol', 'ComplianceSource');
export const PROOFMARK_ASC_ABI     = abiOf('ProofmarkASC.sol', 'ProofmarkASC');

/** Event name to ASC action code. See docs/04-event-schema.md section 1. */
export const EVENT_TO_ACTION: Record<string, number> = {
  MarkIssued: 0,
  MarkRevoked: 1,
  SanctionDenied: 2,
  RosterEpochPublished: 3,
};

export const WATCHED_EVENTS = Object.keys(EVENT_TO_ACTION);
