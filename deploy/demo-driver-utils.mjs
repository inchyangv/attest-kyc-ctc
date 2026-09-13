import { deflateSync } from 'node:zlib';

/** Generated pixel fixture, not a government document or personal photo. */
export function syntheticDriverPng() {
  const width = 32, height = 24;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (1 + width * 3) + 1 + x * 3;
    scanlines[i] = 30; scanlines[i + 1] = (x + y) % 2 ? 210 : 80; scanlines[i + 2] = 140;
  }
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

export function isIsolatedDemoStatus(s) {
  return s?.demo === true && s.sandboxBits === true && s.id?.configured === true && s.bank?.configured === true
    && s.id.demo === true && s.bank.demo === true && s.id.live === false && s.bank.live === false
    && s.id.vendor === 'demo:id' && s.bank.vendor === 'demo:bank'
    && s.bankState?.configured === true && s.issuer?.configured === true && s.issuanceJournal?.configured === true
    && s.tokenKey?.configured === true && s.tokenKey.mode === 'versioned-dedicated';
}

/** Distinguish Direct materialization from readiness of a current roster consumer. */
export function assessDriverObservation(oc, expected) {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!oc || !same(oc.subject, expected.subject) || oc.observation?.chainId !== 102031
    || oc.registry?.compatible !== true || oc.registry.versions?.ROSTER_WITNESS_VERSION !== 1
    || typeof oc.tombstone !== 'boolean' || !Array.isArray(oc.policies)
    || oc.policies.some(p => !p || typeof p !== 'object' || Array.isArray(p))) return 'incompatible';
  const mark = oc.mark;
  if (!mark || mark.status !== 1) return oc.tombstone ? 'restricted' : 'awaiting-materialization';
  if (oc.tombstone) return 'restricted';
  if (mark.regime !== 2 || mark.assurance !== expected.assurance || !same(mark.issuer, expected.issuer)
    || !same(mark.claimsRoot, expected.claimsRoot) || !same(mark.evidenceHash, expected.evidenceHash)
    || mark.methodsHex !== expected.methodsHex || mark.expiry !== expected.expiry) return 'different-mark';
  const production = oc.policies?.find(p => p.id === 1), pilot = oc.policies?.find(p => p.id === 2);
  if (oc.policies.filter(p => p?.id === 1).length !== 1 || oc.policies.filter(p => p?.id === 2).length !== 1 ||
    !production || !pilot || production.requireRoster !== true || pilot.requireRoster !== true || production.frozen !== true || pilot.frozen !== true) return 'incompatible';
  if (!Number.isSafeInteger(oc.witness?.epoch) || oc.witness.epoch <= 0 || oc.witness.epoch !== oc.epoch?.latestEpoch ||
    oc.witness.issuerApproved !== true || oc.epoch.fresh !== true) return 'awaiting-current-witness';
  const w = oc.witness.mark;
  if (!w || !same(w.issuer, expected.issuer) || !same(w.claimsRoot, expected.claimsRoot)
    || !same(w.evidenceHash, expected.evidenceHash) || w.expiry !== expected.expiry || w.regime !== 2
    || w.assurance !== expected.assurance || w.methodsHex !== expected.methodsHex) return 'different-witness';
  return production.verified === false && pilot.verified === true && production.diagnosis === 'consistent' && pilot.diagnosis === 'consistent'
    ? 'api-roster-verdict-ready' : 'policy-rejected';
}
