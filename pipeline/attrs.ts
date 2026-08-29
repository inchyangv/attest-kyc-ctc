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
  kind: number;          // 1 INDIVIDUAL · 2 ENTITY · 3 SANCTION
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

export function packAttrs(a: MarkAttrsInput): string {
  for (const [k, max] of Object.entries(LIMITS) as [keyof MarkAttrsInput, bigint][]) {
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
