import { ethers } from 'ethers';
import { buildRoster, inclusionProof, leafIndexOf, type RosterEntry } from './roster.js';
import { assertRosterRecordVersion, requireRosterV2 } from './roster-format.js';

export const ROSTER_WITNESS_VERSION = 1;
export const ROSTER_WITNESS_ABI = [
  'function ROSTER_WITNESS_VERSION() view returns (uint256)',
  'function policyRequiresRoster(uint256 policyId) view returns (bool)',
  'function getRosterWitness(address subject) view returns (uint32 epoch,(bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash,address issuer) mark)',
  'function cacheRosterWitness(address subject,(bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash,address issuer) mark,(uint256 index,uint256 leafCount,bytes32[] siblings) inclusion)',
  'event RosterWitnessCached(address indexed subject,uint32 indexed epoch,bytes32 indexed root)',
] as const;

export async function requireRosterWitness(provider: ethers.Provider, registry: string): Promise<void> {
  await requireRosterV2(provider, registry);
  const contract = new ethers.Contract(registry, ROSTER_WITNESS_ABI, provider);
  const version = await contract.ROSTER_WITNESS_VERSION().catch(() => null);
  if (version !== 1n) throw new Error('unsupported or unavailable roster witness consumer; migrate registry and asset');
}

/** Encode only. No key, RPC, signature or transaction. Recorded metadata is not chain evidence:
 * the consumer must simulate on the intended Registry and explicitly submit the call there.
 * Inclusion is current-root checked on chain; encoding old evidence never refreshes its lifetime. */
export function encodeRosterWitness(record: {
  rosterFormatVersion?: number; epochSchemaVersion?: number; rosterAuthVersion?: number;
  root: string; entries: RosterEntry[];
}, subject: string) {
  assertRosterRecordVersion(record);
  if (!ethers.isAddress(subject) || subject === ethers.ZeroAddress) throw new Error('invalid witness subject');
  const tree = buildRoster(record.entries);
  if (tree.root.toLowerCase() !== record.root.toLowerCase()) throw new Error('recorded roster root does not match entries');
  const i = tree.entries.findIndex(entry => entry.subject.toLowerCase() === subject.toLowerCase());
  if (i < 0) throw new Error('subject is absent from recorded roster');
  const entry = tree.entries[i];
  const mark = { attrs: entry.attrs, claimsRoot: entry.claimsRoot, evidenceHash: entry.evidenceHash, issuer: entry.issuer };
  const inclusion = inclusionProof(tree, leafIndexOf(i));
  const args = [ethers.getAddress(subject), mark, inclusion] as const;
  return { root: tree.root, args, data: new ethers.Interface(ROSTER_WITNESS_ABI).encodeFunctionData('cacheRosterWitness', args) };
}
