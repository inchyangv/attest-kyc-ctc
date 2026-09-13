/**
 * Bitmap of checks. Must match the `Methods` library in `src/lib/ProofmarkTypes.sol`.
 * pipeline/pipeline.test.ts compares the two definitions.
 */
export const Methods = {
  //   // Identity checks
  WALLET_CONTROL:      1 << 0,
  ID_DOC_IMAGE:        1 << 1,
  ID_DOC_AUTHENTICITY: 1 << 2,
  FACE_MATCH:          1 << 3,
  LIVENESS:            1 << 4,
  BANK_ACCOUNT:        1 << 5,
  MOBILE_CARRIER:      1 << 6,
  VIDEO_CALL:          1 << 7,
  IN_PERSON:           1 << 8,
  EPASSPORT_NFC:       1 << 9,
  GOV_EID:             1 << 10,
  //   // Screening checks
  SANCTIONS_SCREENED:  1 << 16,
  PEP_SCREENED:        1 << 17,
  ADVERSE_MEDIA:       1 << 18,
  JURISDICTION_CHECK:  1 << 19,
  ONCHAIN_EXPOSURE:    1 << 20, // not earned by exact wallet-list lookup; built-in engine leaves unset
} as const;

export type MethodName = keyof typeof Methods;

export function describeMethods(mask: number): MethodName[] {
  return (Object.keys(Methods) as MethodName[]).filter((k) => (mask & Methods[k]) !== 0);
}
