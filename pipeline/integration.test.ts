import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { loadLists } from '../aml/loader.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { KrAdapter, Regime, type IdDocumentVendor, type BankAccountVendor } from './adapters/kr.js';
import { runIssuance, type IssueRequest } from './issue.js';
import { unpackAttrs } from './attrs.js';
import { Methods } from './methods.js';
import type { AmlEngine } from './aml.js';
import { containsPii } from './pii-guard.js';

/**
 * The real AML engine wired into the issuance pipeline.
 *
 * What this file checks is whether honesty is enforced by code:
 *   - screening that ran sets its bit
 *   - a check that did not happen leaves its bit unset
 *   - and therefore which policies our own mark passes and which it fails
 */

const HAVE_LISTS = existsSync('data/raw/ofac_sdn.xml');

/** Deployed policyId 1, KR VASP production */
const POLICY_KR_VASP =
  Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;

/** policyId 2, KR pilot. Built only from checks we actually perform. */
const POLICY_PILOT =
  Methods.WALLET_CONTROL | Methods.JURISDICTION_CHECK |
  Methods.SANCTIONS_SCREENED | Methods.ONCHAIN_EXPOSURE;

describe('real AML engine with the issuance pipeline', { skip: HAVE_LISTS ? false : 'source lists missing from data/raw (run bash aml/fetch-lists.sh)' }, () => {
  let aml: AmlEngine;

  before(async () => {
    const { entries, listVersions } = await loadLists();
    aml = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'test-only-evidence-key', keyId: 'test-k1' });
  });

  const NOW = 1_700_000_000_000;
  const cleanReq: IssueRequest = {
    wallet: '0x' + 'ab'.repeat(20),
    declared: { fullName: '박서준', dateOfBirth: '1988-03-14', nationality: 'KR', residence: 'KR' },
    idImage: null,
    walletControlProven: true,
    jurisdiction: 410,
    assurance: 3,
  };

  test('with real lists, SANCTIONS_SCREENED is earned', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    const names = new Set(out.methodNames);
    assert.ok(names.has('SANCTIONS_SCREENED'), 'we read the real lists, so the bit belongs here');
    assert.ok(names.has('JURISDICTION_CHECK'));
    assert.ok(names.has('ONCHAIN_EXPOSURE'), 'we compared against OFAC sanctioned wallets, so this belongs here');
    assert.ok(names.has('WALLET_CONTROL'));
  });

  test('screening with no data source still leaves its bit unset', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    const names = new Set(out.methodNames);
    assert.ok(!names.has('PEP_SCREENED'), 'the PEP bit is set with no PEP data connected');
    assert.ok(!names.has('ADVERSE_MEDIA'), 'the adverse media bit is set with no data connected');
  });

  test('with no vendor, the document and bank bits stay unset', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    const names = new Set(out.methodNames);
    assert.ok(!names.has('ID_DOC_AUTHENTICITY'), 'the authenticity bit is set with no institutional agreement in place');
    assert.ok(!names.has('BANK_ACCOUNT'), 'the bank account bit is set with no open banking partnership');
    assert.equal(unpackAttrs(out.attrs).regime, Regime.KR_FSC_NONFACE_SANDBOX);
  });

  //   // The point: the two policies reach different answers

  test('our own mark cannot pass the KR VASP production policy', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    assert.notEqual(out.methods & POLICY_KR_VASP, POLICY_KR_VASP,
      'passing production with no document or bank vendor would be a lie');
  });

  test('our own mark passes the pilot policy', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    assert.equal(out.methods & POLICY_PILOT, POLICY_PILOT,
      'a policy built from checks we actually run should pass');
  });

  //   // Sanctioned subjects are blocked

  test('a sanctioned jurisdiction is denied', async () => {
    const out = await runIssuance(
      { ...cleanReq, declared: { ...cleanReq.declared, nationality: 'KP', residence: 'KP' } },
      new KrAdapter(null, null), aml, NOW);
    assert.ok(out.status === 'DENIED' || out.status === 'REVIEW',
      `high-risk jurisdiction came back as ${out.status}`);
  });

  // PII in evidence

  /**
   * `ScreeningEvidence` carries no cleartext name. Evidence lives off chain, but PII in it
   * puts the right to erasure against the audit trail: erase the vault and `evidenceHash`
   * can no longer be recomputed, which leaves the evidence worthless.
   *
   * Keyed HMAC digests keep the evidence permanent while the vault stays erasable.
   */
  test('the real engine leaves no cleartext PII in the evidence', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    // romanised forms derive from the name, so check those too
    assert.ok(!containsPii(out.evidence, '박서준'), 'a cleartext name is present in the evidence');
    assert.ok(!containsPii(out.evidence, 'park seojun'), 'a romanised form is present in cleartext');
  });

  // With vendors connected, production passes too

  test('with vendors connected the production policy passes, so nothing is blocked by design', async () => {
    const idVendor: IdDocumentVendor = {
      async verify() {
        return { fullName: '박서준', dateOfBirth: '1988-03-14', docHash: '0xdoc',
                 authenticityChecked: true, faceMatched: true, livenessPassed: true };
      },
    };
    const bankVendor: BankAccountVendor = {
      async verifyHolder() { return { holderName: '박서준', verified: true }; },
    };

    const out = await runIssuance(
      { ...cleanReq, idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' } },
      new KrAdapter(idVendor, bankVendor), aml, NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    assert.equal(out.methods & POLICY_KR_VASP, POLICY_KR_VASP,
      'production should pass once vendors are connected; failing here would be a design fault');
    assert.equal(unpackAttrs(out.attrs).regime, Regime.KR_FSC_NONFACE);
  });
});
