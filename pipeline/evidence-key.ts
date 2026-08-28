import { createHmac } from 'node:crypto';

/**
 * 증적 가명화 키.
 *
 * ★ 왜 평문 해시가 아니라 키드 HMAC 인가:
 *   **이름은 엔트로피가 낮다.** `keccak256("KIM")` 은 한 번 계산하면 끝이고,
 *   한국 성명 조합은 수십만 개 수준이라 무염 해시는 전수 대조로 몇 초 만에 뚫린다.
 *   평문 해시로 바꿔놓고 "PII 제거됨"이라 쓰면 그 자체가 과장이다(§15-7).
 *
 * ★ 이것은 **가명화이지 익명화가 아니다.**
 *   키 보유자(발급사)는 후보를 대조해 원문을 확인할 수 있고, **그게 의도다** — 감사 재현성.
 *   증적 파일만 유출되면 이름을 얻지 못한다. 정확히 이 선까지가 보장이다.
 *
 * ★ 기본값을 두지 않는다. 기본값이 있으면 누군가 그대로 배포한다.
 */
export function loadEvidenceKey(env: NodeJS.ProcessEnv = process.env): { key: string; keyId: string } {
  const key = env.EVIDENCE_HMAC_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'EVIDENCE_HMAC_KEY 가 없거나 너무 짧습니다(32자 이상). ' +
      '증적 가명화 키는 기본값을 두지 않습니다 — .env 에 설정하세요.',
    );
  }
  return { key, keyId: env.EVIDENCE_KEY_ID ?? 'k1' };
}

export function hmacDigest(key: string, value: string): string {
  // 정규화 후 HMAC — NFC/NFD 차이로 같은 이름이 다른 다이제스트가 되지 않게 한다
  return '0x' + createHmac('sha256', key).update(value.normalize('NFKC')).digest('hex');
}
