import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { issuerApprovalData, encodeIssuerSignature, encodeIssuerIssue, encodeIssuerCompromise, ISSUER_KEY_ABI } from './issuer-key.js';

const issuer = '0x' + '11'.repeat(20);
const sourceDigest = ethers.id('synthetic exact source approval');

test('issuer wrapper binds operating key epoch, chain, stable issuer and exact source digest', async () => {
  const t = issuerApprovalData(11155111n, issuer, sourceDigest, 1n);
  const signer = new ethers.Wallet('0x' + '01'.repeat(32));
  const signed = await signer.signTypedData(t.domain, t.types, t.value);
  const envelope = encodeIssuerSignature(1n, signed);
  assert.equal(ethers.dataLength(envelope), 73);
  assert.equal(BigInt(ethers.dataSlice(envelope, 0, 8)), 1n);
  assert.equal(ethers.recoverAddress(t.digest, ethers.dataSlice(envelope, 8)), signer.address);
  for (const other of [issuerApprovalData(1n, issuer, sourceDigest, 1n), issuerApprovalData(11155111n, '0x' + '22'.repeat(20), sourceDigest, 1n),
    issuerApprovalData(11155111n, issuer, ethers.id('different root'), 1n), issuerApprovalData(11155111n, issuer, sourceDigest, 2n)]) {
    assert.notEqual(other.digest, t.digest);
    assert.notEqual(ethers.recoverAddress(other.digest, signed), signer.address);
  }
});

test('key SDK rejects lossy epochs, empty domains/digests and malformed signatures or issuance', () => {
  for (const epoch of [0n, -1n, 1n << 64n, 1 as unknown as bigint]) {
    assert.throws(() => issuerApprovalData(1n, issuer, sourceDigest, epoch));
    assert.throws(() => encodeIssuerSignature(epoch, '0x'));
  }
  assert.throws(() => issuerApprovalData(0n, issuer, sourceDigest, 1n));
  assert.throws(() => issuerApprovalData(1n, ethers.ZeroAddress, sourceDigest, 1n));
  assert.throws(() => issuerApprovalData(1n, issuer, ethers.ZeroHash, 1n));
  assert.throws(() => encodeIssuerSignature(1n, '0x' + '00'.repeat(64)));
  assert.throws(() => encodeIssuerIssue(1n, sourceDigest, ethers.ZeroAddress, sourceDigest, sourceDigest, sourceDigest));
  const data = encodeIssuerIssue(2n, sourceDigest, issuer, sourceDigest, sourceDigest, sourceDigest);
  const decoded = new ethers.Interface(ISSUER_KEY_ABI).decodeFunctionData('issueOnce', data);
  assert.equal(decoded.expectedEpoch, 2n);
  assert.equal(decoded.requestId, sourceDigest);
  assert.equal(decoded.subject.toLowerCase(), issuer);
  const incident = encodeIssuerCompromise(ethers.id('approved incident record'), 123n);
  const boundary = new ethers.Interface(ISSUER_KEY_ABI).decodeFunctionData('declareCompromise', incident);
  assert.equal(boundary.lastTrustedBlock, 123n);
  assert.throws(() => encodeIssuerCompromise(ethers.ZeroHash, 1n));
  assert.throws(() => encodeIssuerCompromise(sourceDigest, -1n));
});
