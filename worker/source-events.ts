import type { Interface } from 'ethers';

export const TRANSACTION_PROCESSING_VERSION = 2;
export const EVENT_TO_ACTION: Record<string, number> = {
  MarkIssued: 0, KeyedMarkIssued: 0, MarkRevoked: 1, SanctionDenied: 2,
  RosterEpochPublished: 3, IssuerKeyCompromised: 4, SanctionDenialCorrected: 5,
};
export const WATCHED_EVENTS = Object.keys(EVENT_TO_ACTION);

export async function requireAtomicReceipts(readVersion: () => Promise<unknown>): Promise<void> {
  let version: unknown;
  try { version = await readVersion(); } catch {
    throw new Error('ASC does not expose atomic receipt processing v2; migrate before starting this worker');
  }
  if (Number(version) !== TRANSACTION_PROCESSING_VERSION) throw new Error(`unsupported ASC transaction processing version: ${version}`);
}

export async function requireIssuerKeyProvenance(
  readSourceVersion: () => Promise<unknown>, readAscVersion: () => Promise<unknown>,
): Promise<void> {
  let source: unknown, asc: unknown;
  try { [source, asc] = await Promise.all([readSourceVersion(), readAscVersion()]); }
  catch { throw new Error('issuer-key provenance unavailable; migrate source and ASC before starting this worker'); }
  if (Number(source) !== 1 || Number(asc) !== 1) throw new Error(`unsupported issuer-key provenance: source=${source} asc=${asc}`);
}

export async function requireDenialCorrection(
  readSourceVersion: () => Promise<unknown>, readAscVersion: () => Promise<unknown>,
): Promise<void> {
  let source: unknown, asc: unknown;
  try { [source, asc] = await Promise.all([readSourceVersion(), readAscVersion()]); }
  catch { throw new Error('denial-correction governance unavailable; migrate source and ASC before starting this worker'); }
  if (Number(source) !== 1 || Number(asc) !== 1) throw new Error(`unsupported denial-correction governance: source=${source} asc=${asc}`);
}

type SourceLog = { address: string; topics: readonly string[]; data: string; transactionHash: string; blockNumber: number; index: number };
/** One job per transaction; action is a present-event hint, not a receipt filter in ASC v2. */
export function groupSourceEvents(raw: SourceLog[], source: string, iface: Interface) {
  const groups = new Map<string, { txHash: string; blockNumber: number; action: number; eventName: string; logCount: number }>();
  const names = new Map<string, Set<string>>();
  for (const l of [...raw].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
    if (l.address.toLowerCase() !== source.toLowerCase()) continue;
    let parsed;
    try { parsed = iface.parseLog({ topics: [...l.topics], data: l.data }); } catch { continue; }
    if (!parsed || !WATCHED_EVENTS.includes(parsed.name)) continue;
    let job = groups.get(l.transactionHash);
    if (!job) {
      job = { txHash: l.transactionHash, blockNumber: l.blockNumber, action: EVENT_TO_ACTION[parsed.name], eventName: '', logCount: 0 };
      groups.set(l.transactionHash, job); names.set(l.transactionHash, new Set());
    }
    if (job.blockNumber !== l.blockNumber) throw new Error('inconsistent source transaction block');
    names.get(l.transactionHash)!.add(parsed.name);
    job.eventName = [...names.get(l.transactionHash)!].join('+'); job.logCount++;
  }
  return [...groups.values()];
}
