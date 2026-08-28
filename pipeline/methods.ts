/**
 * 확인 행위 비트맵 — `src/lib/ProofmarkTypes.sol` 의 `Methods` 라이브러리와 **반드시 일치**해야 한다.
 * (pipeline/pipeline.test.ts 가 두 정의를 대조한다)
 */
export const Methods = {
  // 확인 행위
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
  // 심사 행위
  SANCTIONS_SCREENED:  1 << 16,
  PEP_SCREENED:        1 << 17,
  ADVERSE_MEDIA:       1 << 18,
  JURISDICTION_CHECK:  1 << 19,
  ONCHAIN_EXPOSURE:    1 << 20,
} as const;

export type MethodName = keyof typeof Methods;

export function describeMethods(mask: number): MethodName[] {
  return (Object.keys(Methods) as MethodName[]).filter((k) => (mask & Methods[k]) !== 0);
}
