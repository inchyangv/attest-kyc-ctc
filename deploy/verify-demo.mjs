#!/usr/bin/env node
/**
 * End-to-end driver for the guided KYC issuance flow (/verify) against a deployment.
 *
 *   node deploy/verify-demo.mjs https://<deployment-host>
 *
 * It walks the same API the browser walks — vendor status, wallet control, ID document, bank
 * account, issuance — plus the two demo denial paths, then waits for the Sepolia mark to
 * materialize on Creditcoin CC3 through the relay worker.
 *
 * It needs a deployment with the self-identifying demo vendors switched on (KYC_DEMO=1,
 * KYC_DEMO_BITS=1) and an issuer key configured. The subject wallet is generated per run, signs
 * one message and never holds funds; its private key is never printed.
 *
 * Exit code 0 only when every step printed PASS.
 */
import { Wallet } from 'ethers';

const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: node deploy/verify-demo.mjs <base-url>');
  process.exit(2);
}

// One ordinary, non-sanctioned identity used consistently across the ID, bank and declared fields.
const NAME = 'Kim Minsu';
const BIRTH_YYYYMMDD = '19900101';
const BIRTH_ISO = '1990-01-01';
const BIRTH_YYMMDD = '900101';
const RRN = '9001011234567';          // first six digits must equal the last six of birthDate
const ISSUE_DATE = '20200101';
const BANK_CODE = '004';
const GOOD_ACCOUNT = '12345678';
const MISMATCH_ACCOUNT = '1234567899';  // the demo bank gives an account ending in 99 another holder

const POLL_EVERY_MS = 30_000;
const POLL_FOR_MS = 20 * 60_000;

let failures = 0;
const pass = (step, detail) => console.log(`PASS  ${step}${detail ? ` — ${detail}` : ''}`);
const fail = (step, detail) => { failures++; console.log(`FAIL  ${step}${detail ? ` — ${detail}` : ''}`); };
const info = (line) => console.log(`      ${line}`);

/** Assert, collect the failure, and let the caller decide whether the run can continue. */
function check(step, ok, detail) {
  if (ok) pass(step, detail); else fail(step, detail);
  return ok;
}

/** Stop the run: report the step as failed (unless it already was) and exit non-zero. */
function die(step, detail, alreadyCounted = false) {
  if (alreadyCounted) info(detail); else fail(step, detail);
  console.log(`\n${failures} step(s) failed.`);
  process.exit(1);
}

async function call(method, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { method, ...init });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

const json = (method, path, payload) =>
  call(method, path, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

const brief = (body) => JSON.stringify(body).slice(0, 300);

// ─── a. vendor status ──────────────────────────────────────────────────────

const status = await call('GET', '/api/kyc/status');
if (status.status !== 200) die('a status', `HTTP ${status.status} ${brief(status.body)}`);
const s = status.body;
if (!check('a status', s.demo === true && s.sandboxBits === true && s.id?.configured === true &&
    s.bank?.configured === true && s.issuer?.configured === true,
    `demo=${s.demo} sandboxBits=${s.sandboxBits} id=${s.id?.vendor} bank=${s.bank?.vendor} issuer=${s.issuer?.configured}`)) {
  die('a status', 'the deployment is not configured for the demo flow', true);
}

// ─── b. wallet control ─────────────────────────────────────────────────────

const wallet = Wallet.createRandom();               // throwaway: signs one message, holds nothing
const subject = wallet.address;
const chal = await call('GET', `/api/kyc/wallet?address=${subject}`);
if (chal.status !== 200 || !chal.body.message || !chal.body.token) {
  die('b wallet challenge', `HTTP ${chal.status} ${brief(chal.body)}`);
}
const signature = await wallet.signMessage(chal.body.message);
const walletRes = await json('POST', '/api/kyc/wallet', { token: chal.body.token, signature });
if (walletRes.status !== 200 || !walletRes.body.walletProof) {
  die('b wallet proof', `HTTP ${walletRes.status} ${brief(walletRes.body)}`);
}
const walletProof = walletRes.body.walletProof;
check('b wallet control', true, `subject ${subject}`);

// ─── c. ID document ────────────────────────────────────────────────────────

function idForm(fullName) {
  const form = new FormData();
  form.append('action', 'verify');
  form.append('docType', 'RRC');
  form.append('fullName', fullName);
  form.append('birthDate', BIRTH_YYYYMMDD);
  form.append('rrn', RRN);
  form.append('issueDate', ISSUE_DATE);
  form.append('image', new Blob([crypto.getRandomValues(new Uint8Array(64))], { type: 'image/png' }), 'id.png');
  return form;
}

const idRes = await call('POST', '/api/kyc/id', { body: idForm(NAME) });
if (idRes.status !== 200 || idRes.body.status !== 'verified' || !idRes.body.idProof) {
  die('c id document', `HTTP ${idRes.status} ${brief(idRes.body)}`);
}
const idProof = idRes.body.idProof;
check('c id document', true, `status=verified vendor=${idRes.body.summary?.vendor} live=${idRes.body.summary?.live}`);

// ─── d. denial path A: a document that is not authentic ────────────────────

const idBad = await call('POST', '/api/kyc/id', { body: idForm('FAKE Person') });
check('d denial A (id not authentic)',
  idBad.status === 200 && idBad.body.status === 'rejected' && idBad.body.summary?.authentic === false,
  `HTTP ${idBad.status} status=${idBad.body.status} authentic=${idBad.body.summary?.authentic}`);
// its idProof is discarded on purpose — a rejected document must never reach issuance

// ─── e. bank account ───────────────────────────────────────────────────────

const bankStart = await json('POST', '/api/kyc/bank', {
  action: 'start', bankCode: BANK_CODE, accountNumber: GOOD_ACCOUNT,
  birthDate: BIRTH_YYMMDD, declaredName: NAME,
});
if (bankStart.status !== 200 || !bankStart.body.challenge || !bankStart.body.demoCode) {
  die('e bank start', `HTTP ${bankStart.status} ${brief(bankStart.body)}`);
}
check('e bank start', true, `vendor=${bankStart.body.vendor} live=${bankStart.body.live} holder=${bankStart.body.holderNameMasked}`);

const bankVerify = await json('POST', '/api/kyc/bank', {
  action: 'verify', challenge: bankStart.body.challenge, code: bankStart.body.demoCode,
});
if (bankVerify.status !== 200 || bankVerify.body.status !== 'verified' || !bankVerify.body.bankProof) {
  die('e bank one-won code', `HTTP ${bankVerify.status} ${brief(bankVerify.body)}`);
}
const bankProof = bankVerify.body.bankProof;
check('e bank one-won code', true, `status=verified vendor=${bankVerify.body.summary?.vendor}`);

// ─── f. denial path B: the account belongs to someone else ─────────────────

const bankBad = await json('POST', '/api/kyc/bank', {
  action: 'start', bankCode: BANK_CODE, accountNumber: MISMATCH_ACCOUNT,
  birthDate: BIRTH_YYMMDD, declaredName: NAME,
});
check('f denial B (bank holder mismatch)',
  bankBad.status === 422 && bankBad.body.code === 'HOLDER_MISMATCH',
  `HTTP ${bankBad.status} code=${bankBad.body.code}`);

// ─── g. issuance ───────────────────────────────────────────────────────────

const issue = await json('POST', '/api/kyc/issue', {
  walletProof,
  declared: { fullName: NAME, dateOfBirth: BIRTH_ISO, nationality: 'KR', residence: 'KR' },
  idProof, bankProof,
});
if (issue.status !== 200 || issue.body.status !== 'ISSUED') {
  die('g issue', `HTTP ${issue.status} status=${issue.body.status} reason=${issue.body.reason ?? issue.body.error} ${brief(issue.body)}`);
}
const on = issue.body.onchain ?? {};
const issueOk =
  issue.body.assurance === 3 &&
  issue.body.regime === 2 &&
  issue.body.passesKrProduction === true &&
  on.sent === true &&
  typeof on.txHash === 'string' && on.txHash.length === 66 &&
  on.reverted === false &&
  on.blockNumber !== null && on.blockNumber !== undefined;
check('g issue',
  issueOk,
  `status=ISSUED assurance=${issue.body.assurance} regime=${issue.body.regime} ` +
  `passesKrProduction=${issue.body.passesKrProduction} methods=${issue.body.methodsHex} ` +
  `sent=${on.sent} reverted=${on.reverted} block=${on.blockNumber}`);
info(`subject  ${subject}`);
info(`txHash   ${on.txHash}`);
info(`issuer   ${on.issuer}`);
if (!issueOk) die('g issue', 'the Sepolia transaction did not settle as expected', true);

// ─── h. cross-chain materialization on CC3 ─────────────────────────────────

info(`waiting for the relay worker to carry the mark to CC3 (poll every ${POLL_EVERY_MS / 1000}s, up to ${POLL_FOR_MS / 60000} min)`);
const started = Date.now();
let last = null;
let seen = false;
while (Date.now() - started < POLL_FOR_MS) {
  const r = await call('GET', `/api/onchain?subject=${subject}`);
  last = r;
  const mark = r.body?.mark;
  if (r.status === 200 && mark?.status === 1) { seen = true; break; }
  const waited = Math.round((Date.now() - started) / 1000);
  info(`  ${waited}s — mark.status=${mark?.status ?? `HTTP ${r.status}`} (0 means the mark has not arrived yet)`);
  await new Promise((r2) => setTimeout(r2, POLL_EVERY_MS));
}
const elapsed = Math.round((Date.now() - started) / 1000);
if (!seen) {
  die('h cc3 materialization', `the mark was still not Active after ${elapsed}s — ${brief(last?.body ?? {})}`);
}
const oc = last.body;
check('h cc3 materialization',
  oc.mark.status === 1 && oc.tombstone === false && oc.policies?.[0]?.verified === true,
  `mark.status=${oc.mark.status} tombstone=${oc.tombstone} policy1(${oc.policies?.[0]?.name})=${oc.policies?.[0]?.verified}`);
info(`measured Sepolia to CC3 attestation delay: ${Math.floor(elapsed / 60)}m${elapsed % 60}s ` +
     `(the relay worker's proof-build and submission window, not a fault)`);
info(`mark: assurance=${oc.mark.assurance} regime=${oc.mark.regime} methods=${oc.mark.methodsHex} epoch=${oc.mark.epoch}`);

// ─── result ────────────────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.log(`${failures} step(s) failed.`);
  process.exit(1);
}
console.log(`All steps passed. subject=${subject} txHash=${on.txHash} cc3-delay=${elapsed}s`);
