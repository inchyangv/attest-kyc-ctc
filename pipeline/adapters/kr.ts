import { ethers } from 'ethers';
import { Methods } from '../methods.js';
import { normalizeName } from '../reconcile.js';
import { IdentityRequirement, type BiometricPolicyV1, type BiometricRequirement } from '../identity-policy.js';

/**
 * Korean jurisdiction adapter.
 *
 * FSC non-face-to-face identification asks for two independent checks. We use
 *   method 1  ID document: the image is captured, and the document is checked for authenticity
 *             with the issuing authority (Government24 for a resident registration card, the Korean National
 *             Police Agency's Traffic Civil Service 24 for a
 *             driver licence).
 *   method 4  an existing bank account: the holder's name is confirmed against the customer's
 *             real-name number, then one won is deposited with a code in the memo and the customer
 *             reads the code back.
 *
 * The adapter is vendor agnostic. `IdDocumentVendor` and `BankAccountVendor` are the two seams;
 * `codef.ts` and `openbanking.ts` are the connected implementations.
 *
 * A methods bit is set only from a vendor result that says the check actually ran and passed.
 * A vendor that is not configured cannot produce such a result, so the bit stays at zero and a
 * consumer policy filters the mark out. That is the property every test in this directory guards.
 */
export const Regime = {
  /** Vendors connected: the checks were performed against the issuing authority and a bank. */
  KR_FSC_NONFACE: 1,
  /** No vendors. Same procedure, but the external lookups did not happen. */
  KR_FSC_NONFACE_SANDBOX: 2,
} as const;

/** Resident registration card or driver licence. */
export type IdDocType = 'RRC' | 'DL';

/** Bank codes are the KFTC standard three-digit codes (`bank_code_std`). */
export const KR_BANKS: { code: string; name: string }[] = [
  { code: '004', name: 'KB Kookmin Bank' },
  { code: '088', name: 'Shinhan Bank' },
  { code: '020', name: 'Woori Bank' },
  { code: '081', name: 'Hana Bank' },
  { code: '011', name: 'NH NongHyup Bank' },
  { code: '003', name: 'IBK Industrial Bank of Korea' },
  { code: '023', name: 'SC First Bank Korea' },
  { code: '027', name: 'Citibank Korea' },
  { code: '090', name: 'KakaoBank' },
  { code: '089', name: 'K Bank' },
  { code: '092', name: 'Toss Bank' },
  { code: '002', name: 'Korea Development Bank' },
  { code: '007', name: 'Suhyup Bank' },
  { code: '031', name: 'iM Bank' },
  { code: '032', name: 'Busan Bank' },
  { code: '034', name: 'Kwangju Bank' },
  { code: '035', name: 'Jeju Bank' },
  { code: '037', name: 'Jeonbuk Bank' },
  { code: '039', name: 'Kyongnam Bank' },
  { code: '045', name: 'Korean Federation of Community Credit Cooperatives' },
  { code: '048', name: 'National Credit Union Federation of Korea' },
  { code: '050', name: 'Korea Federation of Savings Banks' },
  { code: '064', name: 'National Forestry Cooperative Federation' },
  { code: '071', name: 'Korea Post' },
];

export const isKrBankCode = (code: string) => KR_BANKS.some((b) => b.code === code);

// ─── ID document ───────────────────────────────────────────────────────────

export interface IdDocumentInput {
  docType: IdDocType;
  /** The captured document. Hashed into `docHash`; the bytes go to the vendor for OCR only. */
  image: Uint8Array;
  fullName: string;
  /** YYYYMMDD */
  birthDate: string;
  /** Resident registration number, 13 digits, RRC only. Never written anywhere. */
  rrn?: string;
  /** YYYYMMDD, RRC only */
  issueDate?: string;
  /** 12 digits, DL only */
  licenseNumber?: string;
  /** The anti-forgery serial printed under the small photo, DL only */
  serialNo?: string;
  /** Second leg of an additional authentication step the vendor asked for. */
  twoWay?: TwoWayContinuation;
}

/** What the issuing authority asked for before it would answer. Surfaced to the operator. */
export interface TwoWayChallenge {
  method: string;                 // 'secureNo' (captcha) | 'simpleAuth' (app approval) | …
  jobIndex: number;
  threadIndex: number;
  jti: string;
  twoWayTimestamp: number;
  /** Captcha image, base64, when method is secureNo */
  imageBase64?: string;
  message?: string;
}

export interface TwoWayContinuation {
  jobIndex: number;
  threadIndex: number;
  jti: string;
  twoWayTimestamp: number;
  secureNo?: string;
  simpleAuth?: '0' | '1';
}

export interface OcrFields {
  docType: IdDocType;
  fullName?: string;
  /** YYYYMMDD */
  birthDate?: string;
  rrn?: string;
  issueDate?: string;
  licenseNumber?: string;
  serialNo?: string;
}

export interface IdDocumentResult {
  docType: IdDocType;
  fullName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** keccak256 of the captured image */
  docHash: string;
  /** Did the issuing authority actually get queried */
  authenticityChecked: boolean;
  /** …and did it say the document is genuine and matches the holder */
  authentic: boolean;
  faceMatched: boolean;
  livenessPassed: boolean;
  vendor: string;
  /**
   * The lookup went to the real issuing authority. A vendor sandbox that answers from fixed
   * sample data reports false, and then no authenticity bit can come out of it.
   */
  live: boolean;
  /** Vendor transaction reference. Not personal data. */
  ref?: string;
  /** Vendor's own result code, for the evidence */
  code?: string;
}

export type IdDocumentOutcome =
  | ({ kind: 'verified' } & IdDocumentResult)
  | { kind: 'two_way'; challenge: TwoWayChallenge };

export interface IdDocumentVendor {
  readonly name: string;
  /** Reaches the real issuing authority, as opposed to a vendor sandbox with sample data. */
  readonly live: boolean;
  /** Must be declared before a vendor capable of collecting/processing biometrics is configured. */
  readonly biometricChecks: readonly BiometricRequirement[];
  /** Read the fields off the image so the customer does not type them. Optional. */
  ocr?(image: Uint8Array, docType: IdDocType): Promise<OcrFields>;
  /** Query the issuing authority. May come back asking for a second leg. */
  verify(input: IdDocumentInput): Promise<IdDocumentOutcome>;
}

// ─── Bank account ──────────────────────────────────────────────────────────

export interface BankAccountResult {
  bankCode: string;
  holderName: string;
  /** The bank confirmed the holder against the customer's real-name number */
  holderVerified: boolean;
  /** One won was deposited and the customer read the code back */
  oneWonVerified: boolean;
  vendor: string;
  /** Real banking rails. The Open Banking testbed answers with canned data and reports false. */
  live: boolean;
  ref?: string;
}

export interface BankAccountVendor {
  readonly name: string;
  /** Real banking rails, as opposed to a testbed that moves no money. */
  readonly live: boolean;
  /**
   * Holder name for the account, checked by the bank against the customer's real-name number (YYMMDD).
   * `declaredName` is what the customer typed; a real bank ignores it, the demo vendor echoes it.
   */
  holderName(input: { bankCode: string; accountNumber: string; birthDate: string; declaredName?: string }): Promise<{ holderName: string | null; ref?: string }>;
  /** Deposit one won. The code in the memo is what the customer reads back to us. */
  oneWonTransfer(input: { bankCode: string; accountNumber: string; holderName: string }): Promise<{ authCode: string; ref?: string }>;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export interface KrAdapterInput {
  walletControlProven: boolean;
  idDocument: IdDocumentResult | null;
  bankAccount: BankAccountResult | null;
}

export interface KrAdapterResult {
  regime: number;
  methods: number;
  /** Set when a check ran and failed. The pipeline must not issue. */
  rejected: string | null;
  idDocument: { fullName: string; dateOfBirth: string; docHash: string } | null;
  bankAccount: { holderName: string } | null;
  evidence: Record<string, unknown>;
}

export class VendorError extends Error {
  constructor(message: string, readonly code?: string, readonly ref?: string) {
    super(message);
    this.name = 'VendorError';
  }
}

export interface KrAdapterOptions {
  /**
   * Demo switch. When true, a result from a vendor that is not live (the demo vendor, a testbed,
   * a sandbox) still sets its bits. The mark then carries regime KR_FSC_NONFACE_SANDBOX, and the
   * evidence says `sandboxBits: true` and names the vendor, so nothing is hidden: the procedure ran,
   * the rails were not real. Off by default; production never turns it on.
   */
  sandboxBits?: boolean;
  /** Prior necessity/legal/approval decision. Omission is an explicit prohibition. */
  biometrics?: BiometricPolicyV1;
}

export class KrAdapter {
  constructor(
    readonly idVendor: IdDocumentVendor | null,
    readonly bankVendor: BankAccountVendor | null,
    readonly opts: KrAdapterOptions = {},
  ) {
    const biometrics = opts.biometrics;
    if (biometrics?.mode === 'authorized') {
      const refs = [biometrics.necessityRef, biometrics.legalBasisRef, biometrics.approvalRef];
      if (!biometrics.checks.length || refs.some(ref => !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/.test(ref))) {
        throw new VendorError('biometric authorization is incomplete', 'BIOMETRIC_POLICY_INVALID');
      }
    }
  }

  get connected(): boolean { return this.idVendor !== null && this.bankVendor !== null; }
  /** Configuration capability, not the provenance of results consumed by run(). */
  get live(): boolean { return this.connected && this.idVendor!.live && this.bankVendor!.live; }
  get regime(): number { return this.live ? Regime.KR_FSC_NONFACE : Regime.KR_FSC_NONFACE_SANDBOX; }
  get sandboxBits(): boolean { return this.opts.sandboxBits === true; }

  /** Step 1. Hash the image, ask the issuing authority, normalise the answer. */
  async verifyIdDocument(input: IdDocumentInput): Promise<IdDocumentOutcome> {
    if (!this.idVendor) throw new VendorError('no ID document vendor configured', 'NO_VENDOR');
    const declared = this.idVendor.biometricChecks;
    if (!Array.isArray(declared)) throw new VendorError('ID vendor did not declare its biometric capabilities', 'BIOMETRIC_POLICY_REQUIRED');
    if (declared.some(check => check !== IdentityRequirement.FACE_MATCH && check !== IdentityRequirement.LIVENESS)) {
      throw new VendorError('ID vendor declared an unknown biometric capability', 'BIOMETRIC_POLICY_INVALID');
    }
    const authorization = this.opts.biometrics ?? { mode: 'prohibited' };
    if (declared.length) {
      if (authorization.mode !== 'authorized'
        || declared.some(check => !authorization.checks.includes(check))
        || !authorization.necessityRef || !authorization.legalBasisRef || !authorization.approvalRef) {
        throw new VendorError('biometric processing is not authorized by prior necessity and legal-basis decisions', 'BIOMETRIC_NOT_AUTHORIZED');
      }
    }
    validateIdInput(input);
    return this.idVendor.verify(input);
  }

  async readIdDocument(image: Uint8Array, docType: IdDocType): Promise<OcrFields> {
    if (!this.idVendor?.ocr) throw new VendorError('the ID document vendor has no OCR', 'NO_OCR');
    return this.idVendor.ocr(image, docType);
  }

  /** Step 2a. Holder name from the bank, compared with what the customer declared. */
  async lookupHolder(input: { bankCode: string; accountNumber: string; birthDate: string; declaredName: string }):
      Promise<{ holderName: string; matches: boolean; ref?: string }> {
    if (!this.bankVendor) throw new VendorError('no bank account vendor configured', 'NO_VENDOR');
    if (!isKrBankCode(input.bankCode)) throw new VendorError(`unknown bank code ${input.bankCode}`, 'BAD_BANK');
    if (!/^\d{6}$/.test(input.birthDate)) throw new VendorError('birthDate must be YYMMDD', 'BAD_INPUT');
    const account = input.accountNumber.replace(/[^0-9]/g, '');
    if (account.length < 8 || account.length > 16) throw new VendorError('account number must be 8 to 16 digits', 'BAD_INPUT');
    const r = await this.bankVendor.holderName({ bankCode: input.bankCode, accountNumber: account, birthDate: input.birthDate, declaredName: input.declaredName });
    if (!r.holderName) throw new VendorError('the bank did not return a holder for this account and real-name number', 'NO_HOLDER', r.ref);
    return { holderName: r.holderName, matches: normalizeName(r.holderName) === normalizeName(input.declaredName), ref: r.ref };
  }

  /** Step 2b. One won with a code in the memo. */
  async sendOneWon(input: { bankCode: string; accountNumber: string; holderName: string }): Promise<{ authCode: string; ref?: string }> {
    if (!this.bankVendor) throw new VendorError('no bank account vendor configured', 'NO_VENDOR');
    const r = await this.bankVendor.oneWonTransfer({ ...input, accountNumber: input.accountNumber.replace(/[^0-9]/g, '') });
    if (!r.authCode) throw new VendorError('the transfer returned no code', 'NO_CODE', r.ref);
    return r;
  }

  /** Step 3. Turn the results into bits and evidence. Values stay out; only outcomes go in. */
  async run(input: KrAdapterInput): Promise<KrAdapterResult> {
    let methods = 0;
    let rejected: string | null = null;
    const realResults = input.idDocument?.live === true && input.idDocument.authenticityChecked === true && input.idDocument.authentic === true
      && input.bankAccount?.live === true && input.bankAccount.holderVerified === true && input.bankAccount.oneWonVerified === true;
    const regime = this.live && !this.sandboxBits && realResults ? Regime.KR_FSC_NONFACE : Regime.KR_FSC_NONFACE_SANDBOX;
    const evidence: Record<string, unknown> = { regime, configuredRegime: this.regime, regimeRule: 'kr-results-v2',
      vendorsConnected: this.connected, sandboxBits: this.sandboxBits, liveResultsComplete: realResults };
    // A result counts toward a bit when it came from real rails, or when the demo switch is on.
    const counts = (r: { live: boolean }) => r.live || this.sandboxBits;
    const biometricAllowed = (check: BiometricRequirement) => this.opts.biometrics?.mode === 'authorized'
      && this.opts.biometrics.checks.includes(check);

    // 0. wallet control. We do this ourselves, so it is always real.
    if (input.walletControlProven) methods |= Methods.WALLET_CONTROL;

    // 1. ID document
    let idDocument: KrAdapterResult['idDocument'] = null;
    const id = input.idDocument;
    if (id) {
      idDocument = { fullName: id.fullName, dateOfBirth: id.dateOfBirth, docHash: id.docHash };
      methods |= Methods.ID_DOC_IMAGE;
      // The bit needs all three: the authority was asked, it said yes, and it was the real authority.
      if (counts(id) && id.authenticityChecked && id.authentic) methods |= Methods.ID_DOC_AUTHENTICITY;
      if (id.authenticityChecked && !id.authentic) rejected = 'the issuing authority did not confirm the document';
      if (id.faceMatched && !biometricAllowed(IdentityRequirement.FACE_MATCH)) rejected = 'face match result was not authorized before biometric processing';
      if (id.livenessPassed && !biometricAllowed(IdentityRequirement.LIVENESS)) rejected = 'liveness result was not authorized before biometric processing';
      if (counts(id) && id.faceMatched && biometricAllowed(IdentityRequirement.FACE_MATCH)) methods |= Methods.FACE_MATCH;
      if (counts(id) && id.livenessPassed && biometricAllowed(IdentityRequirement.LIVENESS)) methods |= Methods.LIVENESS;
      evidence.idDocument = {
        docType: id.docType,
        docHash: id.docHash,
        vendor: id.vendor,
        live: id.live,
        ref: id.ref ?? null,
        code: id.code ?? null,
        authenticityChecked: id.authenticityChecked,
        authentic: id.authentic,
        faceMatched: id.faceMatched,
        livenessPassed: id.livenessPassed,
      };
    } else {
      evidence.idDocument = { skipped: true, reason: this.idVendor ? 'no document verified' : 'no vendor connected' };
    }

    // 2. bank account
    let bankAccount: KrAdapterResult['bankAccount'] = null;
    const bank = input.bankAccount;
    if (bank) {
      bankAccount = { holderName: bank.holderName };
      if (counts(bank) && bank.holderVerified && bank.oneWonVerified) methods |= Methods.BANK_ACCOUNT;
      evidence.bankAccount = {
        bankCode: bank.bankCode,
        vendor: bank.vendor,
        live: bank.live,
        ref: bank.ref ?? null,
        holderVerified: bank.holderVerified,
        oneWonVerified: bank.oneWonVerified,
      };
    } else {
      evidence.bankAccount = { skipped: true, reason: this.bankVendor ? 'no account verified' : 'no vendor connected' };
    }

    return { regime, methods, rejected, idDocument, bankAccount, evidence };
  }
}

// ─── helpers shared by the vendors ─────────────────────────────────────────

export function validateIdInput(i: IdDocumentInput): void {
  if (!i.image || i.image.length === 0) throw new VendorError('a document image is required', 'BAD_INPUT');
  if (!i.fullName?.trim()) throw new VendorError('fullName is required', 'BAD_INPUT');
  if (!/^\d{8}$/.test(i.birthDate)) throw new VendorError('birthDate must be YYYYMMDD', 'BAD_INPUT');
  if (i.docType === 'RRC') {
    if (!/^\d{13}$/.test(i.rrn ?? '')) throw new VendorError('rrn must be 13 digits', 'BAD_INPUT');
    if (!/^\d{8}$/.test(i.issueDate ?? '')) throw new VendorError('issueDate must be YYYYMMDD', 'BAD_INPUT');
    if (i.rrn!.slice(0, 6) !== i.birthDate.slice(2)) throw new VendorError('rrn and birthDate disagree', 'BAD_INPUT');
  } else if (i.docType === 'DL') {
    if (!/^\d{12}$/.test(i.licenseNumber ?? '')) throw new VendorError('licenseNumber must be 12 digits', 'BAD_INPUT');
    if (!/^[0-9A-Za-z]{5,6}$/.test(i.serialNo ?? '')) throw new VendorError('serialNo must be 5 or 6 characters', 'BAD_INPUT');
  } else {
    throw new VendorError(`unknown docType ${String(i.docType)}`, 'BAD_INPUT');
  }
}

export const docHashOf = (image: Uint8Array): string => ethers.keccak256(image);

/** YYYYMMDD → YYYY-MM-DD */
export const isoDate = (ymd8: string): string => `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;
/** YYYY-MM-DD → YYYYMMDD */
export const ymd8 = (iso: string): string => iso.replace(/-/g, '');
/** YYYYMMDD → YYMMDD */
export const ymd6 = (ymd: string): string => ymd.slice(2);
