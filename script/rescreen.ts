import 'dotenv/config';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';
import { loadLists } from '../aml/loader.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { EvidenceVault } from '../pipeline/vault.js';
import { deliverRevocations, screenDue, type RevocationTransport } from '../pipeline/rescreen.js';
import { createEvmRevocationTransport } from '../pipeline/rescreen-evm.js';
import { writeRescreenRunState, type RescreenRunState } from '../pipeline/rescreen-schedule.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveSeconds = (name: string): number => {
  const raw = required(name), value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value * 1000) || value <= 0) throw new Error(`${name} must be positive whole seconds`);
  return value * 1000;
};

async function transport(): Promise<RevocationTransport & { close(): void }> {
  const provider = new ethers.JsonRpcProvider(required('SOURCE_CHAIN_RPC_URL'), undefined, { cacheTimeout: -1 });
  try {
    const wallet = new ethers.Wallet(required('RESCREEN_PRIVATE_KEY'), provider);
    const expected = required('RESCREEN_SIGNER_ADDRESS');
    if (!ethers.isAddress(expected) || expected === ethers.ZeroAddress || expected.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('RESCREEN_SIGNER_ROLE_MISMATCH');
    }
    const value = await createEvmRevocationTransport(provider, wallet, {
      chainId: Number(process.env.SOURCE_CHAIN_ID ?? 11_155_111), source: required('SOURCE_CONTRACT_ADDRESS'),
      confirmations: Number(process.env.RESCREEN_CONFIRMATIONS ?? 6),
      epoch: process.env.RESCREEN_EPOCH === undefined ? undefined : Number(process.env.RESCREEN_EPOCH),
    });
    return { ...value, close: () => provider.destroy() };
  } catch (error) { provider.destroy(); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--publish' && arg !== '--scheduled') || new Set(args).size !== args.length) throw new Error('usage: rescreen [--publish [--scheduled]]');
  const publish = args.includes('--publish'), scheduled = args.includes('--scheduled');
  if (scheduled && !publish) throw new Error('--scheduled requires --publish');
  const now = Date.now();
  const intervalHours = Number(process.env.RESCREEN_INTERVAL_HOURS ?? '24');
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) throw new Error('RESCREEN_INTERVAL_HOURS must be positive');
  const path = required('EVIDENCE_VAULT_PATH');
  const schedule = scheduled ? {
    path: required('RESCREEN_RUN_STATE_PATH'), id: required('RESCREEN_SCHEDULE_ID'), intervalMs: positiveSeconds('RESCREEN_SCHEDULE_INTERVAL_SECONDS'),
    snapshotId: required('SANCTIONS_EXPECTED_SNAPSHOT_ID'),
  } : undefined;
  if (schedule && !/^[0-9a-f]{64}$/.test(schedule.snapshotId)) throw new Error('SANCTIONS_EXPECTED_SNAPSHOT_ID must be a lowercase SHA-256 snapshot ID');
  if (schedule && [resolve(path), resolve(`${path}.lock`), resolve(`${path}.rescreen.lock`)].includes(resolve(schedule.path))) {
    throw new Error('RESCREEN_RUN_STATE_PATH must be separate from the vault and lock files');
  }
  const vault = new EvidenceVault(path, required('EVIDENCE_VAULT_KEY'));
  // Preview takes no lock and makes no filesystem writes. A publishing run has one exclusive owner.
  let lease: number | undefined;
  let sender: Awaited<ReturnType<typeof transport>> | undefined;
  let runStarted = false;
  let due = 0, blocked = 0, sourceConfirmed = 0, pending = 0;
  const leasePath = `${path}.rescreen.lock`;
  if (publish) {
    mkdirSync(dirname(path), { recursive: true });
    lease = openSync(leasePath, 'wx', 0o600);
  }
  try {
    if (lease !== undefined) writeFileSync(lease, JSON.stringify({ pid: process.pid, createdAt: now }));
    if (schedule) {
      writeRescreenRunState(schedule.path, { version: 2, scheduleId: schedule.id, sanctionsSnapshotId: schedule.snapshotId, phase: 'running',
        scheduleIntervalMs: schedule.intervalMs, startedAt: now });
      runStarted = true;
    }
    if (!publish) {
      console.log(`pending source revocations ${vault.listPendingRevocations().length}, legacy blocked records requiring recovery ${vault.listLegacyBlocked().length}`);
      for (const record of vault.listLegacyBlocked()) {
        console.log(`legacy BLOCK ${record.recordId.slice(0, 12)} ${record.walletAddress.slice(0, 8)}…${record.walletAddress.slice(-4)}`);
      }
    }
    sender = publish ? await transport() : undefined;
    if (publish) {
      // Recover old blocked records independently from any later approved deletion workflow.
      vault.recoverBlockedRevocations(now);
      const recovered = await deliverRevocations(vault, sender!);
      sourceConfirmed += recovered.confirmed; pending = recovered.pending;
      if (recovered.pending) throw new Error('existing revocations remain pending; inspect outbox before continuing');
    }
    const { entries, listVersions, provenance, maxAgeHours } = await loadLists('data/raw', 'rescreen');
    const engine = new ListBackedAmlEngine({ entries, listVersions, provenance, maxAgeHours,
      evidenceKey: required('EVIDENCE_HMAC_KEY'), keyId: process.env.EVIDENCE_KEY_ID ?? 'k1' });
    let results;
    try {
      results = await screenDue(vault, engine, { now, intervalMs: intervalHours * 3_600_000, persist: publish });
    } finally {
      // A later screening error must not strand already committed BLOCK decisions.
      if (publish) {
        const sent = await deliverRevocations(vault, sender!);
        sourceConfirmed += sent.confirmed; pending = sent.pending;
        console.log(`source revocations: confirmed ${sent.confirmed}, pending ${sent.pending}; hub propagation requires separate reconciliation`);
        if (sent.pending) process.exitCode = 1;
      }
    }
    due = results.length; blocked = results.filter(result => result.decision === 'BLOCK').length;
    for (const result of results) {
      console.log(`${result.recordId.slice(0, 12)} ${result.walletAddress.slice(0, 8)}…${result.walletAddress.slice(-4)} ${result.decision} band ${result.riskBand}`);
    }
    console.log(`${publish ? 'committed' : 'read-only preview'}: due ${results.length}, blocked ${results.filter(r => r.decision === 'BLOCK').length}`);
    console.log('Rescreen never deletes evidence. Use the separate approved vault deletion workflow.');
    if (!publish) console.log('No screening state or outbox was changed. --publish commits decisions and transmits revocations after operator review.');
    if (schedule) {
      const completedAt = Date.now();
      writeRescreenRunState(schedule.path, { version: 2, scheduleId: schedule.id, sanctionsSnapshotId: schedule.snapshotId, phase: 'succeeded', scheduleIntervalMs: schedule.intervalMs,
        startedAt: now, completedAt, due, blocked, sourceConfirmed, pending });
    }
  } catch (error) {
    if (schedule && runStarted) {
      const failed: RescreenRunState = { version: 2, scheduleId: schedule.id, sanctionsSnapshotId: schedule.snapshotId, phase: 'failed', scheduleIntervalMs: schedule.intervalMs,
        startedAt: now, completedAt: Date.now() };
      writeRescreenRunState(schedule.path, failed);
    }
    throw error;
  } finally {
    sender?.close();
    if (lease !== undefined) { closeSync(lease); unlinkSync(leasePath); }
  }
}

await main();
