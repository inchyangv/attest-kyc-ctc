import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { assertRosterRecordVersion } from './roster-format.js';
import { ROSTER_WITNESS_ABI } from './roster-witness.js';
import { validCredentialAttrs } from './attrs.js';
import { buildRoster, inclusionProof, leafIndexOf, subjectKey, type RosterEntry } from './roster.js';

export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 100_000;
export interface RosterScope { sourceChainId: number; sourceChainKey: number; hubChainId: number; source: string; asc: string; registry: string }
export interface RosterBundle {
  bundleVersion: 1; rosterFormatVersion: 2; epochSchemaVersion: 2; rosterAuthVersion: 1;
  scope: RosterScope; epoch: number; root: string; listVersion: number;
  sourceCutoff: number; publishedAt: number; validUntil: number; snapshotId: string;
  approvedIssuers: string[]; entries: RosterEntry[];
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uint = (n: unknown, max: number, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && ethers.isHexString(value, 32) && value !== ethers.ZeroHash;
const address = (value: unknown): value is string => typeof value === 'string' && ethers.isAddress(value) && value !== ethers.ZeroAddress;
function exactKeys(value: object, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('unexpected roster bundle field; do not distribute raw evidence or PII');
}

function checkedBundle(value: unknown): RosterBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid roster bundle');
  const b = value as RosterBundle;
  assertRosterRecordVersion(b);
  exactKeys(b, ['bundleVersion', 'rosterFormatVersion', 'epochSchemaVersion', 'rosterAuthVersion', 'scope', 'epoch', 'root',
    'listVersion', 'sourceCutoff', 'publishedAt', 'validUntil', 'snapshotId', 'approvedIssuers', 'entries']);
  if (b.bundleVersion !== 1 || !b.scope || typeof b.scope !== 'object') throw new Error('invalid bundle version/scope');
  exactKeys(b.scope, ['sourceChainId', 'sourceChainKey', 'hubChainId', 'source', 'asc', 'registry']);
  if (!uint(b.scope.sourceChainId, Number.MAX_SAFE_INTEGER, 1) || !uint(b.scope.hubChainId, Number.MAX_SAFE_INTEGER, 1) ||
      !uint(b.scope.sourceChainKey, Number.MAX_SAFE_INTEGER, 1) || ![b.scope.source, b.scope.asc, b.scope.registry].every(address) || !uint(b.epoch, 0xffffffff, 1) ||
      !uint(b.listVersion, 0xffffffff) || !digest(b.root) || !digest(b.snapshotId) ||
      ![b.sourceCutoff, b.publishedAt, b.validUntil].every(t => uint(t, 0xffffffffff, 1)) ||
      b.publishedAt < b.sourceCutoff || b.publishedAt > b.sourceCutoff + 3600 || b.validUntil <= b.publishedAt || b.validUntil > b.sourceCutoff + 86400 ||
      !Array.isArray(b.entries) || b.entries.length > MAX_BUNDLE_ENTRIES ||
      !Array.isArray(b.approvedIssuers) || b.approvedIssuers.length < 1 || b.approvedIssuers.length > 16 || !b.approvedIssuers.every(address)) {
    throw new Error('invalid roster bundle scope/epoch/provenance/limits');
  }
  const approved = new Set(b.approvedIssuers.map(a => a.toLowerCase()));
  if (approved.size !== b.approvedIssuers.length) throw new Error('duplicate bundle issuer');
  for (const e of b.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('invalid bundle entry');
    exactKeys(e, ['subject', 'attrs', 'claimsRoot', 'evidenceHash', 'issuer']);
    if (!address(e.subject) || !address(e.issuer) || !validCredentialAttrs(e.attrs, b.sourceCutoff) ||
        !ethers.isHexString(e.claimsRoot, 32) || !ethers.isHexString(e.evidenceHash, 32) || !approved.has(e.issuer.toLowerCase())) throw new Error('invalid/unapproved bundle entry');
  }
  return b;
}

/** Select only public wire fields. Source records may contain additional operational material.
 * Bytes are reproducible after canonical subject/issuer sorting; the pin is NOT chain approval. */
export function exportRosterBundle(record: Omit<RosterBundle, 'bundleVersion' | 'scope'>, scope: RosterScope) {
  const { rosterFormatVersion, epochSchemaVersion, rosterAuthVersion, epoch, root, listVersion, sourceCutoff, publishedAt, validUntil, snapshotId } = record;
  const bundle = checkedBundle({ bundleVersion: 1, rosterFormatVersion, epochSchemaVersion, rosterAuthVersion,
    scope: { sourceChainId: scope.sourceChainId, sourceChainKey: scope.sourceChainKey, hubChainId: scope.hubChainId, source: ethers.getAddress(scope.source), asc: ethers.getAddress(scope.asc), registry: ethers.getAddress(scope.registry) },
    epoch, root: root.toLowerCase(), listVersion, sourceCutoff, publishedAt, validUntil, snapshotId: snapshotId.toLowerCase(),
    approvedIssuers: record.approvedIssuers.map(a => ethers.getAddress(a)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1),
    entries: record.entries.map(({ subject, attrs, claimsRoot, evidenceHash, issuer }) => ({ subject: ethers.getAddress(subject),
      attrs: attrs.toLowerCase(), claimsRoot: claimsRoot.toLowerCase(), evidenceHash: evidenceHash.toLowerCase(), issuer: ethers.getAddress(issuer) })) });
  const tree = buildRoster(bundle.entries);
  if (tree.root !== bundle.root) throw new Error('bundle entries do not reproduce root');
  bundle.entries = tree.entries;
  const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('roster bundle exceeds byte budget');
  return { bytes, contentHash: hash(bytes) };
}

/** Immutable in-memory reconstruction. Returned proofs are detached; caller mutation cannot
 * poison subsequent responses. No registry verdict, freshness claim, network or signer here. */
export function loadRosterBundle(bytes: Uint8Array, expectedContentHash: string) {
  if (!/^[0-9a-f]{64}$/.test(expectedContentHash) || bytes.length === 0 || bytes.length > MAX_BUNDLE_BYTES || hash(bytes) !== expectedContentHash) throw new Error('roster bundle size/content pin mismatch');
  const bundle = checkedBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const tree = buildRoster(bundle.entries);
  if (tree.root.toLowerCase() !== bundle.root.toLowerCase()) throw new Error('bundle root mismatch');
  // A fresh object is returned for metadata; tree/bundle are never exposed by reference.
  const metadata = () => structuredClone({ contentHash: expectedContentHash, bundleVersion: 1, scope: bundle.scope,
    epoch: bundle.epoch, root: tree.root, sourceCutoff: bundle.sourceCutoff, publishedAt: bundle.publishedAt,
    validUntil: bundle.validUntil, snapshotId: bundle.snapshotId, listVersion: bundle.listVersion,
    entryCount: tree.entries.length, chainValidation: 'not-performed' as const });
  const proof = (subject: string) => {
    if (!address(subject)) throw new Error('invalid proof subject');
    const normalized = ethers.getAddress(subject), key = subjectKey(normalized);
    let lo = 1, hi = tree.keys.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (tree.keys[mid] < key) lo = mid + 1; else hi = mid; }
    if (tree.keys[lo] !== key) {
      return { ...metadata(), kind: 'non-inclusion' as const, subject: normalized,
        meaning: 'absent-from-this-asserted-root-not-a-sanction-verdict', proof: {
          left: inclusionProof(tree, lo - 1), leftKey: tree.keys[lo - 1], leftMark: tree.marks[lo - 1],
          right: inclusionProof(tree, lo), rightKey: tree.keys[lo], rightMark: tree.marks[lo],
        } };
    }
    const entry = structuredClone(tree.entries[lo - 1]);
    const inclusion = inclusionProof(tree, leafIndexOf(lo - 1));
    const mark = { attrs: entry.attrs, claimsRoot: entry.claimsRoot, evidenceHash: entry.evidenceHash, issuer: entry.issuer };
    return { ...metadata(), kind: 'inclusion' as const, subject: normalized, mark, proof: inclusion,
      transaction: { chainId: bundle.scope.hubChainId, to: bundle.scope.registry,
        data: new ethers.Interface(ROSTER_WITNESS_ABI).encodeFunctionData('cacheRosterWitness', [normalized, mark, inclusion]) },
      submission: 'not-simulated-or-submitted' as const };
  };
  return { metadata, proof };
}
