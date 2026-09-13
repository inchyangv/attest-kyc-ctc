import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EvidenceVault, type RevocationJob } from './vault.js';
import { checkRevocation, REVOCATION_ASC_ABI, REVOCATION_REGISTRY_ABI, type RevocationCheckConfig } from './revocation-check.js';

function fixture() {
  const source = '0x' + '11'.repeat(20), asc = '0x' + '22'.repeat(20), registry = '0x' + '33'.repeat(20);
  const revoker = '0x' + '44'.repeat(20), subject = '0x' + '55'.repeat(20), now = 1800000000;
  const job: RevocationJob = { id: 'synthetic:revoke:1', recordId: 'synthetic', walletAddress: subject, createdAt: 1, state: 'confirmed',
    transaction: { hash: ethers.id('synthetic-tx'), raw: '', chainId: 11155111, source }, sourceTarget: { chainId: 11155111, source } };
  const config: RevocationCheckConfig = { source, asc, registry, expectedRevoker: revoker,
    sourceCodeHash: ethers.keccak256('0x6001'), ascCodeHash: ethers.keccak256('0x6002'), registryCodeHash: ethers.keccak256('0x6003'),
    policyIds: [1, 2], confirmations: 6 };
  const abi = new ethers.Interface(['event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)']);
  const event = abi.encodeEventLog(abi.getEvent('MarkRevoked')!, [subject, 2, 1]);
  const f = {
    job, config, now, missing: false, blockReads: [] as string[], calls: [] as number[],
    height: 190n, index: 3n, logIndex: 1n, tombstone: true, verified: false, frozen: true,
    owner: revoker, boundSource: source, chainKey: 1n, version: 2n, boundAsc: asc,
    sourceChain: 11155111n, hubChain: 102031n, hubTime: now, reorg: '',
    receipt: { hash: job.transaction!.hash, to: source, from: revoker, blockNumber: 190, index: 3, blockHash: ethers.id('source-190'), status: 1,
      logs: [{ address: revoker, topics: [], data: '0x', index: 27 }, { address: source, ...event, index: 28 }] },
  };
  const counts = new Map<string, number>();
  const sourceRpc = {
    getNetwork: async () => ({ chainId: f.sourceChain }),
    getBlock: async (tag: string | number) => {
      const number = tag === 'latest' ? 200 : Number(tag), key = `source-${tag}`;
      f.blockReads.push(key); counts.set(key, (counts.get(key) ?? 0) + 1);
      const changed = f.reorg === key && (number === 200 || counts.get(key)! > 1);
      return { number, hash: ethers.id(changed ? 'changed' : `source-${number}`), timestamp: now };
    },
    getCode: async () => '0x6001', getTransactionReceipt: async () => f.missing ? null : f.receipt,
  } as unknown as ethers.Provider;
  const ascAbi = new ethers.Interface(REVOCATION_ASC_ABI), registryAbi = new ethers.Interface(REVOCATION_REGISTRY_ABI);
  const hubRpc = {
    getNetwork: async () => ({ chainId: f.hubChain }),
    getBlock: async (tag: string | number) => {
      f.blockReads.push(`hub-${tag}`);
      return { number: 300, hash: ethers.id(f.reorg === 'hub-300' && tag === 300 ? 'changed' : 'hub-300'), timestamp: f.hubTime };
    },
    getCode: async (address: string) => address.toLowerCase() === asc ? '0x6002' : '0x6003',
    call: async (tx: { to: string; data: string; blockTag: number }) => {
      f.calls.push(tx.blockTag);
      const target = tx.to.toLowerCase() === asc ? ascAbi : registryAbi;
      const method = target.parseTransaction({ data: tx.data })!;
      const values: Record<string, unknown> = { sourceContract: f.boundSource, expectedChainKey: f.chainKey,
        TRANSACTION_PROCESSING_VERSION: f.version, ASC: f.boundAsc, POLICY_SCHEMA_VERSION: 2n,
        tombstone: f.tombstone, lastAppliedHeight: f.height, lastAppliedTxIndex: f.index, lastAppliedLogIndex: f.logIndex,
        policyOwner: f.owner, policyFrozen: f.frozen, isVerified: f.verified };
      return target.encodeFunctionResult(method.name, [values[method.name]]);
    },
  } as unknown as ethers.Provider;
  return Object.assign(f, { run: () => checkRevocation(sourceRpc, hubRpc, job, config, now) });
}

test('exact receipt-local cursor, tombstone and real Registry booleans at one rechecked block establish observed enforcement', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.state, 'ENFORCED'); assert.equal(result.enforced, true);
  assert.equal(result.source?.receiptLogIndex, 1, 'not the RPC global log index 28');
  assert.ok(f.calls.length > 10); assert.ok(f.calls.every(tag => tag === 300));
  assert.ok(f.blockReads.includes('source-200')); assert.ok(f.blockReads.includes('hub-300'));
  assert.equal(f.blockReads.filter(tag => tag === 'source-190').length, 2);
});

test('unsigned, pending, shallow and reverted source outcomes never claim hub enforcement', async () => {
  const a = fixture(); delete a.job.transaction; assert.equal((await a.run()).state, 'UNSIGNED'); assert.equal(a.calls.length, 0);
  const b = fixture(); b.missing = true; assert.equal((await b.run()).state, 'SOURCE_PENDING');
  const c = fixture(); c.config.confirmations = 12; assert.equal((await c.run()).state, 'SOURCE_UNCONFIRMED');
  const d = fixture(); d.receipt.status = 0; assert.equal((await d.run()).state, 'SOURCE_REVERTED');
});

test('unrelated denial, later cursor and inconsistent current state are not exact revocation acknowledgement', async () => {
  const a = fixture(); a.height = 189n; assert.equal((await a.run()).state, 'AWAITING_HUB');
  const b = fixture(); b.height = 191n; assert.equal((await b.run()).state, 'SUPERSEDED');
  const c = fixture(); c.logIndex = 2n; assert.equal((await c.run()).state, 'SUPERSEDED');
  const d = fixture(); d.tombstone = false; assert.equal((await d.run()).state, 'INCONSISTENT');
  const e = fixture(); e.verified = true; assert.equal((await e.run()).state, 'INCONSISTENT');
});

test('deployment pins, receipt sender/subject/reason/uniqueness and explicit config fail closed', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.config.sourceCodeHash = ethers.id('wrong'); }, f => { f.config.ascCodeHash = ethers.id('wrong'); },
    f => { f.config.registryCodeHash = ethers.id('wrong'); }, f => { f.receipt.from = f.job.walletAddress; },
    f => { f.receipt.to = f.job.walletAddress; }, f => { f.receipt.hash = ethers.id('wrong'); },
    f => { f.receipt.logs[1].topics[1] = ethers.zeroPadValue(f.config.expectedRevoker, 32); },
    f => { f.receipt.logs[1].topics[2] = ethers.zeroPadValue('0x03', 32); },
    f => { f.receipt.logs.push(f.receipt.logs[1]); }, f => { f.receipt.logs[1].data = '0xab'; },
    f => { f.config.confirmations = 0; }, f => { f.config.policyIds = [1, 1]; },
    f => { f.config.policyIds = []; }, f => { f.job.sourceTarget!.chainId = 1; },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.run()); }
});

test('wrong chains/bindings, stale head, missing policy and reorg at any rechecked block reject a positive result', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.sourceChain = 1n; }, f => { f.hubChain = 1n; }, f => { f.boundSource = f.job.walletAddress; },
    f => { f.boundAsc = f.job.walletAddress; }, f => { f.chainKey = 3n; }, f => { f.version = 1n; },
    f => { f.owner = ethers.ZeroAddress; }, f => { f.frozen = false; },
    f => { f.hubTime -= 301; }, f => { f.hubTime += 31; },
    ...['source-190', 'source-200', 'hub-300'].map(value => (f: ReturnType<typeof fixture>) => { f.reorg = value; }),
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.run()); }
});

test('case lookup and failed read-only CLI keep encrypted bytes unchanged and do not print secrets or personal record IDs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-revoke-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), key = 'synthetic-check-secret-at-least-32-characters';
  const vault = new EvidenceVault(path, key);
  vault.put({ id: 'PRIVATE-MARKER', walletAddress: fixture().job.walletAddress, consentVersion: 'synthetic',
    screeningSubject: { fullName: 'PRIVATE-NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: fixture().job.walletAddress },
    evidenceHash: ethers.id('evidence'), evidence: [], state: 'blocked', createdAt: 1, retentionUntil: 1000, reviews: [], rescreens: [] });
  vault.recoverBlockedRevocations(2);
  const job = vault.listPendingRevocations()[0];
  assert.deepEqual(vault.getRevocation(job.id), job); job.walletAddress = ethers.ZeroAddress;
  assert.notEqual(vault.getRevocation(job.id)!.walletAddress, ethers.ZeroAddress);
  const before = readFileSync(path);
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-revocation.ts', 'UNKNOWN-PRIVATE-MARKER'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: path, EVIDENCE_VAULT_KEY: key },
  });
  assert.equal(child.status, 1); assert.equal(child.stderr.trim(), 'REVOCATION_JOB_NOT_FOUND');
  assert.equal(child.stdout, ''); assert.deepEqual(readFileSync(path), before);
});
