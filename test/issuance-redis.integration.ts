import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { RedisIssuanceJournal, type IssuanceEntry } from '../pipeline/issuance-journal.js';
import { advanceIssuance } from '../pipeline/issuance-delivery.js';

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER;
if (!container || !/^proofmark-bank-test-[a-zA-Z0-9-]+$/.test(container)) throw new Error('Use npm run test:issuance-redis.');
const namespace = `journal-${randomUUID()}`;
const secret = 'synthetic-issuance-journal-key-32-characters';
const bridge = (async (_url, init) => {
  const args = JSON.parse(String(init?.body)) as (string | number)[];
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--json', ...args.map(String)], { maxBuffer: 2_000_000 });
  return Response.json({ result: JSON.parse(stdout) });
}) as typeof fetch;
const journal = (request = bridge, key = secret) => new RedisIssuanceJournal('https://synthetic-journal.test', 'synthetic-token', key, request, namespace);
const entry = (): IssuanceEntry => ({ version: 1, requestId: ethers.id(randomUUID()), wallet: ethers.Wallet.createRandom().address,
  fingerprint: ethers.id('original-input'), consentVersion: 'synthetic-v1', createdAt: Date.now(), prepareUntil: Date.now() + 900000,
  phase: 'prepared', target: { chainId: 11155111, hubChainId: 102031, source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), issuer: '0x' + '33'.repeat(20) },
  assurance: 3, evidenceStored: false, revertedTransactions: [], outcome: { status: 'ISSUED', attrs: ethers.ZeroHash,
    claimsRoot: ethers.id('immutable-claims'), evidenceHash: ethers.id('immutable-evidence'), methods: 1, methodNames: [], expiry: 1800000000, regime: 2,
    claims: [{ key: 'fullName', value: 'Synthetic Test Person', salt: ethers.ZeroHash }], evidence: [] } });
const key = (id: string) => `{${namespace}:issuance}:request:${id.toLowerCase()}`;
const redis = async (...args: string[]) => {
  const { stdout } = await exec('docker', ['exec', container!, 'redis-cli', '--json', ...args]);
  return JSON.parse(stdout);
};

test('one immutable payload wins concurrent preparation; plaintext and wrong-key access fail', async () => {
  const original = entry();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => journal().create({ ...original, fingerprint: ethers.id(`input-${i}`) })));
  assert.ok(results.every(result => result.revision === 1 && result.entry.fingerprint === results[0].entry.fingerprint));
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--raw', 'HGET', key(original.requestId), 'payload']);
  assert.equal(stdout.includes('Synthetic Test Person'), false); assert.equal(stdout.includes(original.wallet), false);
  await assert.rejects(journal(bridge, 'wrong-key-that-is-long-enough-for-configuration').get(original.requestId), /JOURNAL_AUTHENTICATION_FAILED/);
});

test('signer gate persists across request leases and blocks a different pending nonce', async () => {
  const a = entry(); const b = entry();
  // Isolate this signer's gate from other tests' prepared entries.
  a.target.issuer = ethers.Wallet.createRandom().address; b.target.issuer = a.target.issuer;
  const store = journal(); await store.create(a); await store.create(b);
  const first = await store.acquire(a.requestId, 'owner-a');
  await store.release(a.requestId, 'owner-a');
  await assert.rejects(journal().acquire(b.requestId, 'owner-b'), /SIGNER_BUSY/);
  const resumed = await journal().acquire(a.requestId, 'owner-new');
  await assert.rejects(store.save(first, 'owner-a'), /LEASE_LOST/);
  resumed.entry.phase = 'source-confirmed';
  await journal().save(resumed, 'owner-new'); await journal().release(a.requestId, 'owner-new');
  assert.equal((await journal().acquire(b.requestId, 'owner-b')).entry.requestId, b.requestId);
});

test('stale revision/expired lease cannot save; a lost save response remains recoverable', async () => {
  const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
  const store = journal(); await store.create(original);
  const snapshot = await store.acquire(original.requestId, 'owner-a');
  snapshot.entry.evidenceStored = true;
  const committed = await store.save(snapshot, 'owner-a');
  await assert.rejects(store.save(snapshot, 'owner-a'), /REVISION_CONFLICT/);
  await exec('docker', ['exec', container, 'redis-cli', 'HSET', key(original.requestId), 'leaseUntil', '1']);
  const resumed = await store.acquire(original.requestId, 'owner-b');
  await assert.rejects(store.save(committed, 'owner-a'), /LEASE_LOST/);
  const dropSaveResponse = (async (url, init) => {
    const result = await bridge(url, init);
    const args = JSON.parse(String(init?.body));
    if (args[3 + Number(args[2])] === 'save') throw new Error('response lost after commit');
    return result;
  }) as typeof fetch;
  resumed.entry.phase = 'submitted';
  resumed.entry.transaction = { hash: ethers.id('signed-tx'), raw: 'encrypted-only-synthetic-signed-bytes', nonce: 10,
    chainId: original.target.chainId, source: original.target.source, issuer: original.target.issuer };
  await assert.rejects(journal(dropSaveResponse).save(resumed, 'owner-b'), /JOURNAL_UNAVAILABLE/);
  const recovered = await journal().get(original.requestId);
  assert.equal(recovered!.revision, resumed.revision + 1); assert.deepEqual(recovered!.entry.transaction, resumed.entry.transaction);
  assert.ok((await journal().pending()).includes(original.requestId));
});

test('materialization removes pending work and starts bounded completed-record TTL', async () => {
  const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
  const store = journal(); await store.create(original);
  const snapshot = await store.acquire(original.requestId, 'owner-a');
  snapshot.entry.phase = 'materialized'; snapshot.entry.materializedAt = Date.now();
  await store.save(snapshot, 'owner-a'); await store.release(original.requestId, 'owner-a');
  assert.equal((await store.pending()).includes(original.requestId), false);
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--raw', 'TTL', key(original.requestId)]);
  assert.ok(Number(stdout) > 86300 && Number(stdout) <= 86400);
});

test('failed vault activation remains queued until the exact issuance is recoverably materialized', async () => {
  const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
  const store = journal(); await store.create(original);
  const confirmation = { blockNumber: 123, blockHash: ethers.id('materialized-block'), transactionIndex: 4, confirmedAt: Date.now() };
  let receipt: { status: 'pending' } | { status: 'success'; confirmation: typeof confirmation } = { status: 'pending' };
  let hub = false; let prepare = 0; let broadcast = 0; let activations = 0;
  const transport = {
    assertTarget: async () => {}, processed: async () => false,
    prepare: async () => {
      prepare++;
      return { hash: ethers.id('materialization-transaction'), raw: 'synthetic-signed-bytes', nonce: 7,
        chainId: original.target.chainId, source: original.target.source, issuer: original.target.issuer };
    },
    broadcast: async () => { broadcast++; receipt = { status: 'success', confirmation }; },
    receipt: async () => receipt,
    materialized: async () => hub,
  };
  const evidence = {
    put: async () => {}, assertMayBroadcast: async () => {}, sourceConfirmed: async () => {},
    materialized: async () => { activations++; if (activations === 1) throw new Error('synthetic activation unavailable'); },
  };
  assert.equal((await advanceIssuance(store, original.requestId, transport, evidence)).entry.phase, 'source-confirmed');
  hub = true;
  const interrupted = await advanceIssuance(store, original.requestId, transport, evidence);
  assert.equal(interrupted.entry.phase, 'source-confirmed');
  assert.equal(interrupted.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
  assert.ok((await store.pending()).includes(original.requestId));
  const recovered = await advanceIssuance(store, original.requestId, transport, evidence);
  assert.equal(recovered.entry.phase, 'materialized');
  assert.equal(recovered.entry.lastError, undefined);
  assert.equal((await store.pending()).includes(original.requestId), false);
  assert.equal(activations, 2); assert.equal(prepare, 1); assert.equal(broadcast, 1);
});

test('terminal diagnostic saves and independent readers never extend the first absolute deadline', async () => {
  for (const phase of ['materialized', 'failed'] as const) {
    const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
    const store = journal(); await store.create(original);
    let snapshot = await store.acquire(original.requestId, 'owner-a');
    snapshot.entry.phase = phase;
    snapshot = await store.save(snapshot, 'owner-a');
    const deadline = await redis('PEXPIRETIME', key(original.requestId));
    assert.equal(Number(await redis('HGET', key(original.requestId), 'terminalExpiresAt')), deadline);
    for (let i = 0; i < 3; i++) {
      snapshot.entry.lastError = 'DEPENDENCY_UNAVAILABLE';
      snapshot = await store.save(snapshot, 'owner-a');
      assert.equal(await redis('PEXPIRETIME', key(original.requestId)), deadline);
    }
    await store.release(original.requestId, 'owner-a');
    await journal().get(original.requestId);
    await journal().create(original); // Duplicate create is not a new completion.
    const next = await journal().acquire(original.requestId, 'owner-b');
    await journal().save(next, 'owner-b');
    await journal().release(original.requestId, 'owner-b');
    if (phase === 'materialized') {
      // Exercise the original sliding-TTL cause through the real delivery function's catch/save.
      const dependencyFailure = async (): Promise<never> => { throw new Error('synthetic RPC outage'); };
      const unexpected = async (): Promise<never> => assert.fail('terminal diagnostics must not sign, broadcast or reconcile');
      const failed = await advanceIssuance(journal(), original.requestId, { assertTarget: dependencyFailure,
        processed: unexpected, prepare: unexpected, broadcast: unexpected, receipt: unexpected, materialized: unexpected },
      { put: async () => {}, assertMayBroadcast: unexpected, materialized: unexpected });
      assert.equal(failed.entry.phase, 'materialized');
      assert.equal(failed.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
    }
    assert.equal(await redis('PEXPIRETIME', key(original.requestId)), deadline);
    assert.equal((await store.pending()).includes(original.requestId), false);
  }
});

test('legacy terminal TTL is adopted exactly and a shorter operational TTL is never lengthened', async () => {
  const original = entry(); original.phase = 'failed';
  const store = journal(); await store.create(original);
  // Reproduce the old schema: encrypted payload plus physical TTL, no absolute deadline field.
  await redis('HDEL', key(original.requestId), 'terminalExpiresAt');
  await redis('PEXPIRE', key(original.requestId), '60000');
  const legacyDeadline = await redis('PEXPIRETIME', key(original.requestId));
  let snapshot = await store.acquire(original.requestId, 'owner-a');
  snapshot.entry.lastError = 'DEPENDENCY_UNAVAILABLE';
  snapshot = await store.save(snapshot, 'owner-a');
  assert.equal(await redis('PEXPIRETIME', key(original.requestId)), legacyDeadline);
  assert.equal(Number(await redis('HGET', key(original.requestId), 'terminalExpiresAt')), legacyDeadline);
  await redis('PEXPIRE', key(original.requestId), '10000');
  const shortened = await redis('PEXPIRETIME', key(original.requestId));
  await store.save(snapshot, 'owner-a');
  assert.equal(await redis('PEXPIRETIME', key(original.requestId)), shortened);
  assert.equal(Number(await redis('HGET', key(original.requestId), 'terminalExpiresAt')), shortened);
});

test('explicit failed retry removes expiry while nonce is unresolved and starts a new completion episode', async () => {
  const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
  original.phase = 'failed'; original.lastError = 'SOURCE_REVERTED';
  const store = journal(); await store.create(original);
  const firstDeadline = await redis('PEXPIRETIME', key(original.requestId));
  let snapshot = await store.acquire(original.requestId, 'owner-a');
  snapshot.entry.phase = 'prepared'; delete snapshot.entry.lastError;
  snapshot = await store.save(snapshot, 'owner-a');
  assert.equal(await redis('PTTL', key(original.requestId)), -1);
  assert.equal(await redis('HGET', key(original.requestId), 'terminalExpiresAt'), null);
  assert.ok((await store.pending()).includes(original.requestId));
  const other = entry(); other.target.issuer = original.target.issuer;
  await store.create(other);
  await assert.rejects(journal().acquire(other.requestId, 'owner-b'), /SIGNER_BUSY/);
  snapshot.entry.phase = 'submitted'; snapshot = await store.save(snapshot, 'owner-a');
  assert.equal(await redis('PTTL', key(original.requestId)), -1);
  snapshot.entry.phase = 'source-confirmed'; snapshot = await store.save(snapshot, 'owner-a');
  assert.equal(await redis('PTTL', key(original.requestId)), -1);
  snapshot.entry.phase = 'materialized'; await store.save(snapshot, 'owner-a');
  assert.ok(await redis('PEXPIRETIME', key(original.requestId)) > firstDeadline);
});

test('lost terminal save response keeps its committed absolute deadline on recovery', async () => {
  const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
  const store = journal(); await store.create(original);
  const snapshot = await store.acquire(original.requestId, 'owner-a');
  snapshot.entry.phase = 'materialized';
  const dropSaveResponse = (async (url, init) => {
    const result = await bridge(url, init);
    const args = JSON.parse(String(init?.body));
    if (args[3 + Number(args[2])] === 'save') throw new Error('synthetic committed response loss');
    return result;
  }) as typeof fetch;
  await assert.rejects(journal(dropSaveResponse).save(snapshot, 'owner-a'), /JOURNAL_UNAVAILABLE/);
  const deadline = await redis('PEXPIRETIME', key(original.requestId));
  const recovered = await journal().get(original.requestId);
  assert.equal(recovered!.entry.phase, 'materialized');
  assert.equal(recovered!.revision, snapshot.revision + 1);
  recovered!.entry.lastError = 'DEPENDENCY_UNAVAILABLE';
  await journal().save(recovered!, 'owner-a');
  assert.equal(await redis('PEXPIRETIME', key(original.requestId)), deadline);
});

test('actual Redis expiry removes completed payload without a polling read or save extending it', async () => {
  const original = entry(); original.phase = 'failed';
  const store = journal(); await store.create(original);
  await redis('PEXPIRE', key(original.requestId), '1000');
  const deadline = await redis('PEXPIRETIME', key(original.requestId));
  const snapshot = await store.acquire(original.requestId, 'owner-a');
  await store.save(snapshot, 'owner-a');
  await store.release(original.requestId, 'owner-a');
  assert.equal(await redis('PEXPIRETIME', key(original.requestId)), deadline);
  // Poll this synthetic key only, with a bounded deadline. No real retention policy is shortened.
  const stop = Date.now() + 4000;
  while (await store.get(original.requestId)) {
    assert.ok(Date.now() < stop, 'completed key must expire instead of sliding');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await redis('EXISTS', key(original.requestId)), 0);
  assert.equal((await store.pending()).includes(original.requestId), false);
  await assert.rejects(store.save(snapshot, 'owner-a'), /NOT_FOUND/);
});

test('inconsistent deadline metadata fails before lease, payload or signer mutation', async () => {
  const original = entry(); original.phase = 'failed'; original.target.issuer = ethers.Wallet.createRandom().address;
  const store = journal(); await store.create(original);
  const snapshot = await store.acquire(original.requestId, 'owner-a');
  for (const [invalid, code] of [['not-a-time', 'RETENTION_STATE_INVALID'], ['1e99', 'RETENTION_STATE_INVALID'], ['1', 'RETENTION_DEADLINE_PASSED']]) {
    await redis('HSET', key(original.requestId), 'terminalExpiresAt', invalid);
    const before = await redis('HGETALL', key(original.requestId));
    snapshot.entry.phase = 'prepared';
    await assert.rejects(store.save(snapshot, 'owner-a'), new RegExp(code));
    await assert.rejects(store.get(original.requestId), new RegExp(code));
    assert.deepEqual(await redis('HGETALL', key(original.requestId)), before);
  }
  const other = entry(); other.target.issuer = original.target.issuer;
  await store.create(other);
  assert.equal((await store.acquire(other.requestId, 'owner-b')).entry.phase, 'prepared');
});

test('missing expiry-command permission fails before creating payload or taking a signer lease', async () => {
  const user = `expiry-test-${randomUUID()}`;
  const password = 'synthetic-redis-acl-password';
  await redis('ACL', 'SETUSER', user, 'on', `>${password}`, '~*', '+@all', '-pexpiretime');
  try {
    const denied = (async (_url, init) => {
      const args = JSON.parse(String(init?.body)) as (string | number)[];
      const { stdout } = await exec('docker', ['exec', container!, 'redis-cli', '--user', user, '--pass', password,
        '--json', ...args.map(String)], { maxBuffer: 2_000_000 });
      return Response.json({ result: JSON.parse(stdout) });
    }) as typeof fetch;
    const original = entry(); original.target.issuer = ethers.Wallet.createRandom().address;
    await assert.rejects(journal(denied).create(original), /JOURNAL_UNAVAILABLE/);
    assert.equal(await redis('EXISTS', key(original.requestId)), 0);
    await journal().create(original);
    const before = await redis('HGETALL', key(original.requestId));
    await assert.rejects(journal(denied).acquire(original.requestId, 'owner-a'), /JOURNAL_UNAVAILABLE/);
    assert.deepEqual(await redis('HGETALL', key(original.requestId)), before);
    // Denying the new expiry write must also fail before HSET/nonce-gate release, not halfway through Lua.
    await redis('ACL', 'SETUSER', user, '+pexpiretime', '-pexpireat');
    const terminal = entry(); terminal.phase = 'failed';
    await assert.rejects(journal(denied).create(terminal), /JOURNAL_UNAVAILABLE/);
    assert.equal(await redis('EXISTS', key(terminal.requestId)), 0);
    const snapshot = await journal().acquire(original.requestId, 'owner-a');
    const beforeTerminal = await redis('HGETALL', key(original.requestId));
    snapshot.entry.phase = 'materialized';
    await assert.rejects(journal(denied).save(snapshot, 'owner-a'), /JOURNAL_UNAVAILABLE/);
    assert.deepEqual(await redis('HGETALL', key(original.requestId)), beforeTerminal);
    const competing = entry(); competing.target.issuer = original.target.issuer;
    await journal().create(competing);
    await assert.rejects(journal().acquire(competing.requestId, 'owner-b'), /SIGNER_BUSY/);
  } finally { await redis('ACL', 'DELUSER', user); }
});
