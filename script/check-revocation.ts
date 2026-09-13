/** Read-only by default. --record appends a historical observation; never signs or broadcasts. */
import 'dotenv/config';
import { ethers } from 'ethers';
import { EvidenceVault } from '../pipeline/vault.js';
import { checkRevocation, RevocationCheckError } from '../pipeline/revocation-check.js';
import { revocationObservation, RevocationObservationError } from '../pipeline/revocation-observation.js';

const providers: ethers.JsonRpcProvider[] = [];
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RevocationCheckError('MISSING_CHECK_CONFIGURATION');
  return value;
}
function provider(name: string) {
  const url = new URL(required(name));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new RevocationCheckError('UNSAFE_RPC_URL');
  }
  const request = new ethers.FetchRequest(url.href); request.timeout = 10000;
  const result = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  providers.push(result); return result;
}
async function main() {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || (extra.length && (extra.length !== 1 || !['--record', '--history'].includes(extra[0])))) throw new RevocationCheckError('USAGE_CHECK_REVOCATION_REQUIRES_ONE_JOB_ID');
  const record = extra[0] === '--record';
  const operator = record ? required('COMPLIANCE_OPERATOR_ID') : undefined;
  const vault = new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
  const job = vault.getRevocation(id);
  if (!job) throw new RevocationCheckError('REVOCATION_JOB_NOT_FOUND');
  if (extra[0] === '--history') {
    console.log(JSON.stringify({ caseDigest: ethers.id(job.id), historicalOnly: true, currentEnforcement: 'NOT_CHECKED', observations: job.observations ?? [] }));
    console.log('Stored history only; no RPC, current eligibility check or vault mutation.');
    return;
  }
  const policyIds = required('REVOCATION_POLICY_IDS');
  if (!/^\d+(,\d+)*$/.test(policyIds)) throw new RevocationCheckError('INVALID_CHECK_CONFIG');
  const config = {
    source: required('SOURCE_CONTRACT_ADDRESS'), asc: required('REVOCATION_ASC_ADDRESS'), registry: required('REVOCATION_REGISTRY_ADDRESS'),
    expectedRevoker: required('REVOCATION_EXPECTED_REVOKER'), sourceCodeHash: required('REVOCATION_SOURCE_CODE_HASH'),
    ascCodeHash: required('REVOCATION_ASC_CODE_HASH'), registryCodeHash: required('REVOCATION_REGISTRY_CODE_HASH'),
    policyIds: policyIds.split(',').map(Number), confirmations: Number(required('RESCREEN_CONFIRMATIONS')),
  };
  const result = await checkRevocation(provider('SOURCE_CHAIN_RPC_URL'), provider('CREDITCOIN_RPC_URL'), job, config);
  if (record) vault.recordRevocationObservation(job.id, job, revocationObservation(result, config, operator!));
  console.log(JSON.stringify({ caseDigest: ethers.id(job.id), ...result }));
  console.log(record ? 'Historical observation recorded; source delivery/compliance/chain state unchanged. Recheck before relying on current enforcement.'
    : 'Read-only observation; no outbox, credential or chain state changed.');
  if (!result.enforced) process.exitCode = 1;
}
try { await main(); } catch (error) {
  console.error(error instanceof RevocationCheckError || error instanceof RevocationObservationError ? error.code : 'REVOCATION_CHECK_UNAVAILABLE');
  process.exitCode = 1;
} finally { providers.forEach(value => value.destroy()); }
