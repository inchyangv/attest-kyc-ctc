import { ethers } from 'ethers';

/**
 * Mirrors the packing in `src/lib/MarkAttrs.sol`, byte for byte.
 * A drift shifts every field of the on-chain mark. It fails quietly.
 * `pipeline/pipeline.test.ts` checks it against a fixed vector produced by Solidity.
 *
 *  bit 255..248 kind(8) · 247..240 assurance(8) · 239..224 regime(16)
 *      223..208 jurisdiction(16) · 207..176 methods(32)
 *      175..136 issuedAt(40)  135..96 expiry(40)  95..64 epoch(32)  63..0 reserved
 */
export interface MarkAttrsInput {
  kind: number;          // Positive credentials: 1 INDIVIDUAL · 2 ENTITY; denial uses a separate event.
  assurance: number;     // 1..5
  regime: number;
  jurisdiction: number;  // ISO-3166 numeric
  methods: number;
  issuedAt: number;      // epoch seconds
  expiry: number;        // epoch seconds
  epoch: number;
}

const LIMITS: Record<keyof MarkAttrsInput, bigint> = {
  kind: 0xffn, assurance: 0xffn, regime: 0xffffn, jurisdiction: 0xffffn,
  methods: 0xffffffffn, issuedAt: 0xffffffffffn, expiry: 0xffffffffffn, epoch: 0xffffffffn,
};

export const ATTRS_SCHEMA_VERSION = 0;
export const SUPPORTED_METHODS = 0x001f07ff;

/** Wire schema check, not a KYC/legal verdict. Jurisdiction checks numeric range, not ISO membership. */
export function validCredentialAttrs(attrs: string, now?: number): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(attrs)) return false;
  const a = unpackAttrs(attrs);
  return (BigInt(attrs) & 0xffffffffffffffffn) === 0n
    && (a.kind === 1 || a.kind === 2) && a.assurance >= 1 && a.assurance <= 5
    && (a.regime === 1 || a.regime === 2) && a.jurisdiction >= 1 && a.jurisdiction <= 999
    && (a.methods & ~SUPPORTED_METHODS) === 0 && a.issuedAt > 0 && a.expiry > a.issuedAt
    && (now === undefined || (Number.isSafeInteger(now) && now >= 0 && a.issuedAt <= now && a.expiry > now));
}

export function packAttrs(a: MarkAttrsInput): string {
  for (const [k, max] of Object.entries(LIMITS) as [keyof MarkAttrsInput, bigint][]) {
    if (!Number.isSafeInteger(a[k])) throw new Error(`packAttrs: ${k} must be a safe integer`);
    const v = BigInt(a[k]);
    if (v < 0n || v > max) throw new Error(`packAttrs: ${k}=${a[k]} is out of range (max ${max})`);
  }
  const v =
    (BigInt(a.kind)         << 248n) |
    (BigInt(a.assurance)    << 240n) |
    (BigInt(a.regime)       << 224n) |
    (BigInt(a.jurisdiction) << 208n) |
    (BigInt(a.methods)      << 176n) |
    (BigInt(a.issuedAt)     << 136n) |
    (BigInt(a.expiry)       <<  96n) |
    (BigInt(a.epoch)        <<  64n);
  return ethers.zeroPadValue(ethers.toBeHex(v), 32);
}

export function unpackAttrs(attrs: string): MarkAttrsInput {
  if (!/^0x[0-9a-fA-F]{64}$/.test(attrs)) throw new Error('unpackAttrs: expected exactly bytes32');
  const v = BigInt(attrs);
  const at = (shift: bigint, mask: bigint) => Number((v >> shift) & mask);
  return {
    kind:         at(248n, 0xffn),
    assurance:    at(240n, 0xffn),
    regime:       at(224n, 0xffffn),
    jurisdiction: at(208n, 0xffffn),
    methods:      at(176n, 0xffffffffn),
    issuedAt:     at(136n, 0xffffffffffn),
    expiry:       at( 96n, 0xffffffffffn),
    epoch:        at( 64n, 0xffffffffn),
  };
}
