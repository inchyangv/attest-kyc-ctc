import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { SourceCheckpointStore } from './roster-source-checkpoint.js';
import type { SourceReplayCheckpoint } from './roster-source.js';

const source = '0x' + '11'.repeat(20), deploymentTx = ethers.id('deployment');
const scope = { chainId: 11155111n, source, deploymentTx };
const secret = 'synthetic-source-checkpoint-key-at-least-32-characters';
const subject = ethers.getAddress('0x' + '22'.repeat(20));
const checkpoint: SourceReplayCheckpoint = {
  version: 1, chainId: '11155111', source: ethers.getAddress(source), deploymentTx, deploymentBlock: 1,
  blockNumber: 99, blockHash: ethers.id('block-99'), blockTimestamp: 1_800_000_099,
  receiptsRoot: ethers.id('receipts-99'), receipts: 42, sourceLogs: 3,
  headersDigest: ethers.id('headers'), blocksDigest: ethers.id('blocks'), logsDigest: ethers.id('logs'),
  states: [[subject, { denied: false, revoked: false, issueBlock: 10, issuerKeyEpoch: 0,
    entry: { subject, issuer: ethers.getAddress('0x' + '33'.repeat(20)), attrs: ethers.id('attrs'),
      claimsRoot: ethers.id('claims'), evidenceHash: ethers.id('evidence') } }]], compromiseCutoffs: [],
};

test('source checkpoint is encrypted, atomic, scope-bound and single-writer', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-source-checkpoint-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.enc');
  const first = new SourceCheckpointStore(path, secret, scope); first.save(checkpoint);
  const bytes = readFileSync(path, 'utf8');
  assert.equal(bytes.includes(subject), false); assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => new SourceCheckpointStore(path, secret, scope), /SOURCE_CHECKPOINT_BUSY/);
  first.close();
  const reopened = new SourceCheckpointStore(path, secret, scope);
  assert.deepEqual(reopened.load(), checkpoint); reopened.close();
  assert.throws(() => new SourceCheckpointStore(path, secret, { ...scope, source: '0x' + '44'.repeat(20) }), /SOURCE_CHECKPOINT_UNAVAILABLE/);

  const envelope = JSON.parse(bytes); envelope.ciphertext = Buffer.from('tampered').toString('base64'); writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => new SourceCheckpointStore(path, secret, scope), /SOURCE_CHECKPOINT_UNAVAILABLE/);
});
