import { createHash, randomBytes } from 'node:crypto';
import { VendorError, type BankAccountVendor } from './kr.js';
import { VendorHttp, VendorTokenCache, VendorTransportError, VENDOR_HTTP_LIMITS, parseVendorJson, vendorTimeouts } from './vendor-http.js';

/**
 * Korea Financial Telecommunications and Clearings Institute (KFTC) Open Banking connector,
 * for the bank-account axis.
 *
 *   token         POST /oauth/2.0/token  client_id, client_secret, scope=oob, grant_type=client_credentials
 *                 The two-legged token a participating institution uses when no customer is logged in.
 *   holder name   POST /v2.0/inquiry/real_name     real-name inquiry: the bank checks the account against the
 *                 customer's real-name number (first six digits) and returns the holder's name.
 *   one won       POST /v2.0/transfer/deposit/acnt_num  deposit transfer from the institution's contracted account
 *                 to the customer's account, one won, with our code in print_content.
 *
 * bank_tran_id is the institution use code (10) + 'U' + 9 characters, unique per call. tran_dtime is KST.
 * rsp_code A0000 is success; for a deposit the bank's own bank_rsp_code must also be 000.
 *
 * The testbed (testapi.openbanking.or.kr) answers with canned data and moves no money, so results
 * from it carry live = false and set no bit. Production requires registration as a participating institution with KFTC.
 */
export type OpenBankingEnv = 'test' | 'prod';

const HOSTS: Record<OpenBankingEnv, string> = {
  test: 'https://testapi.openbanking.or.kr',
  prod: 'https://openapi.openbanking.or.kr',
};

export interface OpenBankingOptions {
  clientId: string;
  clientSecret: string;
  /** Institution use code, ten characters, e.g. M202300440. */
  clientUseCode: string;
  /** The institution's contracted account the one won leaves from. 'N' account number, 'C' fintech number. */
  cntrAccountType?: 'N' | 'C';
  cntrAccountNum: string;
  /** Withdrawal-transfer passphrase registered with KFTC (already hashed as required by the console). */
  wdPassPhrase: string;
  /** Shown as the depositor on the customer's statement, up to 20 bytes */
  printName?: string;
  env: OpenBankingEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Random alphanumerics for bank_tran_id and the auth code. Injectable for tests. */
  random?: (n: number) => string;
  tokenTimeoutMs?: number;
  productTimeoutMs?: number;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomAlnum(n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[b[i] % ALNUM.length];
  return s;
}

/** YYYYMMDDhhmmss in Asia/Seoul, which has no DST. */
export function kstDtime(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export class OpenBankingAccountVendor implements BankAccountVendor {
  readonly name: string;
  private readonly http: VendorHttp;
  private readonly now: () => Date;
  private readonly random: (n: number) => string;
  private readonly tokens: VendorTokenCache;
  private readonly timeouts: ReturnType<typeof vendorTimeouts>;

  constructor(private readonly opts: OpenBankingOptions) {
    for (const k of ['clientId', 'clientSecret', 'clientUseCode', 'cntrAccountNum', 'wdPassPhrase'] as const) {
      if (!opts[k]) throw new Error(`OpenBankingAccountVendor: ${k} is required`);
    }
    if (!/^[A-Z0-9]{10}$/.test(opts.clientUseCode)) throw new Error('OpenBankingAccountVendor: clientUseCode must be 10 characters');
    if (!Object.hasOwn(HOSTS, opts.env)) throw new Error('OpenBankingAccountVendor: invalid environment');
    this.name = `openbanking:${opts.env}`;
    this.http = new VendorHttp(opts.fetch ?? fetch);
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? randomAlnum;
    this.tokens = new VendorTokenCache(() => this.now().getTime(), 7_775_999);
    this.timeouts = vendorTimeouts(opts);
  }

  get host(): string { return HOSTS[this.opts.env]; }
  get live(): boolean { return this.opts.env === 'prod'; }

  bankTranId(): string { return `${this.opts.clientUseCode}U${this.random(9)}`; }

  async accessToken(force = false): Promise<string> {
    const form = new URLSearchParams({
      client_id: this.opts.clientId, client_secret: this.opts.clientSecret, scope: 'oob', grant_type: 'client_credentials',
    });
    return this.tokens.get(async () => parseVendorJson(await this.http.text(`${this.host}/oauth/2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: form.toString(),
    }, { timeoutMs: this.timeouts.token, maxBytes: VENDOR_HTTP_LIMITS.tokenBytes })), force);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.accessToken();
    let text: string;
    try { text = await this.http.text(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }, { timeoutMs: this.timeouts.product, maxBytes: VENDOR_HTTP_LIMITS.productBytes });
    } catch (e) {
      if (e instanceof VendorTransportError && e.upstreamStatus === 401) this.tokens.invalidate(token);
      throw e;
    }
    const j = parseVendorJson(text);
    if (typeof j.rsp_code !== 'string' || !/^[A-Z0-9]{5}$/.test(j.rsp_code) || typeof j.rsp_message !== 'string') throw new VendorTransportError('VENDOR_BAD_RESPONSE');
    return j as T;
  }

  async holderName(input: { bankCode: string; accountNumber: string; birthDate: string }) {
    const r = await this.post<{ rsp_code: string; rsp_message: string; api_tran_id: string; account_holder_name?: string }>(
      '/v2.0/inquiry/real_name', {
        bank_tran_id: this.bankTranId(),
        bank_code_std: input.bankCode,
        account_num: input.accountNumber,
        account_holder_info_type: ' ',   // a person: first six digits of the resident number
        account_holder_info: input.birthDate,
        tran_dtime: kstDtime(this.now()),
      });
    if (r.rsp_code !== 'A0000') throw new VendorError(r.rsp_message || `Open Banking ${r.rsp_code}`, r.rsp_code, r.api_tran_id);
    return { holderName: r.account_holder_name?.trim() || null, ref: r.api_tran_id };
  }

  async oneWonTransfer(input: { bankCode: string; accountNumber: string; holderName: string }) {
    const authCode = this.random(4).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) % 10));
    const memberId = `PM${createHash('sha256').update(`${input.bankCode}:${input.accountNumber}`).digest('hex').slice(0, 18)}`;
    const r = await this.post<{
      rsp_code: string; rsp_message: string; api_tran_id: string;
      res_list?: { bank_rsp_code: string; bank_rsp_message?: string }[];
    }>('/v2.0/transfer/deposit/acnt_num', {
      cntr_account_type: this.opts.cntrAccountType ?? 'N',
      cntr_account_num: this.opts.cntrAccountNum,
      wd_pass_phrase: this.opts.wdPassPhrase,
      wd_print_content: (this.opts.printName ?? 'Proofmark').slice(0, 20),
      name_check_option: 'on',
      tran_dtime: kstDtime(this.now()),
      req_cnt: '1',
      req_list: [{
        tran_no: '1',
        bank_tran_id: this.bankTranId(),
        bank_code_std: input.bankCode,
        account_num: input.accountNumber,
        account_holder_name: input.holderName,
        print_content: `PM${authCode}`,
        tran_amt: '1',
        req_client_name: input.holderName,
        req_client_num: memberId,
        transfer_purpose: 'TR',
      }],
    });
    if (r.rsp_code !== 'A0000') throw new VendorError(r.rsp_message || `Open Banking ${r.rsp_code}`, r.rsp_code, r.api_tran_id);
    const bank = r.res_list?.[0];
    if (!bank || bank.bank_rsp_code !== '000') {
      throw new VendorError(`the bank declined the deposit: ${bank?.bank_rsp_message || bank?.bank_rsp_code || 'no result'}`, bank?.bank_rsp_code ?? 'BANK', r.api_tran_id);
    }
    return { authCode, ref: r.api_tran_id };
  }
}
