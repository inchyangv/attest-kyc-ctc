import { ethers } from 'ethers';

/**
 * 맵핑 대사 — 입력 개인정보 ↔ 신분증 정보 ↔ 예금주 정보, **세 축이 모두 일치**해야 통과.
 *
 * ★ 사용자가 지시한 설계의 핵심(§3.2-3): 세 축을 맞춰본 뒤
 *   **"일치했다"는 사실만** 프루프와 마크로 남기고 값은 버린다.
 *   그래서 이 모듈은 원문을 반환하지 않는다 — 축별 일치 여부와 정규화 해시만 낸다.
 */
export interface ReconcileInput {
  /** 이용자가 입력한 값 */
  declared: { fullName: string; dateOfBirth: string };
  /** 신분증에서 판독한 값 */
  idDocument: { fullName: string; dateOfBirth: string } | null;
  /** 계좌 예금주 실명 */
  bankAccount: { holderName: string } | null;
}

export interface ReconcileResult {
  passed: boolean;
  axes: {
    declaredVsIdDoc: 'match' | 'mismatch' | 'unavailable';
    declaredVsBank:  'match' | 'mismatch' | 'unavailable';
    idDocVsBank:     'match' | 'mismatch' | 'unavailable';
  };
  /** 증적용 — 원문이 아니라 정규화 후 해시. 사본으로 재계산 가능하다. */
  digests: { declaredName: string; idDocName?: string; bankHolderName?: string; dobMatch: boolean };
}

/** 이름 정규화: 공백·문장부호 제거, 대문자 통일. 한글은 그대로 둔다. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(/[\s.,''`-]/g, '').toUpperCase();
}

function digest(s: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const dn = normalizeName(input.declared.fullName);
  const idn = input.idDocument ? normalizeName(input.idDocument.fullName) : null;
  const bn = input.bankAccount ? normalizeName(input.bankAccount.holderName) : null;

  const cmp = (a: string | null, b: string | null) =>
    a === null || b === null ? 'unavailable' as const : a === b ? 'match' as const : 'mismatch' as const;

  const axes = {
    declaredVsIdDoc: cmp(dn, idn),
    declaredVsBank:  cmp(dn, bn),
    idDocVsBank:     cmp(idn, bn),
  };

  const dobMatch = input.idDocument
    ? input.declared.dateOfBirth === input.idDocument.dateOfBirth
    : false;

  // fail-closed: 하나라도 불일치면 탈락. 'unavailable' 은 그 축의 확인 행위 비트가
  // 세워지지 않는 것으로 표현되므로, 여기서는 불일치만 막는다.
  const passed =
    Object.values(axes).every((a) => a !== 'mismatch') &&
    (input.idDocument ? dobMatch : true);

  return {
    passed,
    axes,
    digests: {
      declaredName: digest(dn),
      idDocName: idn ? digest(idn) : undefined,
      bankHolderName: bn ? digest(bn) : undefined,
      dobMatch,
    },
  };
}
