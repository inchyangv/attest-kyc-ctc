/**
 * PII 유출 탐지 헬퍼 (테스트용).
 *
 * ★ 단순 `JSON.stringify(x).includes(name)` 은 **한글에서 실패한다.**
 *   정규화 형태가 다르면 같은 글자도 다른 코드포인트 열이 된다:
 *
 *     '박서준' NFC → U+BC15 U+C11C U+C900          (3 코드포인트)
 *     '박서준' NFD → U+1107 U+1161 U+11A8 …        (8 코드포인트, 자모 분해)
 *
 *   실제로 AML 엔진이 NFD 로 정규화한 이름을 증적에 넣었는데
 *   순진한 includes() 가 못 잡아 **유출이 없다고 잘못 보고했다.**
 *   양쪽을 같은 형태로 정규화한 뒤 비교해야 한다.
 */
export function containsPii(haystack: unknown, needle: string): boolean {
  const hay = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  if (!hay) return false;
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'] as const) {
    if (hay.normalize(form).includes(needle.normalize(form))) return true;
  }
  // 대소문자 차이도 흡수 (로마자 전개 대비)
  const lower = hay.normalize('NFKC').toLowerCase();
  if (lower.includes(needle.normalize('NFKC').toLowerCase())) return true;
  return false;
}

/** 여러 값 중 하나라도 들어 있으면 그 값을 돌려준다. */
export function findPii(haystack: unknown, needles: readonly string[]): string | null {
  for (const n of needles) if (containsPii(haystack, n)) return n;
  return null;
}
