import { Methods } from '../methods.js';

/**
 * Korean jurisdiction adapter: ID document verification plus bank account verification
 * through a one-won transfer. That pairing is methods 1 and 4 of the FSC non-face-to-face
 * identification guidance, which requires two independent checks.
 *
 * Vendor connectivity decides which methods bits get set. The document authenticity API and
 * the one-won transfer both need institutional agreements and an open banking partnership.
 * Until those exist the adapter runs in sandbox mode and leaves those bits unset. Setting
 * them would be a lie, and a zero bit is what lets a consumer policy filter the mark out.
 */
export const Regime = {
  /** Vendors connected */
  KR_FSC_NONFACE: 1,
  /** No vendors. Same procedure, but the external lookups are mocked. */
  KR_FSC_NONFACE_SANDBOX: 2,
} as const;

export interface IdDocumentVendor {
  /** Reads the document and queries the issuing authority for authenticity */
  verify(image: Uint8Array): Promise<{
    fullName: string;
    dateOfBirth: string;
    docHash: string;
    authenticityChecked: boolean;   // did the issuing authority actually get queried
    faceMatched: boolean;
    livenessPassed: boolean;
  }>;
}

export interface BankAccountVendor {
  /** One-won transfer, then a check on the account holder name */
  verifyHolder(bank: string, account: string): Promise<{
    holderName: string;
    verified: boolean;              // did the transfer and comparison actually happen
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

    // 0. wallet control. We do this ourselves, so it is always real.
    if (input.walletControlProven) methods |= Methods.WALLET_CONTROL;

    // 1. ID document
    let idDocument: KrAdapterResult['idDocument'] = null;
    if (this.idVendor && input.idImage) {
      const r = await this.idVendor.verify(input.idImage);
      idDocument = { fullName: r.fullName, dateOfBirth: r.dateOfBirth, docHash: r.docHash };
      methods |= Methods.ID_DOC_IMAGE;
      // set the bit only when the vendor reports it actually looked
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
      evidence.idDocument = { skipped: true, reason: this.idVendor ? 'no image supplied' : 'no vendor connected' };
    }

    // 2. bank account, via one-won transfer
    let bankAccount: KrAdapterResult['bankAccount'] = null;
    if (this.bankVendor && input.bank) {
      const r = await this.bankVendor.verifyHolder(input.bank.bankCode, input.bank.accountNumber);
      bankAccount = { holderName: r.holderName };
      if (r.verified) methods |= Methods.BANK_ACCOUNT;
      evidence.bankAccount = { verified: r.verified, bankCode: input.bank.bankCode };
    } else {
      evidence.bankAccount = { skipped: true, reason: this.bankVendor ? 'no account details supplied' : 'no vendor connected' };
    }

    return { regime: this.regime, methods, idDocument, bankAccount, evidence };
  }
}
