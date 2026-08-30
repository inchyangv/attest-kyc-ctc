import { createHash, randomBytes } from 'node:crypto';
import { VendorError, type BankAccountVendor } from './kr.js';

/**
 * 금융결제원 오픈뱅킹 (KFTC Open Banking) connector, for the bank-account axis.
 *
 *   token         POST /oauth/2.0/token  client_id, client_secret, scope=oob, grant_type=client_credentials
 *                 The 2-legged token an 이용기관 uses when no customer is logged in.
 *   holder name   POST /v2.0/inquiry/real_name     계좌실명조회: the bank checks the account against the
 *                 customer's real-name number (first six digits) and returns the holder's name.
 *   one won       POST /v2.0/transfer/deposit/acnt_num  입금이체 from the institution's contracted account
 *                 to the customer's account, one won, with our code in print_content.
 *
 * bank_tran_id is 이용기관코드 (10) + 'U' + 9 characters, unique per call. tran_dtime is KST.
 * rsp_code A0000 is success; for a deposit the bank's own bank_rsp_code must also be 000.
 *
 * The testbed (testapi.openbanking.or.kr) answers with canned data and moves no money, so results
 * from it carry live = false and set no bit. Production needs 이용기관 registration with KFTC.
 */
export type OpenBankingEnv = 'test' | 'prod';

const HOSTS: Record<OpenBankingEnv, string> = {
  test: 'https://testapi.openbanking.or.kr',
  prod: 'https://openapi.openbanking.or.kr',
};

export interface OpenBankingOptions {
  clientId: string;
  clientSecret: string;
  /** 이용기관코드, ten characters, e.g. M202300440 */
  clientUseCode: string;
  /** The institution's contracted account the one won leaves from. 'N' account number, 'C' fintech number. */
  cntrAccountType?: 'N' | 'C';
  cntrAccountNum: string;
  /** 출금이체 비밀번호 as registered with KFTC (already hashed the way the console asks). */
  wdPassPhrase: string;
  /** Shown as the depositor on the customer's statement, up to 20 bytes */
  printName?: string;
  env: OpenBankingEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Random alphanumerics for bank_tran_id and the auth code. Injectable for tests. */
  random?: (n: number) => string;
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
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly random: (n: number) => string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: OpenBankingOptions) {
    for (const k of ['clientId', 'clientSecret', 'clientUseCode', 'cntrAccountNum', 'wdPassPhrase'] as const) {
      if (!opts[k]) throw new Error(`OpenBankingAccountVendor: ${k} is required`);
    }
    if (!/^[A-Z0-9]{10}$/.test(opts.clientUseCode)) throw new Error('OpenBankingAccountVendor: clientUseCode must be 10 characters');
    this.name = `openbanking:${opts.env}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? randomAlnum;
  }

  get host(): string { return HOSTS[this.opts.env]; }
  get live(): boolean { return this.opts.env === 'prod'; }

  bankTranId(): string { return `${this.opts.clientUseCode}U${this.random(9)}`; }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now().getTime() + 60_000) return this.token.value;
    const form = new URLSearchParams({
      client_id: this.opts.clientId, client_secret: this.opts.clientSecret, scope: 'oob', grant_type: 'client_credentials',
    });
    const res = await this.fetchImpl(`${this.host}/oauth/2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: form.toString(),
    });
    const j = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; rsp_code?: string; rsp_message?: string };
    if (!res.ok || !j.access_token) {
      throw new VendorError(`Open Banking token: ${j.rsp_message ?? `HTTP ${res.status}`}`, j.rsp_code ?? 'TOKEN');
    }
    this.token = { value: j.access_token, expiresAt: this.now().getTime() + (j.expires_in ?? 7_775_999) * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const send = async (token: string) => this.fetchImpl(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    const j = await res.json().catch(() => null);
    if (!j || typeof j !== 'object') throw new VendorError(`Open Banking ${path}: unreadable response (HTTP ${res.status})`, 'BAD_RESPONSE');
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
