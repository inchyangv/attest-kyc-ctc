import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { ethers } from 'ethers';

import {
  CodefClient, CodefIdDocumentVendor, CodefBankAccountVendor, parseCodefBody, rrnToBirthDate, codefBankOrg,
  type CodefCertLogin,
} from './adapters/codef.js';
import { VendorError } from './adapters/kr.js';

/**
 * The CODEF connector against a scripted fetch. What is checked is the wire format the guide
 * specifies (Basic token, URL-encoded JSON both ways, RSA fields, the two-way second leg) and that
 * every answer maps to the honest result shape: authentic only on "1", live only off the sandbox.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_B64 = publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/-----[A-Z ]+-----|\s/g, '');
const decrypt = (b64: string) =>
  privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(b64, 'base64')).toString('utf8');

type Call = { url: string; init: RequestInit };
type Scripted = { status?: number; body: unknown; raw?: boolean };

function fakeFetch(script: (call: Call, n: number) => Scripted) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const r = script(call, calls.length);
    const text = r.raw ? String(r.body) : encodeURIComponent(JSON.stringify(r.body));
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: f };
}

const TOKEN: Scripted = { raw: true, body: JSON.stringify({ access_token: 'tok-1', token_type: 'bearer', expires_in: 604799, scope: 'read' }) };
const ok = (data: unknown, transactionId = 'tx-1'): Scripted =>
  ({ body: { result: { code: 'CF-00000', message: '성공', extraMessage: '', transactionId }, data } });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];
const bodyOf = (c: Call) => JSON.parse(decodeURIComponent(String(c.init.body)));
const isToken = (c: Call) => c.url.startsWith('https://oauth.codef.io/');

const LOGIN: CodefCertLogin = {
  certType: 'pfx', certFile: 'PFX_BASE64', certPassword: 'cert-pw', loginUserName: '스테이블드', loginIdentity: '1234567890',
};
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);

function client(fetchImpl: typeof fetch, env: 'sandbox' | 'demo' | 'api' = 'demo') {
  return new CodefClient({ clientId: 'cid', clientSecret: 'csec', publicKey: PUB_B64, env, fetch: fetchImpl });
}

describe('CodefClient wire format', () => {
  test('the token is requested once with Basic credentials and cached', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN : ok({ x: 1 })));
    const cl = client(fetch);
    await cl.request('/v1/a', { a: 1 });
    await cl.request('/v1/a', { a: 2 });
    assert.equal(calls.filter(isToken).length, 1, 'the token must be cached');
    const t = calls[0];
    assert.equal(header(t, 'Authorization'), `Basic ${Buffer.from('cid:csec').toString('base64')}`);
    assert.equal(t.init.body, 'grant_type=client_credentials&scope=read');
    assert.equal(header(t, 'Content-Type'), 'application/x-www-form-urlencoded');
  });

  test('requests carry the Bearer token and URL-encoded JSON; URL-encoded replies are decoded', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { result: { code: 'CF-00000', message: '정상 처리', extraMessage: '', transactionId: 't' }, data: { name: '홍 길동' } } }));
    const r = await client(fetch).request<{ name: string }>('/v1/kr/x', { organization: '0004', text: '가 나+다&라' });
    const call = calls[1];
    assert.equal(call.url, 'https://development.codef.io/v1/kr/x');
    assert.equal(header(call, 'Authorization'), 'Bearer tok-1');
    assert.equal(header(call, 'Content-Type'), 'application/json');
    assert.ok(!String(call.init.body).startsWith('{'), 'the body must be URL-encoded, not raw JSON');
    assert.deepEqual(bodyOf(call), { organization: '0004', text: '가 나+다&라' });
    assert.equal(r.result.message, '정상 처리');
    assert.equal(r.data.name, '홍 길동');
  });

  test('a 401 refreshes the token and retries once', async () => {
    let tokens = 0;
    const { calls, fetch } = fakeFetch((c) => {
      if (isToken(c)) { tokens++; return { raw: true, body: JSON.stringify({ access_token: `tok-${tokens}`, expires_in: 100000 }) }; }
      return header(c, 'Authorization') === 'Bearer tok-1'
        ? { status: 401, body: { result: { code: 'CF-99997', message: 'expired' }, data: {} } }
        : ok({ fine: true });
    });
    const r = await client(fetch).request<{ fine: boolean }>('/v1/x', {});
    assert.equal(r.data.fine, true);
    assert.equal(tokens, 2);
    assert.equal(calls.length, 4);
  });

  test('parseCodefBody accepts plain and URL-encoded JSON', () => {
    assert.deepEqual(parseCodefBody('{"a":1}'), { a: 1 });
    assert.deepEqual(parseCodefBody(encodeURIComponent('{"a":"가 나"}')), { a: '가 나' });
    assert.deepEqual(parseCodefBody('%7B%22a%22%3A%22x+y%22%7D'), { a: 'x y' });
  });

  test('rsa() produces PKCS#1 v1.5 the private key opens', () => {
    assert.equal(decrypt(client(fakeFetch(() => TOKEN).fetch).rsa('secret-1')), 'secret-1');
  });

  test('helpers', () => {
    assert.equal(rrnToBirthDate('9001011234567'), '19900101');
    assert.equal(rrnToBirthDate('0503153234567'), '20050315');
    assert.equal(rrnToBirthDate('8512254234567'), '20851225');
    assert.equal(rrnToBirthDate('12'), undefined);
    assert.equal(codefBankOrg('004'), '0004');
  });
});

describe('CodefIdDocumentVendor', () => {
  test('resident registration card: 정부24 with the issuer certificate, RSA on the password and the RRN tail', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : ok({ resUserNm: '홍길동', resUserIdentiyNo: '900101-*******', resAuthenticity: '1', resAuthenticityDesc: '진위확인 성공' }, 'tx-rrc')));
    const v = new CodefIdDocumentVendor(client(fetch), LOGIN);
    const out = await v.verify({ docType: 'RRC', image: IMAGE, fullName: ' 홍길동 ', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' });

    const call = calls[1];
    assert.equal(call.url, 'https://development.codef.io/v1/kr/public/mw/identity-card/check-status');
    const b = bodyOf(call);
    assert.equal(b.organization, '0002');
    assert.equal(b.loginType, '0');
    assert.equal(b.certType, 'pfx');
    assert.equal(b.certFile, 'PFX_BASE64');
    assert.equal(b.keyFile, undefined, 'a pfx login sends no key file');
    assert.equal(decrypt(b.certPassword), 'cert-pw');
    assert.equal(b.userName, '홍길동');
    assert.equal(b.identityEncYn, 'Y');
    assert.equal(b.birthDate, '900101');
    assert.equal(decrypt(b.identity), '1234567', 'only the last seven digits travel, encrypted');
    assert.equal(b.issueDate, '20200101');
    assert.equal(b.is2Way, undefined);

    assert.equal(out.kind, 'verified');
    if (out.kind !== 'verified') return;
    assert.equal(out.authentic, true);
    assert.equal(out.authenticityChecked, true);
    assert.equal(out.live, true, 'demo queries the real authority');
    assert.equal(out.docHash, ethers.keccak256(IMAGE));
    assert.equal(out.dateOfBirth, '1990-01-01');
    assert.equal(out.fullName, '홍길동');
    assert.equal(out.faceMatched, false);
    assert.equal(out.livenessPassed, false);
    assert.equal(out.ref, 'tx-rrc');
    assert.equal(out.code, '1');
    assert.equal(out.vendor, 'codef:demo');
  });

  test('driver licence: 교통민원24, licence number split four ways, "2" is not authentic', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : ok({ resUserNm: '홍길동', commBirthDate: '19900101', resAuthenticity: '2', resLicenseNumber: '11-22-334455-66', resAuthenticityDesc1: '전산정보만 일치' })));
    const v = new CodefIdDocumentVendor(client(fetch), { ...LOGIN, certType: '1', certFile: 'DER', keyFile: 'KEY' });
    const out = await v.verify({ docType: 'DL', image: IMAGE, fullName: '홍길동', birthDate: '19900101', licenseNumber: '112233445566', serialNo: 'AB12CD' });

    const b = bodyOf(calls[1]);
    assert.equal(calls[1].url, 'https://development.codef.io/v1/kr/public/ef/driver-license/status');
    assert.equal(b.organization, '0001');
    assert.equal(b.loginType, '2');
    assert.equal(b.certType, '1');
    assert.equal(b.certFile, 'DER');
    assert.equal(b.keyFile, 'KEY');
    assert.equal(b.loginUserName, '스테이블드');
    assert.equal(b.identity, '1234567890', 'the login identity is the certificate holder, not the customer');
    assert.equal(b.userName, '홍길동');
    assert.equal(b.birthDate, '19900101');
    assert.deepEqual([b.licenseNo01, b.licenseNo02, b.licenseNo03, b.licenseNo04], ['11', '22', '334455', '66']);
    assert.equal(b.serialNo, 'AB12CD');

    assert.equal(out.kind, 'verified');
    if (out.kind !== 'verified') return;
    assert.equal(out.authentic, false, '"2" means the serial did not verify');
    assert.equal(out.authenticityChecked, true);
    assert.equal(out.code, '2');
  });

  test('a two-way request is surfaced, and the second leg repeats the body with is2Way', async () => {
    const { calls, fetch } = fakeFetch((c, n) => {
      if (isToken(c)) return TOKEN;
      if (n === 2) return { body: { result: { code: 'CF-03002', message: '추가 인증이 필요합니다', extraMessage: '', transactionId: 'tx-2w' },
        data: { continue2Way: true, method: 'secureNo', jobIndex: 0, threadIndex: 1, jti: 'jti-1', twoWayTimestamp: 1700000000000,
                extraInfo: { reqSecureNo: 'BASE64PNG', reqSecureNoRefresh: '' } } } };
      return ok({ resAuthenticity: '1' });
    });
    const v = new CodefIdDocumentVendor(client(fetch), LOGIN);
    const input = { docType: 'RRC' as const, image: IMAGE, fullName: '홍길동', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' };

    const first = await v.verify(input);
    assert.equal(first.kind, 'two_way');
    if (first.kind !== 'two_way') return;
    assert.equal(first.challenge.method, 'secureNo');
    assert.equal(first.challenge.imageBase64, 'BASE64PNG');
    assert.equal(first.challenge.jti, 'jti-1');
    assert.equal(first.challenge.threadIndex, 1);

    const second = await v.verify({ ...input, twoWay: { ...first.challenge, secureNo: '48213' } });
    assert.equal(second.kind, 'verified');
    const b = bodyOf(calls[2]);
    assert.equal(b.is2Way, true);
    assert.deepEqual(b.twoWayInfo, { jobIndex: 0, threadIndex: 1, jti: 'jti-1', twoWayTimestamp: 1700000000000 });
    assert.equal(b.secureNo, '48213');
    assert.equal(b.secureNoRefresh, '0');
    assert.equal(b.organization, '0002', 'the first-leg parameters are repeated');
    assert.equal(decrypt(b.identity), '1234567');
  });

  test('an error from the institution is a VendorError carrying its code', async () => {
    const { fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { result: { code: 'CF-12100', message: '통합 로그인 미등록', extraMessage: '상세', transactionId: 'tx-e' }, data: {} } }));
    const v = new CodefIdDocumentVendor(client(fetch), LOGIN);
    await assert.rejects(
      v.verify({ docType: 'RRC', image: IMAGE, fullName: '홍길동', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' }),
      (e: unknown) => e instanceof VendorError && e.code === 'CF-12100' && e.ref === 'tx-e' && /미등록/.test(e.message));
  });

  test('the sandbox is never live', async () => {
    const { fetch } = fakeFetch((c) => (isToken(c) ? TOKEN : ok({ resAuthenticity: '1' })));
    const v = new CodefIdDocumentVendor(client(fetch, 'sandbox'), LOGIN);
    assert.equal(v.live, false);
    const out = await v.verify({ docType: 'RRC', image: IMAGE, fullName: '홍길동', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' });
    assert.equal(out.kind, 'verified');
    if (out.kind === 'verified') assert.equal(out.live, false, 'a sandbox "1" must not become an authenticity bit');
  });

  test('OCR uploads multipart and maps the fields', async () => {
    const { calls, fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : ok({ resType: '운전면허증', resUserName: '홍길동', resUserIdentity: '900101-1234567', resLicenseNo: '11-22-334455-66',
             resIssueDate: '2020.01.01', resSerialNum: 'AB12CD', commBirthDate: '900101' })));
    const v = new CodefIdDocumentVendor(client(fetch), LOGIN);
    const f = await v.ocr(IMAGE, 'DL');
    assert.equal(calls[1].url, 'https://development.codef.io/v1/kr/etc/a/kyc/drivers-license');
    assert.ok(calls[1].init.body instanceof FormData, 'OCR is multipart/form-data');
    assert.equal(header(calls[1], 'Authorization'), 'Bearer tok-1');
    assert.deepEqual(f, { docType: 'DL', fullName: '홍길동', birthDate: '19900101', rrn: undefined, issueDate: '20200101',
                          licenseNumber: '112233445566', serialNo: 'AB12CD' });

    const g = await v.ocr(IMAGE, 'RRC');
    assert.equal(calls[2].url, 'https://development.codef.io/v1/kr/etc/a/kyc/registration-card');
    assert.equal(g.rrn, '9001011234567');
    assert.equal(g.licenseNumber, undefined);
  });

  test('간편인증 login: no certificate, the approver\'s identity, and the simpleAuth second leg', async () => {
    const { calls, fetch } = fakeFetch((c, n) => {
      if (isToken(c)) return TOKEN;
      if (n === 2) return { body: { result: { code: 'CF-03002', message: '간편인증을 진행해 주세요', transactionId: 'tx-s' },
        data: { continue2Way: true, method: 'simpleAuth', jobIndex: 0, threadIndex: 0, jti: 'jti-s', twoWayTimestamp: 1700000000001, extraInfo: { commSimpleAuth: '' } } } };
      return ok({ resAuthenticity: '1' });
    });
    const v = new CodefIdDocumentVendor(client(fetch), {
      kind: 'simple', level: '1', phoneNo: '010-1234-5678', loginUserName: '운영자', loginIdentity: '8505151234567',
    });
    assert.equal(v.loginKind, 'simple');
    const input = { docType: 'RRC' as const, image: IMAGE, fullName: '홍길동', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' };
    const first = await v.verify(input);
    assert.equal(first.kind, 'two_way');
    if (first.kind !== 'two_way') return;
    assert.equal(first.challenge.method, 'simpleAuth');

    const b1 = bodyOf(calls[1]);
    assert.equal(b1.loginType, '6', '정부24 간편인증');
    assert.equal(b1.loginTypeLevel, '1', '카카오톡');
    assert.equal(b1.phoneNo, '01012345678');
    assert.equal(b1.loginUserName, '운영자');
    assert.equal(b1.loginBirthDate, '850515');
    assert.equal(decrypt(b1.loginIdentity), '1234567', 'the approver\'s tail is encrypted like the customer\'s');
    assert.equal(b1.certFile, undefined);
    assert.equal(b1.certPassword, undefined);

    const second = await v.verify({ ...input, twoWay: { ...first.challenge, simpleAuth: '1' } });
    assert.equal(second.kind, 'verified');
    const b2 = bodyOf(calls[2]);
    assert.equal(b2.is2Way, true);
    assert.equal(b2.simpleAuth, '1');
    assert.equal(b2.secureNo, undefined);

    // the driver-licence product uses different login codes and the identity in clear
    const { calls: c2, fetch: f2 } = fakeFetch((c) => (isToken(c) ? TOKEN : ok({ resAuthenticity: '1' })));
    const v2 = new CodefIdDocumentVendor(client(f2), { kind: 'simple', level: '5', telecom: '1', phoneNo: '01012345678', loginUserName: '운영자', loginIdentity: '8505151234567' });
    await v2.verify({ docType: 'DL', image: IMAGE, fullName: '홍길동', birthDate: '19900101', licenseNumber: '112233445566', serialNo: 'AB12CD' });
    const b3 = bodyOf(c2[1]);
    assert.equal(b3.loginType, '5');
    assert.equal(b3.loginTypeLevel, '5');
    assert.equal(b3.telecom, '1');
    assert.equal(b3.identity, '8505151234567');
    assert.equal(b3.loginBirthDate, undefined);
  });

  test('login configuration is validated up front', () => {
    const { fetch } = fakeFetch(() => TOKEN);
    assert.throws(() => new CodefIdDocumentVendor(client(fetch), { ...LOGIN, certFile: '' }), /certFile/);
    assert.throws(() => new CodefIdDocumentVendor(client(fetch), { ...LOGIN, certType: '1' }), /keyFile/);
    assert.throws(() => new CodefIdDocumentVendor(client(fetch), { kind: 'simple', level: '1', phoneNo: '010', loginUserName: 'x', loginIdentity: '123' }), /13-digit/);
    assert.throws(() => new CodefIdDocumentVendor(client(fetch), { kind: 'simple', level: '5', phoneNo: '010', loginUserName: 'x', loginIdentity: '8505151234567' }), /telecom/);
  });
});

describe('CodefBankAccountVendor', () => {
  test('refuses the demo and sandbox servers, whose bank answers are random', () => {
    const { fetch } = fakeFetch(() => TOKEN);
    assert.throws(() => new CodefBankAccountVendor(client(fetch, 'demo')), /random test data/);
    assert.throws(() => new CodefBankAccountVendor(client(fetch, 'sandbox')), /random test data/);
  });

  test('holder authentication and the one-won transfer, on production', async () => {
    const { calls, fetch } = fakeFetch((c, n) => (isToken(c) ? TOKEN : n === 2 ? ok({ name: '홍길동' }, 'tx-h') : ok({ authCode: '4821' }, 'tx-1w')));
    const v = new CodefBankAccountVendor(client(fetch, 'api'));
    assert.equal(v.live, true);

    const h = await v.holderName({ bankCode: '004', accountNumber: '110123456789', birthDate: '900101' });
    assert.equal(calls[1].url, 'https://api.codef.io/v1/kr/bank/a/account/holder-authentication');
    assert.deepEqual(bodyOf(calls[1]), { organization: '0004', account: '110123456789', identity: '900101' });
    assert.deepEqual(h, { holderName: '홍길동', ref: 'tx-h' });

    const w = await v.oneWonTransfer({ bankCode: '004', accountNumber: '110123456789', holderName: '홍길동' });
    assert.equal(calls[2].url, 'https://api.codef.io/v1/kr/bank/a/account/transfer-authentication');
    assert.deepEqual(bodyOf(calls[2]), { organization: '0004', account: '110123456789', inPrintType: '0' });
    assert.deepEqual(w, { authCode: '4821', ref: 'tx-1w' });
  });

  test('a bank error is a VendorError', async () => {
    const { fetch } = fakeFetch((c) => (isToken(c) ? TOKEN
      : { body: { result: { code: 'CF-13001', message: '실명번호 불일치', transactionId: 'tx-x' }, data: {} } }));
    const v = new CodefBankAccountVendor(client(fetch, 'api'));
    await assert.rejects(v.holderName({ bankCode: '004', accountNumber: '1', birthDate: '900101' }),
      (e: unknown) => e instanceof VendorError && e.code === 'CF-13001');
  });
});
