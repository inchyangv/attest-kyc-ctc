import 'dotenv/config';
import { ethers } from 'ethers';
import { loadLists } from '../aml/loader.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { EvidenceVault } from '../pipeline/vault.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const publish = process.argv.includes('--publish');
const now = Date.now();
const intervalHours = Number(process.env.RESCREEN_INTERVAL_HOURS ?? '24');
if (!Number.isFinite(intervalHours) || intervalHours <= 0) throw new Error('RESCREEN_INTERVAL_HOURS must be positive');

const vault = new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
const purged = vault.purgeExpired(now);
const due = vault.listForRescreen(now, intervalHours * 3_600_000);
const { entries, listVersions } = await loadLists();
const engine = new ListBackedAmlEngine({
  entries,
  listVersions,
  evidenceKey: required('EVIDENCE_HMAC_KEY'),
  keyId: process.env.EVIDENCE_KEY_ID ?? 'k1',
});

const blocked: string[] = [];
for (const record of due) {
  const result = await engine.screen(record.screeningSubject);
  vault.recordRescreen(record.id, {
    at: now,
    decision: result.decision,
    reason: result.reviewReason,
    listVersions: result.listVersions,
  });
  if (result.decision === 'BLOCK') blocked.push(record.walletAddress);
  const wallet = `${record.walletAddress.slice(0, 8)}…${record.walletAddress.slice(-4)}`;
  console.log(`${record.id.slice(0, 12)} ${wallet} ${result.decision} band ${result.riskBand}`);
}

if (publish && blocked.length) {
  const provider = new ethers.JsonRpcProvider(required('SOURCE_CHAIN_RPC_URL'));
  const signer = new ethers.Wallet(required('DEPLOYER_PRIVATE_KEY'), provider);
  const source = new ethers.Contract(required('SOURCE_CONTRACT_ADDRESS'), [
    'function revokeBatch(address[] subjects, uint16[] reasonCodes, uint32 epoch)',
  ], signer);
  const epoch = Number(process.env.RESCREEN_EPOCH ?? Math.floor(now / 1000));
  if (!Number.isInteger(epoch) || epoch <= 0 || epoch > 0xffffffff) throw new Error('RESCREEN_EPOCH must fit uint32');
  const tx = await source.revokeBatch(blocked, blocked.map(() => 2), epoch);
  console.log(`submitted ${blocked.length} RESCREEN_HIT revocation(s): ${tx.hash}`);
  await tx.wait();
  console.log('revocation batch confirmed');
} else if (blocked.length) {
  console.log(`dry run: ${blocked.length} block decision(s); rerun with --publish after human review`);
}

console.log(`complete: due ${due.length}, blocked ${blocked.length}, retention purged ${purged}`);
