import { Methods } from '../methods.js';

/**
 * 한국 관할 어댑터 — 신분증 인증 + 계좌 인증(1원 송금).
 * 금융위 「비대면 실명확인 방안」의 ①(신분증 사본) + ④(기존 계좌 활용) 복수 확인 조합.
 *
 * ⚠️ **벤더 연동 상태가 methods 비트를 결정한다.**
 *    신분증 진위확인 API 와 1원 송금은 기관 계약·오픈뱅킹 제휴가 필요하다.
 *    연동 전에는 `sandbox` 모드로 동작하며 **해당 비트를 세우지 않는다** —
 *    세우면 거짓말이고, 비트가 0이면 소비자 정책이 자동으로 거른다 (§4.2 · §15-4).
 */
export const Regime = {
  /** 실제 벤더 연동 완료 */
  KR_FSC_NONFACE: 1,
  /** 벤더 미연동 — 절차는 동일하나 외부 조회가 모의다 */
  KR_FSC_NONFACE_SANDBOX: 2,
} as const;

export interface IdDocumentVendor {
  /** 신분증 판독 + 발급기관 진위확인 조회 */
  verify(image: Uint8Array): Promise<{
    fullName: string;
    dateOfBirth: string;
    docHash: string;
    authenticityChecked: boolean;   // ★ 발급기관에 실제로 조회했는가
    faceMatched: boolean;
    livenessPassed: boolean;
  }>;
}

export interface BankAccountVendor {
  /** 1원 송금 후 예금주 실명 확인 */
  verifyHolder(bank: string, account: string): Promise<{
    holderName: string;
    verified: boolean;              // ★ 실제로 송금·대사했는가
  }>;
}

export interface KrAdapterResult {
  regime: number;
  methods: number;
  idDocument: { fullName: string; dateOfBirth: string; docHash: string } | null;
  bankAccount: { holderName: string } | null;
  evidence: Record<string, unknown>;
}

export class KrAdapter {
  constructor(
    private readonly idVendor: IdDocumentVendor | null,
    private readonly bankVendor: BankAccountVendor | null,
  ) {}

  get connected(): boolean { return this.idVendor !== null && this.bankVendor !== null; }
  get regime(): number { return this.connected ? Regime.KR_FSC_NONFACE : Regime.KR_FSC_NONFACE_SANDBOX; }

  async run(input: {
    idImage: Uint8Array | null;
    bank?: { bankCode: string; accountNumber: string };
    walletControlProven: boolean;
  }): Promise<KrAdapterResult> {
    let methods = 0;
    const evidence: Record<string, unknown> = { regime: this.regime, vendorsConnected: this.connected };

    // 0. 지갑 소유권 — 우리가 직접 하므로 언제나 실제다
    if (input.walletControlProven) methods |= Methods.WALLET_CONTROL;

    // 1. 신분증 인증
    let idDocument: KrAdapterResult['idDocument'] = null;
    if (this.idVendor && input.idImage) {
      const r = await this.idVendor.verify(input.idImage);
      idDocument = { fullName: r.fullName, dateOfBirth: r.dateOfBirth, docHash: r.docHash };
      methods |= Methods.ID_DOC_IMAGE;
      // ★ 벤더가 실제로 조회했다고 보고할 때만 비트를 세운다
      if (r.authenticityChecked) methods |= Methods.ID_DOC_AUTHENTICITY;
      if (r.faceMatched)         methods |= Methods.FACE_MATCH;
      if (r.livenessPassed)      methods |= Methods.LIVENESS;
      evidence.idDocument = {
        docHash: r.docHash,
        authenticityChecked: r.authenticityChecked,
        faceMatched: r.faceMatched,
        livenessPassed: r.livenessPassed,
      };
    } else {
      evidence.idDocument = { skipped: true, reason: this.idVendor ? '이미지 없음' : '벤더 미연동' };
    }

    // 2. 계좌 인증 (1원 송금)
    let bankAccount: KrAdapterResult['bankAccount'] = null;
    if (this.bankVendor && input.bank) {
      const r = await this.bankVendor.verifyHolder(input.bank.bankCode, input.bank.accountNumber);
      bankAccount = { holderName: r.holderName };
      if (r.verified) methods |= Methods.BANK_ACCOUNT;
      evidence.bankAccount = { verified: r.verified, bankCode: input.bank.bankCode };
    } else {
      evidence.bankAccount = { skipped: true, reason: this.bankVendor ? '계좌 정보 없음' : '벤더 미연동' };
    }

    return { regime: this.regime, methods, idDocument, bankAccount, evidence };
  }
}
