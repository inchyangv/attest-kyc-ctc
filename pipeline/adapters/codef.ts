import { publicEncrypt, constants as cryptoConstants } from 'node:crypto';
import {
  docHashOf, isoDate, validateIdInput, VendorError,
  type BankAccountVendor, type IdDocType, type IdDocumentInput, type IdDocumentOutcome,
  type IdDocumentVendor, type OcrFields, type TwoWayChallenge,
} from './kr.js';

/**
 * CODEF (codef.io) connector.
 *
 * Products used, with the menu codes from the developer guide:
 *   KR_PB_MW_035  주민등록 진위확인, 정부24            /v1/kr/public/mw/identity-card/check-status
 *   KR_PB_EF_001  운전면허 진위확인, 경찰청 교통민원24  /v1/kr/public/ef/driver-license/status
 *   KR_ETC_KYC_001 OCR 주민등록증                       /v1/kr/etc/a/kyc/registration-card
 *   KR_ETC_KYC_002 OCR 운전면허증                       /v1/kr/etc/a/kyc/drivers-license
 *   KR_BK_KSN_002 예금주명 인증(계좌 실명 인증)          /v1/kr/bank/a/account/holder-authentication
 *   KR_BK_KSN_003 계좌 인증(1원 이체)                    /v1/kr/bank/a/account/transfer-authentication
 *
 * Protocol, from the REST guide:
 *   token     POST https://oauth.codef.io/oauth/token, Basic clientId:clientSecret,
 *             grant_type=client_credentials&scope=read. Valid for a week; cached.
 *   request   POST {host}{path}, Bearer token, body = URL-encoded JSON. Response body is
 *             URL-encoded JSON as well: { result: { code, message, extraMessage, transactionId }, data }.
 *   CF-00000  success. CF-03002 with data.continue2Way = true means the institution wants a second
 *             leg (captcha, app approval). The second request repeats the first body plus
 *             is2Way: true, twoWayInfo: { jobIndex, threadIndex, jti, twoWayTimestamp } and the answer.
 *   RSA       fields marked "RSA 암호화" are encrypted with the account's publicKey, PKCS#1 v1.5, base64.
 *
 * Environments: sandbox answers from fixed sample data (not live); demo (development.codef.io)
 * queries the real institutions with a daily allowance; api is production. Bank products on demo
 * return random test data, so the bank vendor refuses to run anywhere but production.
 */
export type CodefEnv = 'sandbox' | 'demo' | 'api';

const HOSTS: Record<CodefEnv, string> = {
  sandbox: 'https://sandbox.codef.io',
  demo: 'https://development.codef.io',
  api: 'https://api.codef.io',
};
const OAUTH_URL = 'https://oauth.codef.io/oauth/token';

export interface CodefClientOptions {
  clientId: string;
  clientSecret: string;
  /** From 키 관리 on codef.io. Needed for any RSA field. */
  publicKey?: string;
  env: CodefEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CodefResult { code: string; message: string; extraMessage?: string; transactionId?: string }
export interface CodefResponse<T = Record<string, unknown>> { result: CodefResult; data: T }

export class CodefClient {
  readonly env: CodefEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: CodefClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error('CodefClient: clientId and clientSecret are required');
    this.env = opts.env;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get host(): string { return HOSTS[this.env]; }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: 'grant_type=client_credentials&scope=read',
    });
    const text = await res.text();
    if (!res.ok) throw new VendorError(`CODEF token request failed: HTTP ${res.status}`, 'TOKEN');
    const j = parseCodefBody(text) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new VendorError('CODEF token response carried no access_token', 'TOKEN');
    this.token = { value: j.access_token, expiresAt: this.now() + (j.expires_in ?? 604_800) * 1000 };
    return this.token.value;
  }

  /** RSA/PKCS#1 v1.5 with the account public key, base64. What the guide calls "RSA 암호화". */
  rsa(plain: string): string {
    if (!this.opts.publicKey) throw new VendorError('CODEF publicKey is required to encrypt this field', 'NO_PUBLIC_KEY');
    const pem = this.opts.publicKey.includes('BEGIN')
      ? this.opts.publicKey
      : `-----BEGIN PUBLIC KEY-----\n${this.opts.publicKey.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`;
    return publicEncrypt({ key: pem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8')).toString('base64');
  }

  /** A product request: URL-encoded JSON in, URL-encoded JSON out. Retries once on an expired token. */
  async request<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<CodefResponse<T>> {
    const send = async (token: string) => this.fetchImpl(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: encodeURIComponent(JSON.stringify(body)),
    });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    return this.parse<T>(res, path);
  }

  /** multipart upload, used by the OCR products. */
  async upload<T = Record<string, unknown>>(path: string, file: Uint8Array, filename: string, mime: string): Promise<CodefResponse<T>> {
    const form = new FormData();
    form.append('file', new Blob([file as BlobPart], { type: mime }), filename);
    const send = async (token: string) => this.fetchImpl(`${this.host}${path}`, {
      method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, body: form,
    });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    return this.parse<T>(res, path);
  }

  private async parse<T>(res: Response, path: string): Promise<CodefResponse<T>> {
    const text = await res.text();
    let j: CodefResponse<T>;
    try { j = parseCodefBody(text) as CodefResponse<T>; } catch {
      throw new VendorError(`CODEF ${path}: unreadable response (HTTP ${res.status})`, 'BAD_RESPONSE');
    }
    if (!j || typeof j !== 'object' || !j.result) throw new VendorError(`CODEF ${path}: no result envelope (HTTP ${res.status})`, 'BAD_RESPONSE');
    return j;
  }
}

/** Codef URL-encodes its JSON. Some responses (the token) are plain. Handle both. */
export function parseCodefBody(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  return JSON.parse(decodeURIComponent(t.replace(/\+/g, ' ')));
}

export const CODEF_OK = 'CF-00000';
export const CODEF_TWO_WAY = 'CF-03002';

function twoWayOf(r: CodefResponse<Record<string, unknown>>): TwoWayChallenge | null {
  const d = r.data as Record<string, unknown> | undefined;
  if (r.result.code !== CODEF_TWO_WAY || !d || d.continue2Way !== true) return null;
  const extra = (d.extraInfo ?? {}) as Record<string, unknown>;
  return {
    method: String(d.method ?? ''),
    jobIndex: Number(d.jobIndex ?? 0),
    threadIndex: Number(d.threadIndex ?? 0),
    jti: String(d.jti ?? ''),
    twoWayTimestamp: Number(d.twoWayTimestamp ?? 0),
    imageBase64: typeof extra.reqSecureNo === 'string' ? extra.reqSecureNo : undefined,
    message: r.result.message,
  };
}

/** Century from the seventh digit of a resident registration number. */
export function rrnToBirthDate(rrn: string): string | undefined {
  if (!/^\d{13}$/.test(rrn)) return undefined;
  const c = rrn[6];
  const century = '12'.includes(c) || '56'.includes(c) ? '19' : '34'.includes(c) || '78'.includes(c) ? '20' : '18';
  return `${century}${rrn.slice(0, 6)}`;
}

// ─── ID documents ──────────────────────────────────────────────────────────

/**
 * The issuer logs in to 정부24 / 교통민원24 and checks the customer's document. That is "3자인증" in
 * the guide: the login belongs to the issuer (its certificate, or an operator approving in an app),
 * the document belongs to the customer.
 *
 * Two ways to log in:
 *   cert    the issuer's 공동인증서 as files. One-shot; a corporate certificate gets a captcha leg.
 *   simple  간편인증: 카카오톡, PASS, 네이버 … on the operator's phone. Every check comes back once as
 *           CF-03002 / simpleAuth; the operator approves and the second leg completes it. Needs no
 *           certificate file, which is what makes it the quickest way to a live lookup.
 */
export interface CodefCertLogin {
  kind?: 'cert';
  /** "1" = der + key files, "pfx" = a single pfx file. Base64 strings. */
  certType: '1' | 'pfx';
  certFile: string;
  keyFile?: string;
  /** Plain text. Encrypted with the account public key on every request. */
  certPassword: string;
  /** The certificate holder as the authority knows it: a company name or a person's name. */
  loginUserName: string;
  /** Business registration number or resident number of the certificate holder. */
  loginIdentity: string;
}

export interface CodefSimpleLogin {
  kind: 'simple';
  /** 1 카카오톡 · 3 삼성패스 · 4 KB모바일 · 5 통신사(PASS) · 6 네이버 · 7 신한 · 8 toss · 9 하나 · 10 NH */
  level: string;
  /** Phone number of the person approving, digits only */
  phoneNo: string;
  /** 0 SKT · 1 KT · 2 LG U+, required for PASS */
  telecom?: '0' | '1' | '2';
  /** Name and resident number (13 digits) of the person approving */
  loginUserName: string;
  loginIdentity: string;
}

export type CodefLogin = CodefCertLogin | CodefSimpleLogin;

export class CodefIdDocumentVendor implements IdDocumentVendor {
  readonly name: string;

  constructor(private readonly client: CodefClient, private readonly login: CodefLogin) {
    if (login.kind === 'simple') {
      for (const k of ['level', 'phoneNo', 'loginUserName', 'loginIdentity'] as const) {
        if (!login[k]) throw new Error(`CodefIdDocumentVendor: login.${k} is required`);
      }
      if (!/^\d{13}$/.test(login.loginIdentity)) throw new Error('CodefIdDocumentVendor: simple login needs the approver\'s 13-digit resident number');
      if (login.level === '5' && !login.telecom) throw new Error('CodefIdDocumentVendor: PASS login needs login.telecom');
    } else {
      for (const k of ['certFile', 'certPassword', 'loginUserName', 'loginIdentity'] as const) {
        if (!login[k]) throw new Error(`CodefIdDocumentVendor: login.${k} is required`);
      }
      if (login.certType === '1' && !login.keyFile) throw new Error('CodefIdDocumentVendor: login.keyFile is required for certType "1"');
    }
    this.name = `codef:${client.env}`;
  }

  /** The sandbox answers from fixed sample data. Only demo and api reach the issuing authority. */
  get live(): boolean { return this.client.env !== 'sandbox'; }

  get loginKind(): 'cert' | 'simple' { return this.login.kind === 'simple' ? 'simple' : 'cert'; }

  private cert(l: CodefCertLogin): Record<string, string> {
    const c: Record<string, string> = {
      certType: l.certType,
      certFile: l.certFile,
      certPassword: this.client.rsa(l.certPassword),
    };
    if (l.certType === '1') c.keyFile = l.keyFile!;
    return c;
  }

  /** Login parameters for 정부24 (mw) and 교통민원24 (ef), whose codes differ. */
  private loginParams(product: 'mw' | 'ef'): Record<string, string> {
    const l = this.login;
    if (l.kind === 'simple') {
      const base: Record<string, string> = {
        loginType: product === 'mw' ? '6' : '5',
        loginTypeLevel: l.level,
        phoneNo: l.phoneNo.replace(/\D/g, ''),
        loginUserName: l.loginUserName,
      };
      if (l.telecom) base.telecom = l.telecom;
      if (product === 'mw') {
        // identityEncYn = Y applies to the login identity too: birth date in clear, tail encrypted
        base.loginBirthDate = l.loginIdentity.slice(0, 6);
        base.loginIdentity = this.client.rsa(l.loginIdentity.slice(6));
      } else {
        base.identity = l.loginIdentity;
      }
      return base;
    }
    return product === 'mw'
      ? { loginType: '0', ...this.cert(l) }
      : { loginType: '2', ...this.cert(l), loginUserName: l.loginUserName, identity: l.loginIdentity };
  }

  async ocr(image: Uint8Array, docType: IdDocType): Promise<OcrFields> {
    const path = docType === 'RRC' ? '/v1/kr/etc/a/kyc/registration-card' : '/v1/kr/etc/a/kyc/drivers-license';
    const r = await this.client.upload<Record<string, string>>(path, image, 'document.jpg', 'image/jpeg');
    if (r.result.code !== CODEF_OK) throw new VendorError(`OCR: ${r.result.message}`, r.result.code, r.result.transactionId);
    const d = r.data ?? {};
    const rrn = (d.resUserIdentity ?? '').replace(/\D/g, '') || undefined;
    return {
      docType,
      fullName: d.resUserName?.trim() || undefined,
      birthDate: rrn ? rrnToBirthDate(rrn) : undefined,
      rrn: docType === 'RRC' ? rrn : undefined,
      issueDate: (d.resIssueDate ?? '').replace(/\D/g, '') || undefined,
      licenseNumber: docType === 'DL' ? (d.resLicenseNo ?? '').replace(/\D/g, '') || undefined : undefined,
      serialNo: docType === 'DL' ? (d.resSerialNum ?? '').trim() || undefined : undefined,
    };
  }

  async verify(input: IdDocumentInput): Promise<IdDocumentOutcome> {
    validateIdInput(input);
    const docHash = docHashOf(input.image);
    const { path, body } = input.docType === 'RRC' ? this.residentCard(input) : this.driverLicence(input);
    if (input.twoWay) {
      const { jobIndex, threadIndex, jti, twoWayTimestamp, secureNo, simpleAuth } = input.twoWay;
      Object.assign(body, { is2Way: true, twoWayInfo: { jobIndex, threadIndex, jti, twoWayTimestamp } });
      if (secureNo !== undefined) Object.assign(body, { secureNo, secureNoRefresh: '0' });
      if (simpleAuth !== undefined) Object.assign(body, { simpleAuth });
    }

    const r = await this.client.request<Record<string, string>>(path, body);
    const challenge = twoWayOf(r);
    if (challenge) return { kind: 'two_way', challenge };
    if (r.result.code !== CODEF_OK) {
      throw new VendorError(`${r.result.message}${r.result.extraMessage ? ` (${r.result.extraMessage})` : ''}`, r.result.code, r.result.transactionId);
    }
    const code = String(r.data?.resAuthenticity ?? '');
    return {
      kind: 'verified',
      docType: input.docType,
      fullName: input.fullName.trim(),
      dateOfBirth: isoDate(input.birthDate),
      docHash,
      authenticityChecked: true,
      // "1" is genuine. For a licence, "2" means the number exists but the serial did not check out.
      authentic: code === '1',
      faceMatched: false,
      livenessPassed: false,
      vendor: this.name,
      live: this.live,
      ref: r.result.transactionId,
      code,
    };
  }

  private residentCard(i: IdDocumentInput) {
    return {
      path: '/v1/kr/public/mw/identity-card/check-status',
      body: {
        organization: '0002',
        ...this.loginParams('mw'),
        userName: i.fullName.trim(),
        identityEncYn: 'Y',
        birthDate: i.birthDate.slice(2),          // yymmdd
        identity: this.client.rsa(i.rrn!.slice(6)), // the last seven digits, RSA
        issueDate: i.issueDate!,
      } as Record<string, unknown>,
    };
  }

  private driverLicence(i: IdDocumentInput) {
    const n = i.licenseNumber!;
    return {
      path: '/v1/kr/public/ef/driver-license/status',
      body: {
        organization: '0001',
        ...this.loginParams('ef'),
        userName: i.fullName.trim(),
        birthDate: i.birthDate,
        licenseNo01: n.slice(0, 2),
        licenseNo02: n.slice(2, 4),
        licenseNo03: n.slice(4, 10),
        licenseNo04: n.slice(10, 12),
        serialNo: i.serialNo!,
      } as Record<string, unknown>,
    };
  }
}

// ─── Bank accounts ─────────────────────────────────────────────────────────

/** Codef's bank organisation code is the KFTC code with a leading zero. */
export const codefBankOrg = (bankCode: string) => `0${bankCode}`;

export class CodefBankAccountVendor implements BankAccountVendor {
  readonly name: string;

  /** Only production exists for these products; the constructor refuses anything else. */
  readonly live = true;

  constructor(private readonly client: CodefClient) {
    if (client.env !== 'api') {
      throw new Error('CodefBankAccountVendor: the demo and sandbox servers return random test data for the 1-won and '
        + 'holder products, so a result from them would set a bit for a transfer that never happened. '
        + 'Use CODEF_ENV=api (needs the 제휴 contract) or BANK_VENDOR=openbanking.');
    }
    this.name = 'codef:api';
  }

  async holderName(input: { bankCode: string; accountNumber: string; birthDate: string }) {
    const r = await this.client.request<{ name?: string }>('/v1/kr/bank/a/account/holder-authentication', {
      organization: codefBankOrg(input.bankCode),
      account: input.accountNumber,
      identity: input.birthDate,
    });
    if (r.result.code !== CODEF_OK) throw new VendorError(r.result.message, r.result.code, r.result.transactionId);
    return { holderName: r.data?.name?.trim() || null, ref: r.result.transactionId };
  }

  async oneWonTransfer(input: { bankCode: string; accountNumber: string; holderName: string }) {
    const r = await this.client.request<{ authCode?: string }>('/v1/kr/bank/a/account/transfer-authentication', {
      organization: codefBankOrg(input.bankCode),
      account: input.accountNumber,
      inPrintType: '0',   // four random digits as the depositor name
    });
    if (r.result.code !== CODEF_OK) throw new VendorError(r.result.message, r.result.code, r.result.transactionId);
    return { authCode: String(r.data?.authCode ?? '').trim(), ref: r.result.transactionId };
  }
}
