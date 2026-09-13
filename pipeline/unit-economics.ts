/** Planning arithmetic only. No prices, quotes, traction or investment approval are inferred. */
export interface EconomicsInputs {
  payingInstitutions: number;
  pricePerBillableWalletUsd: number;
  billableWalletFraction: number;
  issuancesPerWallet: number;
  idCallsPerIssuance: number;
  bankCallsPerIssuance: number;
  rescreensPerWallet: number;
  revocationsPerWallet: number;
  witnessWritesPerWallet: number;
  epochPublicationsPerMonth: number;
  issuanceReviewFraction: number;
  rescreenReviewFraction: number;
  reviewMinutes: number;
  investigatorHourlyUsd: number;
  supportMinutesPerInstitution: number;
  supportContactsPerWallet: number;
  supportMinutesPerContact: number;
  supportHourlyUsd: number;
  idCallUsd: number;
  idMinimumUsd: number;
  bankCallUsd: number;
  bankMinimumUsd: number;
  screeningCallUsd: number;
  screeningMinimumUsd: number;
  sourceIssueWriteUsd: number;
  sourceRevokeWriteUsd: number;
  sourceEpochWriteUsd: number;
  hubIssueWriteUsd: number;
  hubRevokeWriteUsd: number;
  hubEpochWriteUsd: number;
  hubWitnessWriteUsd: number;
  proofServicePerReceiptUsd: number;
  sourceIssueBatchSize: number;
  sourceRevokeBatchSize: number;
  hubIssueBatchSize: number;
  hubRevokeBatchSize: number;
  retainedRecordsPerWallet: number;
  megabytesPerRetainedRecord: number;
  storageCopies: number;
  storageUsdPerGbMonth: number;
  kmsOperationsPerRecord: number;
  kmsUsdPerOperation: number;
  infrastructureUsd: number;
  engineeringAndAdminUsd: number;
  complianceAndInsuranceUsd: number;
  oneTimePilotCostsUsd: number;
  openingCashUsd: number;
  financingCashUsd: number;
}

const fields = [
  'payingInstitutions', 'pricePerBillableWalletUsd', 'billableWalletFraction', 'issuancesPerWallet',
  'idCallsPerIssuance', 'bankCallsPerIssuance', 'rescreensPerWallet', 'revocationsPerWallet',
  'witnessWritesPerWallet', 'epochPublicationsPerMonth', 'issuanceReviewFraction', 'rescreenReviewFraction',
  'reviewMinutes', 'investigatorHourlyUsd', 'supportMinutesPerInstitution', 'supportContactsPerWallet',
  'supportMinutesPerContact', 'supportHourlyUsd', 'idCallUsd', 'idMinimumUsd', 'bankCallUsd', 'bankMinimumUsd',
  'screeningCallUsd', 'screeningMinimumUsd', 'sourceIssueWriteUsd', 'sourceRevokeWriteUsd', 'sourceEpochWriteUsd',
  'hubIssueWriteUsd', 'hubRevokeWriteUsd', 'hubEpochWriteUsd', 'hubWitnessWriteUsd', 'proofServicePerReceiptUsd',
  'sourceIssueBatchSize', 'sourceRevokeBatchSize', 'hubIssueBatchSize', 'hubRevokeBatchSize',
  'retainedRecordsPerWallet', 'megabytesPerRetainedRecord', 'storageCopies', 'storageUsdPerGbMonth',
  'kmsOperationsPerRecord', 'kmsUsdPerOperation', 'infrastructureUsd', 'engineeringAndAdminUsd',
  'complianceAndInsuranceUsd', 'oneTimePilotCostsUsd', 'openingCashUsd', 'financingCashUsd',
] as const satisfies readonly (keyof EconomicsInputs)[];
const positive = ['payingInstitutions', 'pricePerBillableWalletUsd', 'reviewMinutes', 'investigatorHourlyUsd',
  'supportHourlyUsd', 'sourceIssueBatchSize', 'sourceRevokeBatchSize', 'hubIssueBatchSize', 'hubRevokeBatchSize',
  'storageCopies', 'megabytesPerRetainedRecord'] as const;
const integers = ['payingInstitutions', 'sourceIssueBatchSize', 'sourceRevokeBatchSize', 'hubIssueBatchSize',
  'hubRevokeBatchSize', 'epochPublicationsPerMonth', 'storageCopies'] as const;

export function economicsInputs(value: unknown): EconomicsInputs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('inputs must be an object');
  const raw = value as Record<string, unknown>;
  for (const field of Object.keys(raw)) if (!(fields as readonly string[]).includes(field)) throw new Error(`unknown input: ${field}`);
  for (const field of fields) {
    const amount = raw[field];
    if (!Object.hasOwn(raw, field) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new Error(`missing/invalid input: ${field}`);
  }
  const input = raw as unknown as EconomicsInputs;
  for (const field of positive) if (input[field] <= 0) throw new Error(`${field} must be positive; do not hide labor or missing assumptions as zero`);
  for (const field of integers) if (!Number.isSafeInteger(input[field])) throw new Error(`${field} must be an integer`);
  for (const field of ['billableWalletFraction', 'issuanceReviewFraction', 'rescreenReviewFraction'] as const) {
    if (input[field] > 1) throw new Error(`${field} must be a fraction in [0,1]`);
  }
  return { ...input };
}

function calculate(i: EconomicsInputs, wallets: number) {
  const issuances = wallets * i.issuancesPerWallet;
  const rescreens = wallets * i.rescreensPerWallet;
  const revocations = wallets * i.revocationsPerWallet;
  const sourceIssue = Math.ceil(issuances / i.sourceIssueBatchSize);
  const sourceRevoke = Math.ceil(revocations / i.sourceRevokeBatchSize);
  const hubIssue = Math.ceil(issuances / i.hubIssueBatchSize);
  const hubRevoke = Math.ceil(revocations / i.hubRevokeBatchSize);
  const epochs = i.epochPublicationsPerMonth;
  const witnesses = Math.ceil(wallets * i.witnessWritesPerWallet);
  const idCalls = issuances * i.idCallsPerIssuance;
  const bankCalls = issuances * i.bankCallsPerIssuance;
  const screeningCalls = issuances + rescreens;
  const reviews = issuances * i.issuanceReviewFraction + rescreens * i.rescreenReviewFraction;
  const reviewHours = reviews * i.reviewMinutes / 60;
  const supportHours = (i.payingInstitutions * i.supportMinutesPerInstitution
    + wallets * i.supportContactsPerWallet * i.supportMinutesPerContact) / 60;
  const retainedRecords = wallets * i.retainedRecordsPerWallet;
  const storageGb = retainedRecords * i.megabytesPerRetainedRecord * i.storageCopies / 1000;
  const costs = {
    id: Math.max(i.idMinimumUsd, idCalls * i.idCallUsd),
    bank: Math.max(i.bankMinimumUsd, bankCalls * i.bankCallUsd),
    screening: Math.max(i.screeningMinimumUsd, screeningCalls * i.screeningCallUsd),
    sourceGas: sourceIssue * i.sourceIssueWriteUsd + sourceRevoke * i.sourceRevokeWriteUsd + epochs * i.sourceEpochWriteUsd,
    hubGas: hubIssue * i.hubIssueWriteUsd + hubRevoke * i.hubRevokeWriteUsd + epochs * i.hubEpochWriteUsd + witnesses * i.hubWitnessWriteUsd,
    proofService: (sourceIssue + sourceRevoke + epochs) * i.proofServicePerReceiptUsd,
    investigation: reviewHours * i.investigatorHourlyUsd,
    support: supportHours * i.supportHourlyUsd,
    storage: storageGb * i.storageUsdPerGbMonth,
    kms: retainedRecords * i.kmsOperationsPerRecord * i.kmsUsdPerOperation,
    infrastructure: i.infrastructureUsd,
  };
  const recurringRevenueUsd = wallets * i.billableWalletFraction * i.pricePerBillableWalletUsd;
  const serviceCostUsd = Object.values(costs).reduce((sum, cost) => sum + cost, 0);
  const grossProfitUsd = recurringRevenueUsd - serviceCostUsd;
  const operatingExpenseUsd = i.engineeringAndAdminUsd + i.complianceAndInsuranceUsd;
  const operatingProfitUsd = grossProfitUsd - operatingExpenseUsd;
  const cashChangeBeforeFinancingUsd = operatingProfitUsd - i.oneTimePilotCostsUsd;
  const closingCashUsd = i.openingCashUsd + i.financingCashUsd + cashChangeBeforeFinancingUsd;
  return {
    activeWallets: wallets, payingInstitutions: i.payingInstitutions,
    volumes: { billableWallets: wallets * i.billableWalletFraction, issuances, idCalls, bankCalls, rescreens,
      screeningCalls, revocations, reviews, reviewHours, supportHours, retainedRecords, storageGb,
      sourceWrites: sourceIssue + sourceRevoke + epochs, hubWrites: hubIssue + hubRevoke + epochs + witnesses },
    costs, recurringRevenueUsd, serviceCostUsd, grossProfitUsd,
    grossMargin: recurringRevenueUsd === 0 ? null : grossProfitUsd / recurringRevenueUsd,
    serviceCostPerActiveWalletUsd: wallets === 0 ? null : serviceCostUsd / wallets,
    operatingExpenseUsd, operatingProfitUsd,
    operatingBurnUsd: Math.max(0, -operatingProfitUsd),
    oneTimePilotCostsUsd: i.oneTimePilotCostsUsd, cashChangeBeforeFinancingUsd,
    openingCashUsd: i.openingCashUsd, financingCashUsd: i.financingCashUsd, closingCashUsd,
    financingGapUsd: Math.max(0, -closingCashUsd),
  };
}
export function monthlyEconomics(input: unknown, activeWallets: number) {
  const checked = economicsInputs(input);
  if (!Number.isSafeInteger(activeWallets) || activeWallets < 0 || activeWallets > 1_000_000) throw new Error('active wallets must be an integer from 0 to 1000000');
  const result = calculate(checked, activeWallets);
  if (Object.values(result.costs).some(value => !Number.isFinite(value))) throw new Error('cost overflow');
  return result;
}

/** Exhaustive bounded search: batching makes binary search's monotonicity assumption unsafe. */
export function firstOperatingBreakEven(input: unknown, maxWallets: number) {
  const checked = economicsInputs(input);
  if (!Number.isSafeInteger(maxWallets) || maxWallets < 0 || maxWallets > 100_000) throw new Error('break-even search bound must be an integer from 0 to 100000');
  for (let wallets = 0; wallets <= maxWallets; wallets++) {
    if (calculate(checked, wallets).operatingProfitUsd >= 0) return { firstNonLossWallets: wallets, searchedThrough: wallets };
  }
  return { firstNonLossWallets: null, searchedThrough: maxWallets };
}

export function economicsSensitivity(input: unknown, activeWallets: number) {
  const i = economicsInputs(input);
  const base = monthlyEconomics(i, activeWallets);
  const gasFields = ['sourceIssueWriteUsd', 'sourceRevokeWriteUsd', 'sourceEpochWriteUsd', 'hubIssueWriteUsd',
    'hubRevokeWriteUsd', 'hubEpochWriteUsd', 'hubWitnessWriteUsd'] as const;
  const gasOverrides = Object.fromEntries(gasFields.map(field => [field, i[field] * 10]));
  const scenarios = {
    reviewFractionsDoubled: { issuanceReviewFraction: Math.min(1, i.issuanceReviewFraction * 2),
      rescreenReviewFraction: Math.min(1, i.rescreenReviewFraction * 2) },
    bothChainGasTimesTen: gasOverrides,
    issuanceFrequencyDoubled: { issuancesPerWallet: i.issuancesPerWallet * 2 },
  };
  return Object.entries(scenarios).map(([name, overrides]) => {
    const result = monthlyEconomics({ ...i, ...overrides }, activeWallets);
    return { name, overrides, operatingProfitUsd: result.operatingProfitUsd,
      operatingProfitDeltaUsd: result.operatingProfitUsd - base.operatingProfitUsd,
      serviceCostDeltaUsd: result.serviceCostUsd - base.serviceCostUsd };
  });
}

export function flatPilotCash(input: unknown, activeWallets: number, weeks: number) {
  if (!Number.isFinite(weeks) || weeks <= 0 || weeks > 52) throw new Error('pilot weeks must be in (0,52]');
  const month = monthlyEconomics(input, activeWallets);
  const monthEquivalent = weeks * 12 / 52;
  const operatingCashUsd = month.operatingProfitUsd * monthEquivalent;
  const closingCashUsd = month.openingCashUsd + month.financingCashUsd + operatingCashUsd - month.oneTimePilotCostsUsd;
  return { weeks, monthEquivalent, operatingCashUsd, oneTimePilotCostsUsd: month.oneTimePilotCostsUsd,
    financingCashUsd: month.financingCashUsd, closingCashUsd, financingGapUsd: Math.max(0, -closingCashUsd),
    assumption: 'flat volume/prices, cash collected and paid immediately, financing available at start; not a tranche forecast' };
}
