import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { economicsInputs, economicsSensitivity, flatPilotCash, monthlyEconomics, firstOperatingBreakEven, type EconomicsInputs } from './unit-economics.js';

const scenarios = JSON.parse(readFileSync(new URL('../docs/economics/synthetic-scenarios.json', import.meta.url), 'utf8'));
function isolated(): EconomicsInputs {
  const value = Object.fromEntries(Object.keys(scenarios.cases.base).map(key => [key, 0]));
  return economicsInputs({ ...value, payingInstitutions: 1, pricePerBillableWalletUsd: 2,
    billableWalletFraction: 1, reviewMinutes: 1, investigatorHourlyUsd: 60, supportHourlyUsd: 60,
    sourceIssueBatchSize: 1, sourceRevokeBatchSize: 1, hubIssueBatchSize: 1, hubRevokeBatchSize: 1,
    storageCopies: 1, megabytesPerRetainedRecord: 1 });
}

test('vendor floors apply as max(minimum, usage), independently, never free below the minimum', () => {
  const input = { ...isolated(), issuancesPerWallet: 1, idCallsPerIssuance: 2, bankCallsPerIssuance: 3,
    rescreensPerWallet: 4, idCallUsd: 1, idMinimumUsd: 10, bankCallUsd: 2, bankMinimumUsd: 20,
    screeningCallUsd: 1, screeningMinimumUsd: 7 };
  const low = monthlyEconomics(input, 1);
  assert.deepEqual([low.costs.id, low.costs.bank, low.costs.screening], [10, 20, 7]);
  const high = monthlyEconomics(input, 10);
  assert.deepEqual([high.costs.id, high.costs.bank, high.costs.screening], [20, 60, 50]);
  assert.equal(monthlyEconomics(input, 0).serviceCostUsd, 37);
});

test('both chains, proof receipts, epoch overhead and rounded batches are charged separately', () => {
  const input = { ...isolated(), issuancesPerWallet: 1, revocationsPerWallet: 1, sourceIssueBatchSize: 2,
    hubIssueBatchSize: 3, sourceRevokeBatchSize: 3, hubRevokeBatchSize: 2,
    sourceIssueWriteUsd: 2, sourceRevokeWriteUsd: 3, sourceEpochWriteUsd: 5,
    hubIssueWriteUsd: 7, hubRevokeWriteUsd: 11, hubEpochWriteUsd: 13,
    hubWitnessWriteUsd: 17, witnessWritesPerWallet: 0.5, epochPublicationsPerMonth: 2,
    proofServicePerReceiptUsd: 19 };
  const result = monthlyEconomics(input, 3);
  assert.equal(result.costs.sourceGas, 4 + 3 + 10);
  assert.equal(result.costs.hubGas, 7 + 22 + 26 + 34);
  assert.equal(result.costs.proofService, (2 + 1 + 2) * 19);
  assert.equal(result.volumes.sourceWrites, 5);
  assert.equal(result.volumes.hubWrites, 7);
});

test('manual investigations and institutional plus wallet support use paid hours', () => {
  const input = { ...isolated(), issuancesPerWallet: 1, rescreensPerWallet: 10, issuanceReviewFraction: 0.2,
    rescreenReviewFraction: 0.1, reviewMinutes: 30, investigatorHourlyUsd: 40,
    payingInstitutions: 2, supportMinutesPerInstitution: 60, supportContactsPerWallet: 0.5,
    supportMinutesPerContact: 12, supportHourlyUsd: 30 };
  const result = monthlyEconomics(input, 10);
  assert.equal(result.volumes.reviews, 12);
  assert.equal(result.volumes.reviewHours, 6);
  assert.equal(result.costs.investigation, 240);
  assert.equal(result.volumes.supportHours, 3);
  assert.equal(result.costs.support, 90);
});

test('historic retained records and backup copies are not equated to one active-wallet record', () => {
  const result = monthlyEconomics({ ...isolated(), retainedRecordsPerWallet: 10, megabytesPerRetainedRecord: 2,
    storageCopies: 3, storageUsdPerGbMonth: 5, kmsOperationsPerRecord: 4, kmsUsdPerOperation: 0.1 }, 100);
  assert.equal(result.volumes.retainedRecords, 1000);
  assert.equal(result.volumes.storageGb, 6);
  assert.equal(result.costs.storage, 30);
  assert.equal(result.costs.kms, 400);
});

test('financing never becomes revenue; one-off spending and operating burn remain distinct', () => {
  const input = { ...isolated(), billableWalletFraction: 0.5, infrastructureUsd: 10,
    engineeringAndAdminUsd: 30, complianceAndInsuranceUsd: 20, oneTimePilotCostsUsd: 80,
    openingCashUsd: 20, financingCashUsd: 100 };
  const result = monthlyEconomics(input, 10);
  assert.equal(result.recurringRevenueUsd, 10);
  assert.equal(result.grossProfitUsd, 0);
  assert.equal(result.operatingProfitUsd, -50);
  assert.equal(result.operatingBurnUsd, 50);
  assert.equal(result.cashChangeBeforeFinancingUsd, -130);
  assert.equal(result.closingCashUsd, -10);
  assert.equal(result.financingGapUsd, 10);
  assert.equal(monthlyEconomics(input, 0).grossMargin, null);
  assert.equal(monthlyEconomics(input, 0).serviceCostPerActiveWalletUsd, null);
});

test('break-even search is bounded and does not assume batching makes profit monotone', () => {
  const input = { ...isolated(), pricePerBillableWalletUsd: 3, issuancesPerWallet: 1,
    sourceIssueBatchSize: 2, sourceIssueWriteUsd: 5, infrastructureUsd: 0.1 };
  assert.deepEqual(firstOperatingBreakEven(input, 1), { firstNonLossWallets: null, searchedThrough: 1 });
  assert.deepEqual(firstOperatingBreakEven(input, 100), { firstNonLossWallets: 2, searchedThrough: 2 });
  assert.ok(monthlyEconomics(input, 3).operatingProfitUsd < 0);
  assert.throws(() => firstOperatingBreakEven(input, 100001), /bound/);
});

test('missing/unknown/nonfinite inputs, free labor, invalid fractions and fractional volumes are rejected', () => {
  const input = isolated(); const { bankMinimumUsd: omitted, ...missing } = input; void omitted;
  assert.throws(() => economicsInputs(missing), /bankMinimumUsd/);
  assert.throws(() => economicsInputs(Object.create(input)), /missing/);
  assert.throws(() => economicsInputs({ ...input, guessedPrice: 1 }), /unknown/);
  for (const value of [NaN, Infinity, -1, '1', null]) assert.throws(() => economicsInputs({ ...input, idCallUsd: value }), /invalid/);
  assert.throws(() => economicsInputs({ ...input, investigatorHourlyUsd: 0 }), /positive/);
  assert.throws(() => economicsInputs({ ...input, billableWalletFraction: 1.1 }), /fraction/);
  assert.throws(() => economicsInputs({ ...input, sourceIssueBatchSize: 1.5 }), /integer/);
  assert.throws(() => monthlyEconomics(input, 1.5), /integer/);
  const detached = economicsInputs(input); detached.idCallUsd = 12; assert.equal(input.idCallUsd, 0);
});

test('one-at-a-time sensitivities preserve input and twelve weeks is not silently treated as three months', () => {
  const input = economicsInputs(scenarios.cases.base); const original = structuredClone(input);
  const changes = economicsSensitivity(input, 1000);
  assert.equal(changes.length, 3);
  assert.ok(changes.every(result => result.operatingProfitDeltaUsd < 0));
  assert.deepEqual(input, original);
  const simple = { ...isolated(), infrastructureUsd: 130, openingCashUsd: 1000, financingCashUsd: 200, oneTimePilotCostsUsd: 50 };
  const cash = flatPilotCash(simple, 0, 12);
  assert.equal(cash.monthEquivalent, 36 / 13);
  assert.equal(cash.operatingCashUsd, -360);
  assert.equal(cash.closingCashUsd, 790);
  assert.throws(() => flatPilotCash(simple, 0, Infinity), /weeks/);
});

test('actual CLI produces all six scenarios with synthetic status and no investment-ready claim', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'script/unit-economics.ts', 'docs/economics/synthetic-scenarios.json'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.basis, 'synthetic'); assert.equal(report.commercialEvidenceVerified, false);
  assert.equal(report.investmentDecision, 'not evaluated');
  for (const name of ['base', 'downside']) assert.deepEqual(report.cases[name].monthly.map((row: { activeWallets: number }) => row.activeWallets), [100, 1000, 10000]);
  assert.ok(report.cases.base.monthly[2].operatingProfitUsd > report.cases.downside.monthly[2].operatingProfitUsd);
});
