import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OpenBankingAccountVendor, kstDtime } from './adapters/openbanking.js';
import { VendorError } from './adapters/kr.js';

/** The KFTC Open Banking connector against a scripted fetch: the 2-legged token, real_name, deposit. */

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };
function fakeFetch(script: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(String(init?.body)); } catch { body = null; }
    const call = { url: String(url), init: init ?? {}, body };
    calls.push(call);
    const r = script(call, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: f };
}

const isToken = (c: Call) => c.url.endsWith('/oauth/2.0/token');
const TOKEN = { body: { access_token: 'ob-tok', token_type: 'Bearer', expires_in: 7775999, scope: 'oob', client_use_code: 'M202300440' } };
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

function vendor(fetchImpl: typeof fetch, env: 'test' | 'prod' = 'test') {
  return new OpenBankingAccountVendor({
    clientId: 'cid', clientSecret: 'csec', clientUseCode: 'M202300440',
    cntrAccountNum: '00012345678901234', wdPassPhrase: 'passhash', env, fetch: fetchImpl,
    now: () => new Date('2026-08-31T03:00:00Z'),
    random: (n) => (n === 4 ? '4821' : 'X'.repeat(n)),
  });
}

describe('OpenBankingAccountVendor', () => {
  test('the 2-legged token: client_credentials with scope oob, then Bearer on every call, cached', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { rsp_code: 'A0000', rsp_message: '', api_tran_id: 'api-1', account_holder_name: '홍길동' } }));
    const v = vendor(fetch);
    await v.holderName({ bankCode: '097', accountNumber: '1101230000678', birthDate: '880101' });
    await v.holderName({ bankCode: '097', accountNumber: '1101230000678', birthDate: '880101' });
    assert.equal(calls.filter(isToken).length, 1);
    const t = calls[0];
    assert.equal(t.url, 'https://testapi.openbanking.or.kr/oauth/2.0/token');
    const form = new URLSearchParams(String(t.init.body));
    assert.equal(form.get('client_id'), 'cid');
    assert.equal(form.get('client_secret'), 'csec');
    assert.equal(form.get('scope'), 'oob');
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(header(calls[1], 'Authorization'), 'Bearer ob-tok');
  });

  test('계좌실명조회 sends the real-name number and returns the holder', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { rsp_code: 'A0000', rsp_message: '', api_tran_id: 'api-rn', bank_code_std: '097', account_holder_name: '홍길동', account_type: '1' } }));
    const v = vendor(fetch);
    const r = await v.holderName({ bankCode: '097', accountNumber: '1101230000678', birthDate: '880101' });
    const c = calls[1];
    assert.equal(c.url, 'https://testapi.openbanking.or.kr/v2.0/inquiry/real_name');
    assert.equal(header(c, 'Content-Type'), 'application/json; charset=UTF-8');
    assert.deepEqual(c.body, {
      bank_tran_id: 'M202300440UXXXXXXXXX',
      bank_code_std: '097',
      account_num: '1101230000678',
      account_holder_info_type: ' ',
      account_holder_info: '880101',
      tran_dtime: '20260831120000',
    });
    assert.equal(String(c.body!.bank_tran_id).length, 20);
    assert.deepEqual(r, { holderName: '홍길동', ref: 'api-rn' });
  });

  test('a non-A0000 answer is a VendorError with the rsp_code', async () => {
    const { fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { rsp_code: 'A0021', rsp_message: '계좌번호 오류', api_tran_id: 'api-x' } }));
    await assert.rejects(vendor(fetch).holderName({ bankCode: '097', accountNumber: '1', birthDate: '880101' }),
      (e: unknown) => e instanceof VendorError && e.code === 'A0021' && e.ref === 'api-x');
  });

  test('입금이체 of one won with our code in the memo', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { rsp_code: 'A0000', rsp_message: '', api_tran_id: 'api-dep', res_cnt: '1',
                  res_list: [{ tran_no: '1', bank_rsp_code: '000', bank_rsp_message: '', print_content: 'PM4821', tran_amt: '1' }] } }));
    const v = vendor(fetch);
    const r = await v.oneWonTransfer({ bankCode: '097', accountNumber: '1101230000678', holderName: '홍길동' });
    const c = calls[1];
    assert.equal(c.url, 'https://testapi.openbanking.or.kr/v2.0/transfer/deposit/acnt_num');
    const b = c.body!;
    assert.equal(b.cntr_account_type, 'N');
    assert.equal(b.cntr_account_num, '00012345678901234');
    assert.equal(b.wd_pass_phrase, 'passhash');
    assert.equal(b.wd_print_content, 'Proofmark');
    assert.equal(b.name_check_option, 'on');
    assert.equal(b.tran_dtime, '20260831120000');
    assert.equal(b.req_cnt, '1');
    const item = (b.req_list as Record<string, unknown>[])[0];
    assert.equal(item.tran_no, '1');
    assert.equal(item.bank_tran_id, 'M202300440UXXXXXXXXX');
    assert.equal(item.bank_code_std, '097');
    assert.equal(item.account_num, '1101230000678');
    assert.equal(item.account_holder_name, '홍길동');
    assert.equal(item.print_content, 'PM4821');
    assert.equal(item.tran_amt, '1');
    assert.equal(item.req_client_name, '홍길동');
    assert.equal(item.transfer_purpose, 'TR');
    assert.match(String(item.req_client_num), /^PM[0-9a-f]{18}$/);
    assert.deepEqual(r, { authCode: '4821', ref: 'api-dep' });
  });

  test('the bank declining the deposit is a failure even when the API says A0000', async () => {
    const { fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { rsp_code: 'A0000', rsp_message: '', api_tran_id: 'api-dep',
                  res_list: [{ tran_no: '1', bank_rsp_code: '301', bank_rsp_message: '수취계좌 오류' }] } }));
    await assert.rejects(vendor(fetch).oneWonTransfer({ bankCode: '097', accountNumber: '1', holderName: '홍길동' }),
      (e: unknown) => e instanceof VendorError && e.code === '301' && /수취계좌/.test(e.message));
  });

  test('the testbed is not live; production is', () => {
    const { fetch } = fakeFetch(() => TOKEN);
    assert.equal(vendor(fetch, 'test').live, false);
    assert.equal(vendor(fetch, 'test').name, 'openbanking:test');
    assert.equal(vendor(fetch, 'prod').live, true);
    assert.equal(vendor(fetch, 'prod').host, 'https://openapi.openbanking.or.kr');
  });

  test('configuration is validated up front', () => {
    const { fetch } = fakeFetch(() => TOKEN);
    assert.throws(() => new OpenBankingAccountVendor({ clientId: 'a', clientSecret: 'b', clientUseCode: 'short', cntrAccountNum: '1', wdPassPhrase: 'p', env: 'test', fetch }), /10 characters/);
    assert.throws(() => new OpenBankingAccountVendor({ clientId: 'a', clientSecret: 'b', clientUseCode: 'M202300440', cntrAccountNum: '', wdPassPhrase: 'p', env: 'test', fetch }), /cntrAccountNum/);
  });

  test('kstDtime', () => {
    assert.equal(kstDtime(new Date('2026-08-31T03:00:00Z')), '20260831120000');
    assert.equal(kstDtime(new Date('2026-12-31T20:30:15Z')), '20270101053015');
  });
});
