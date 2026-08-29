import { createHmac } from 'node:crypto';

/**
 * Evidence pseudonymisation key.
 *
 * Why a keyed HMAC rather than a plain hash:
 * Names carry very little entropy. `keccak256("KIM")` is computed once and reused, and the
 * space of Korean names runs to a few hundred thousand, so an unsalted hash falls in seconds.
 * Switching to a plain hash and calling it "PII removed" would be the overstatement we avoid.
 *
 * This is pseudonymisation, not anonymisation.
 * The key holder can confirm a candidate, and that is the point: audits have to reproduce.
 * A leaked evidence file yields no names. That is exactly where the guarantee ends.
 *
 * No default. A default is what someone ships to production.
 */
export function loadEvidenceKey(env: NodeJS.ProcessEnv = process.env): { key: string; keyId: string } {
  const key = env.EVIDENCE_HMAC_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'EVIDENCE_HMAC_KEY is missing or shorter than 32 characters. ' +
      'The evidence key has no default. Set it in .env.',
    );
  }
  return { key, keyId: env.EVIDENCE_KEY_ID ?? 'k1' };
}

export function hmacDigest(key: string, value: string): string {
  // Normalise before the HMAC so NFC and NFD forms of one name do not diverge
  return '0x' + createHmac('sha256', key).update(value.normalize('NFKC')).digest('hex');
}
