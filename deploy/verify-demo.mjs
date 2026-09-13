#!/usr/bin/env node
/**
 * End-to-end driver for the guided KYC issuance flow (/verify) against a deployment.
 *
 *   node deploy/verify-demo.mjs https://<deployment-host> --execute-issuance
 *
 * It walks the same API the browser walks — vendor status, wallet control, ID document, bank
 * account, issuance — plus the two demo denial paths, then waits for the Sepolia mark to
 * materialize on Creditcoin CC3 through the relay worker.
 *
 * It needs a deployment with the self-identifying demo vendors switched on (KYC_DEMO=1,
 * KYC_DEMO_BITS=1) and an issuer key configured. The subject wallet is generated per run, signs
 * one message and never holds funds; its private key is never printed.
 *
 * This is write mode: the server may spend issuer gas. Current implementation returns 2
 * after API checks because independent consumer-gate E2E is not yet implemented; never a full PASS.
 */
import { Wallet } from 'ethers';
import { syntheticDriverPng, isIsolatedDemoStatus, assessDriverObservation } from './demo-driver-utils.mjs';
import { driverJsonRequest, DriverHttpError } from './demo-driver-http.mjs';
import { reconcileDriverIssuance } from './demo-driver-issuance.mjs';

const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!BASE || process.argv.length !== 4 || process.argv[3] !== '--execute-issuance') {
  console.error('usage: node deploy/verify-demo.mjs <base-url> --execute-issuance (may spend issuer gas; not a read-only verifier)');
  process.exit(2);
}
let target;
try { target = new URL(BASE); }
catch { console.error('invalid base URL'); process.exit(2); }
if (target.username || target.password || target.search || target.hash || target.pathname !== '/' ||
  !(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) {
  console.error('base URL must be an HTTPS origin, or HTTP loopback, without credentials, query or path');
  process.exit(2);
}

// Fictional fields, not institution-approved test identifiers. No sanctions outcome is assumed.
const NAME = 'PROOFMARK SAMPLE PERSON';
const BIRTH_YYYYMMDD = '20000101';
const BIRTH_ISO = '2000-01-01';
const BIRTH_YYMMDD = '000101';
const RRN = '0001010000001';
const ISSUE_DATE = '20240101';
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
  return driverJsonRequest(`${BASE}${path}`, { method, ...init });
}

const json = (method, path, payload) =>
  call(method, path, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

// Never dump opaque proofs, raw evidence, arbitrary error text or vendor payloads to a recording log.
const brief = (body) => JSON.stringify({ status: ['ISSUED', 'PREPARED', 'REJECTED', 'DENIED', 'REVIEW'].includes(body?.status) ? body.status : 'unconfirmed',
  requestId: typeof body?.requestId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.requestId) ? body.requestId : undefined });
const hex = (value, bytes) => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 32768;

async function main() {

// ─── a. vendor status ──────────────────────────────────────────────────────

const status = await call('GET', '/api/kyc/status');
if (status.status !== 200) die('a status', `HTTP ${status.status} ${brief(status.body)}`);
const s = status.body;
if (!check('a status', isIsolatedDemoStatus(s),
    'checked exact non-live demo vendors, sandbox bits and required state services')) {
  die('a status', 'the deployment is not configured for the demo flow', true);
}

// ─── b. wallet control ─────────────────────────────────────────────────────

const wallet = Wallet.createRandom();               // throwaway: signs one message, holds nothing
const subject = wallet.address;
const chal = await call('GET', `/api/kyc/wallet?address=${subject}`);
if (chal.status !== 200 || typeof chal.body.message !== 'string' || !chal.body.message.length || chal.body.message.length > 4096 || !opaque(chal.body.token)) {
  die('b wallet challenge', `HTTP ${chal.status} ${brief(chal.body)}`);
}
const signature = await wallet.signMessage(chal.body.message);
const walletRes = await json('POST', '/api/kyc/wallet', { token: chal.body.token, signature });
if (walletRes.status !== 200 || !opaque(walletRes.body.walletProof) || !hex(walletRes.body.requestId, 32)) {
  die('b wallet proof', `HTTP ${walletRes.status} ${brief(walletRes.body)}`);
}
const walletProof = walletRes.body.walletProof;
const requestId = walletRes.body.requestId;
check('b wallet control', true, `subject ${subject}`);

// ─── c. ID document ────────────────────────────────────────────────────────

function idForm(fullName) {
  const form = new FormData();
  form.append('walletProof', walletProof);
  form.append('syntheticSample', '1');
  form.append('action', 'verify');
  form.append('docType', 'RRC');
  form.append('fullName', fullName);
  form.append('birthDate', BIRTH_YYYYMMDD);
  form.append('rrn', RRN);
  form.append('issueDate', ISSUE_DATE);
  form.append('image', new Blob([syntheticDriverPng()], { type: 'image/png' }), 'synthetic-training-pixels-not-an-id.png');
  return form;
}

const idRes = await call('POST', '/api/kyc/id', { body: idForm(NAME) });
if (idRes.status !== 200 || idRes.body.status !== 'verified' || !opaque(idRes.body.idProof) ||
    idRes.body.summary?.vendor !== 'demo:id' || idRes.body.summary?.live !== false) {
  die('c id document', `HTTP ${idRes.status} ${brief(idRes.body)}`);
}
const idProof = idRes.body.idProof;
check('c id document', true, 'verified by non-live demo:id');

// ─── d. denial path A: a document that is not authentic ────────────────────

const idBad = await call('POST', '/api/kyc/id', { body: idForm('FAKE Person') });
check('d denial A (id not authentic)',
  idBad.status === 200 && idBad.body.status === 'rejected' && idBad.body.summary?.authentic === false,
  `HTTP ${idBad.status}; checked rejected and authentic=false`);
// its idProof is discarded on purpose — a rejected document must never reach issuance

// ─── e. bank account ───────────────────────────────────────────────────────

const bankStart = await json('POST', '/api/kyc/bank', {
  walletProof,
  syntheticSample: true,
  startRequestId: crypto.randomUUID(),
  action: 'start', bankCode: BANK_CODE, accountNumber: GOOD_ACCOUNT,
  birthDate: BIRTH_YYMMDD, declaredName: NAME,
});
if (bankStart.status !== 200 || !opaque(bankStart.body.challenge) || typeof bankStart.body.demoCode !== 'string' ||
    !/^\d{4}$/.test(bankStart.body.demoCode) || bankStart.body.vendor !== 'demo:bank' || bankStart.body.live !== false) {
  die('e bank start', `HTTP ${bankStart.status} ${brief(bankStart.body)}`);
}
check('e bank start', true, 'non-live demo:bank challenge received; holder and code omitted');

const bankVerify = await json('POST', '/api/kyc/bank', {
  walletProof,
  syntheticSample: true,
  action: 'verify', challenge: bankStart.body.challenge, code: bankStart.body.demoCode,
});
if (bankVerify.status !== 200 || bankVerify.body.status !== 'verified' || !opaque(bankVerify.body.bankProof) ||
    bankVerify.body.summary?.vendor !== 'demo:bank' || bankVerify.body.summary?.live !== false) {
  die('e bank one-won code', `HTTP ${bankVerify.status} ${brief(bankVerify.body)}`);
}
const bankProof = bankVerify.body.bankProof;
check('e bank one-won code', true, 'verified by non-live demo:bank');

// ─── f. denial path B: the account belongs to someone else ─────────────────

const bankBad = await json('POST', '/api/kyc/bank', {
  walletProof,
  syntheticSample: true,
  startRequestId: crypto.randomUUID(),
  action: 'start', bankCode: BANK_CODE, accountNumber: MISMATCH_ACCOUNT,
  birthDate: BIRTH_YYMMDD, declaredName: NAME,
});
check('f denial B (bank holder mismatch)',
  bankBad.status === 422 && bankBad.body.code === 'HOLDER_MISMATCH',
  `HTTP ${bankBad.status}; checked HOLDER_MISMATCH`);
if (failures) die('g issuance skipped', 'a required negative path failed; no issuance request will be sent', true);

// ─── g. issuance ───────────────────────────────────────────────────────────

info(`recovery request ${requestId}; retained only for this running driver, not a cross-process wallet backup`);
const issue = await reconcileDriverIssuance(`${BASE}/api/kyc/issue`, requestId, {
  walletProof,
  declared: { fullName: NAME, dateOfBirth: BIRTH_ISO, nationality: 'KR', residence: 'KR' },
  idProof, bankProof,
}, { onProgress: action => info(`reconciling the original request via ${action}; no new issuance payload`) });
if (issue.status !== 200 || issue.body.status !== 'ISSUED') {
  die('g issue', `HTTP ${issue.status} ${brief(issue.body)}`);
}
const on = issue.body.onchain ?? {};
const issueOk =
  issue.body.assurance === 3 &&
  issue.body.regime === 2 &&
  issue.body.policyPreview?.production === false &&
  issue.body.policyPreview?.sandbox === true &&
  on.sent === true &&
  hex(on.txHash, 32) && hex(on.issuer, 20) &&
  hex(issue.body.claimsRoot, 32) && hex(issue.body.evidenceHash, 32) &&
  typeof issue.body.methodsHex === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(issue.body.methodsHex) &&
  Number.isSafeInteger(issue.body.expiry) && issue.body.expiry > 0 &&
  on.reverted === false &&
  Number.isSafeInteger(on.blockNumber) && on.blockNumber > 0;
check('g issue',
  issueOk,
  'checked sandbox attributes, commitment encodings and source confirmation fields');
if (!issueOk) die('g issue', 'the Sepolia transaction did not settle as expected', true);
info(`subject  ${subject}`);
info(`txHash   ${on.txHash}`);
info(`issuer   ${on.issuer}`);

// ─── h. cross-chain materialization on CC3 ─────────────────────────────────

info(`waiting for the relay worker to carry the mark to CC3 (poll every ${POLL_EVERY_MS / 1000}s, up to ${POLL_FOR_MS / 60000} min)`);
const started = Date.now();
let last = null;
let seen = false;
let observationState = 'awaiting-materialization';
const expectedMark = { subject, issuer: on.issuer, assurance: issue.body.assurance, methodsHex: issue.body.methodsHex,
  claimsRoot: issue.body.claimsRoot, evidenceHash: issue.body.evidenceHash, expiry: issue.body.expiry };
while (Date.now() - started < POLL_FOR_MS) {
  const r = await call('GET', `/api/onchain?subject=${subject}`);
  last = r;
  observationState = r.status === 200 ? assessDriverObservation(r.body, expectedMark) : 'observation-unavailable';
  if (observationState === 'api-roster-verdict-ready') { seen = true; break; }
  if (['incompatible', 'restricted', 'different-mark', 'different-witness'].includes(observationState)) {
    die('h cc3 observation', observationState);
  }
  const waited = Math.round((Date.now() - started) / 1000);
  info(`  ${waited}s — ${observationState}; a new epoch and matching current witness may require an operator`);
  await new Promise((r2) => setTimeout(r2, POLL_EVERY_MS));
}
const elapsed = Math.round((Date.now() - started) / 1000);
if (!seen) {
  die('h cc3 materialization', `API roster verdict not ready after ${elapsed}s: ${observationState}`);
}
const oc = last.body;
check('h cc3 materialization',
  assessDriverObservation(oc, expectedMark) === 'api-roster-verdict-ready',
  'checked matching mark, current approved witness, production false and pilot true');
info(`observed API roster-verdict wait: ${Math.floor(elapsed / 60)}m${elapsed % 60}s; includes polling/epoch/witness delays, not pure relay latency`);

// ─── result ────────────────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.log(`${failures} step(s) failed.`);
  process.exit(1);
}
console.log(`API checks passed. subject=${subject} txHash=${on.txHash} roster-verdict-wait=${elapsed}s`);
console.error('NOT VERIFIED: independently pinned chain state, source/hub event lineage or actual consumer transfer gate. T-39 full E2E is incomplete.');
process.exitCode = 2;
}

main().catch(error => die('driver', error instanceof DriverHttpError ? error.code : 'DRIVER_UNCONFIRMED_FAILURE'));
