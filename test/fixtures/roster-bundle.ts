import { ethers } from 'ethers';
import { packAttrs } from '../../pipeline/attrs.js';
import { buildRoster } from '../../pipeline/roster.js';
import type { RosterBundle, RosterScope } from '../../pipeline/roster-bundle.js';

export function bundleFixture(count = 3) {
  const cutoff = 1_800_000_000;
  const scope: RosterScope = { sourceChainId: 11155111, sourceChainKey: 1, hubChainId: 102031,
    source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), registry: '0x' + '33'.repeat(20) };
  const issuer = '0x' + '44'.repeat(20);
  const attrs = packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 1 << 16, issuedAt: cutoff - 10, expiry: cutoff + 86400, epoch: 0 });
  const entries = Array.from({ length: count }, (_, i) => ({ subject: ethers.getAddress(ethers.toBeHex(i + 1, 20)), attrs,
    claimsRoot: ethers.id('synthetic-claims'), evidenceHash: ethers.id('synthetic-evidence'), issuer }));
  const record: Omit<RosterBundle, 'bundleVersion' | 'scope'> = { rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1,
    epoch: 1, root: buildRoster(entries).root, listVersion: 9, sourceCutoff: cutoff, publishedAt: cutoff + 10,
    validUntil: cutoff + 86400, snapshotId: ethers.id('synthetic-snapshot'), approvedIssuers: [issuer], entries };
  return { scope, record };
}
