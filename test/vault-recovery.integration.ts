import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { packAttrs } from '../pipeline/attrs.js';
import { EvidenceVault, type VaultRecord } from '../pipeline/vault.js';

const OLD_KEY = 'synthetic-anvil-vault-old-key-at-least-32-characters';
const NEW_KEY = 'synthetic-anvil-vault-next-key-at-least-32-characters';

test('isolated source receipt commitments survive key rotation and bounded backup/restore drill', async t => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111', '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); } });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 11155111, { cacheTimeout: -1 }); t.after(() => provider.destroy());
  for (let attempt = 0; ; attempt++) {
    try { await provider.getBlockNumber(); break; }
    catch { if (attempt === 30) throw new Error('isolated Anvil did not start'); await delay(100); }
  }
  const mnemonic = 'test test test test test test test test test test test junk';
  const owner = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").privateKey, provider);
  const artifact = JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8'));
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(owner.address);
  await deployed.waitForDeployment();
  const source = new ethers.Contract(await deployed.getAddress(), artifact.abi, owner);
  await (await source.setIssuer(owner.address, true)).wait();
  const subject = ethers.Wallet.createRandom().address, now = (await provider.getBlock('latest'))!.timestamp;
  const attrs = packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 1,
    issuedAt: now, expiry: now + 86_400, epoch: 0 });
  const claimsRoot = ethers.id('synthetic recovery claims'), evidenceHash = ethers.id('synthetic recovery evidence');
  const tx = await source.issueOnce(ethers.id('synthetic recovery request'), subject, attrs, claimsRoot, evidenceHash);
  const receipt = await tx.wait(); assert.ok(receipt);
  const issued = receipt.logs.map((log: ethers.Log) => source.interface.parseLog(log)).find((log: ethers.LogDescription | null) => log?.name === 'MarkIssued');
  assert.ok(issued); assert.equal(issued.args.subject, subject); assert.equal(issued.args.claimsRoot, claimsRoot); assert.equal(issued.args.evidenceHash, evidenceHash);

  const dir = mkdtempSync(join(tmpdir(), 'proofmark-vault-anvil-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), backupPath = join(dir, 'backup.enc'), restorePath = join(dir, 'restored.enc');
  const vault = new EvidenceVault(path, OLD_KEY);
  const record: VaultRecord = { id: 'synthetic-recovery-request', walletAddress: subject, consentVersion: 'synthetic-v1',
    screeningSubject: { fullName: 'SYNTHETIC PRIVATE NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: subject },
    attrs, claimsRoot, evidenceHash, evidence: { synthetic: true }, state: 'pending', createdAt: Date.now(), retentionUntil: Date.now() + 86_400_000,
    reviews: [], rescreens: [], sourceIssuance: { transactionHash: receipt.hash, chainId: 11155111,
      source: await source.getAddress(), observedAt: Date.now() } };
  vault.put(record);
  const rotated = vault.rotateKey(NEW_KEY, 'synthetic-key-custodian'); assert.ok(rotated.revision > 0);
  assert.throws(() => new EvidenceVault(path, OLD_KEY), /authentication failed/);

  const manifest = vault.createBackup(backupPath);
  await delay(25); // Synthetic incident gap used only to exercise the measurement path.
  const restoreStartedAt = Date.now();
  const restored = EvidenceVault.restoreBackup(backupPath, restorePath, NEW_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision, erasedRecordIds: [],
    commitments: [{ recordId: record.id, walletAddress: issued.args.subject, claimsRoot: issued.args.claimsRoot,
      evidenceHash: issued.args.evidenceHash, sourceTransactionHash: receipt.hash }],
  });
  const completedAt = Date.now(), rpoMs = restoreStartedAt - manifest.createdAt, rtoMs = completedAt - restoreStartedAt;
  assert.equal(restored.matchedCommitments, 1);
  assert.ok(rpoMs >= 25 && rpoMs < 2_000, `synthetic RPO observation ${rpoMs}ms`);
  assert.ok(rtoMs < 2_000, `synthetic RTO observation ${rtoMs}ms`);
  assert.deepEqual(new EvidenceVault(restorePath, NEW_KEY).get(record.id), record);
  t.diagnostic(`synthetic recovery observation: RPO ${rpoMs}ms, RTO ${rtoMs}ms, matched commitments 1`);
});
