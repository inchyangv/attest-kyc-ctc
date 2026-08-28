/**
 * 결정적 직렬화.
 *
 * ★ 증적 해시체인이 성립하려면 **같은 입력이 항상 같은 바이트**를 내야 한다.
 *   감사인이 오프체인 증적 사본으로 `evidenceHash` 를 재계산해 온체인 값과 대조하기 때문이다.
 *   JS 의 `JSON.stringify` 는 객체 키 순서를 삽입 순서로 따르므로 그대로 쓰면 안 된다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error('canonicalJson: 유한하지 않은 수는 증적에 넣을 수 없습니다');
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v instanceof Date) throw new Error('canonicalJson: Date 대신 epoch 정수를 쓰세요');

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortDeep((v as Record<string, unknown>)[k]);
  }
  return out;
}
