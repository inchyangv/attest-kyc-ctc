/**
 * FATF 관할 위험. 총회마다 바뀌므로 원문 대조 상태를 함께 싣는다.
 * verified=false 인 채로 쓰면 증적에 '미검증'으로 기록된다 — 근거 없는 확신을 남기지 않는다.
 */
export interface JurisdictionTable {
  source: string;
  asOf: string;
  verified: boolean;          // fatf-gafi.org 최신 총회 결과와 눈으로 대조했는가
  callForAction: string[];    // 대응조치 요구 (구 블랙리스트)
  increasedMonitoring: string[]; // 강화 모니터링 (구 그레이리스트)
}

export const FATF: JurisdictionTable = {
  source: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions.html',
  asOf: '2026-08-30',
  verified: false,            // ⚠️ 원문 대조 전이다. 화면·증적에 '미검증'으로 표기된다
  callForAction: ['KP', 'IR', 'MM'],
  increasedMonitoring: [
    'BF','CM','HR','CD','HT','ML','MZ','MC','NA','NP','NG','PH','SN','ZA','SS','SY','TZ','TR','VU','VE','VN','YE',
  ],
};

export function jurisdictionRisk(iso2: string): { level: 0 | 1 | 2; reason: string } {
  const c = (iso2 ?? '').toUpperCase();
  if (FATF.callForAction.includes(c))       return { level: 2, reason: 'FATF 대응조치 요구 관할' };
  if (FATF.increasedMonitoring.includes(c)) return { level: 1, reason: 'FATF 강화 모니터링 관할' };
  return { level: 0, reason: '' };
}
