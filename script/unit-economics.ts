import { readFileSync, statSync } from 'node:fs';
import { economicsSensitivity, firstOperatingBreakEven, flatPilotCash, monthlyEconomics } from '../pipeline/unit-economics.js';

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error('usage: npm run economics -- <scenario.json>');
if (statSync(path).size > 100_000) throw new Error('scenario exceeds 100KB');
const config = JSON.parse(readFileSync(path, 'utf8'));
if (!config || config.version !== 1 || !['synthetic', 'unverified-inputs'].includes(config.basis)
  || !config.cases || typeof config.cases !== 'object' || Array.isArray(config.cases)
  || Object.keys(config.cases).sort().join(',') !== 'base,downside'
  || Object.keys(config).sort().join(',') !== 'basis,cases,version') throw new Error('expected version 1, explicit unverified basis, base/downside cases only');
const cases = Object.fromEntries(Object.entries(config.cases).map(([name, inputs]) => [name, {
  inputs, monthly: [100, 1000, 10_000].map(wallets => monthlyEconomics(inputs, wallets)),
  operatingBreakEven: firstOperatingBreakEven(inputs, 100_000),
  sensitivitiesAt1000Wallets: economicsSensitivity(inputs, 1000),
  flat12WeekCash: [100, 1000, 10_000].map(wallets => ({ activeWallets: wallets, ...flatPilotCash(inputs, wallets, 12) })),
}]));
console.log(JSON.stringify({ schema: 'proofmark-economics-v1', basis: config.basis, currency: 'USD', period: 'one month',
  unit: 'active wallet/month; institution count is a separate input',
  commercialEvidenceVerified: false, investmentDecision: 'not evaluated',
  limitations: ['Synthetic/unverified inputs are not vendor quotes, revenue or customer willingness to pay.',
    'No tax, receivables lag, currency conversion, legal approval, capacity hiring or forecast growth is modeled.',
    'First non-loss volume is bounded and conditional; batching can make higher volumes loss-making again.',
    'Financing is cash, never customer revenue; one-time costs are not recurring service margin.',
    'Retained-record ratio and all costs must be independently calibrated, including inactive former customers.'], cases }, null, 2));
