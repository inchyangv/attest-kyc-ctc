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
    throw new Error(`ABI 를 찾을 수 없습니다: ${p} — 먼저 'forge build' 를 실행하세요`);
  }
}

/** 컨트랙트 산출물을 단일 정본으로 쓴다 — ABI 를 손으로 복사하면 반드시 어긋난다. */
export const COMPLIANCE_SOURCE_ABI = abiOf('ComplianceSource.sol', 'ComplianceSource');
export const PROOFMARK_ASC_ABI     = abiOf('ProofmarkASC.sol', 'ProofmarkASC');

/** 이벤트 → ASC 액션 코드 (docs/04-event-schema.md §1) */
export const EVENT_TO_ACTION: Record<string, number> = {
  MarkIssued: 0,
  MarkRevoked: 1,
  SanctionDenied: 2,
  RosterEpochPublished: 3,
};

export const WATCHED_EVENTS = Object.keys(EVENT_TO_ACTION);
