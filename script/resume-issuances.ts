import 'dotenv/config';
import { ethers } from 'ethers';
import { RedisIssuanceJournal, IssuanceJournalError } from '../pipeline/issuance-journal.js';
import { advanceIssuance } from '../pipeline/issuance-delivery.js';
import { EvmIssuanceTransport, RotatingIssuerEvmTransport, issuanceProvider } from '../pipeline/issuance-evm.js';
import { issuanceEvidenceSink } from '../pipeline/issuance-evidence.js';
import { EvidenceVault } from '../pipeline/vault.js';
import { RedisIssuanceBudget } from '../pipeline/issuance-budget.js';

const required = (name: string) => {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value;
};
const journal = new RedisIssuanceJournal(required('ISSUANCE_JOURNAL_REDIS_REST_URL'), required('ISSUANCE_JOURNAL_REDIS_REST_TOKEN'),
  required('ISSUANCE_JOURNAL_KEY'), fetch, process.env.ISSUANCE_JOURNAL_NAMESPACE?.trim() || 'proofmark');
const positive = (name: string) => {
  const value = required(name); if (!/^\d+$/.test(value) || BigInt(value) < 1n || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} must be a positive safe integer`);
  return value;
};
const pending = await journal.pending();
if (!process.argv.includes('--publish')) {
  for (const id of pending) {
    const snapshot = await journal.get(id);
    if (snapshot) console.log(`${id} ${snapshot.entry.phase} ${snapshot.entry.transaction?.hash ?? 'unsigned'}`);
  }
  console.log(`read-only inspection: ${pending.length} pending request(s); --publish resumes signing/broadcast/reconciliation`);
} else {
  const source = issuanceProvider(required('NEXT_PUBLIC_SEPOLIA_RPC'));
  const hub = issuanceProvider(required('NEXT_PUBLIC_CC3_RPC'));
  const signer = new ethers.Wallet(required('ISSUER_PRIVATE_KEY'), source);
  const stable = process.env.ROTATING_ISSUER_ADDRESS?.trim();
  const epoch = Number(process.env.ISSUER_KEY_EPOCH);
  if (!!stable !== !!process.env.ISSUER_KEY_EPOCH?.trim() || (stable && (!Number.isSafeInteger(epoch) || epoch < 1))) {
    throw new Error('ROTATING_ISSUER_ADDRESS and a positive ISSUER_KEY_EPOCH must be configured together');
  }
  const base = { chainId: 11155111, source: ethers.getAddress(required('NEXT_PUBLIC_SOURCE')),
    hubChainId: 102031, asc: ethers.getAddress(required('NEXT_PUBLIC_ASC')) };
  const target = stable
    ? { ...base, issuer: ethers.getAddress(stable), issuerMode: 'rotating' as const, operatingKey: signer.address, issuerKeyEpoch: epoch }
    : { ...base, issuer: signer.address, issuerMode: 'direct' as const };
  const transport = stable
    ? new RotatingIssuerEvmTransport(source, hub, signer, Number(process.env.ISSUANCE_CONFIRMATIONS ?? 6), target)
    : new EvmIssuanceTransport(source, hub, signer, Number(process.env.ISSUANCE_CONFIRMATIONS ?? 6), target);
  const budget = new RedisIssuanceBudget({ url: required('ISSUANCE_JOURNAL_REDIS_REST_URL'),
    token: required('ISSUANCE_JOURNAL_REDIS_REST_TOKEN'), secret: required('ISSUANCE_GAS_BUDGET_KEY'),
    namespace: process.env.ISSUANCE_JOURNAL_NAMESPACE?.trim() || 'proofmark',
    dailyGasLimit: BigInt(positive('ISSUANCE_DAILY_GAS_LIMIT')),
    dailyTransactionLimit: Number(positive('ISSUANCE_DAILY_TRANSACTION_LIMIT')) });
  let vault: EvidenceVault | undefined;
  const sink = issuanceEvidenceSink(entry => {
    if (!entry.evidenceRecord) return null;
    if (process.env.VERCEL) throw new Error('persistent evidence vault required');
    return vault ??= new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
  });
  try {
    for (const id of pending) {
      try {
        const result = await advanceIssuance(journal, id, transport, sink, { budget });
        console.log(`${id} ${result.entry.phase} ${result.entry.lastError ?? 'ok'}`);
        if (result.entry.lastError) process.exitCode = 1;
      } catch (error) {
        console.log(`${id} ${error instanceof IssuanceJournalError ? error.code : 'DEPENDENCY_UNAVAILABLE'}`);
        process.exitCode = 1;
      }
    }
  } finally { source.destroy(); hub.destroy(); }
}
