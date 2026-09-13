import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

process.env.ISSUER_PRIVATE_KEY = '0x' + '01'.repeat(32);
process.env.NEXT_PUBLIC_SOURCE = '0x' + '11'.repeat(20);
process.env.NEXT_PUBLIC_ASC = '0x' + '22'.repeat(20);
delete process.env.ROTATING_ISSUER_ADDRESS;
delete process.env.ISSUER_KEY_EPOCH;

const { issuanceTarget } = await import('../lib/issuance-server');

test('issuance config pins direct or rotating issuer identity without conflating the operating EOA', () => {
  const direct = issuanceTarget();
  assert.equal(direct.issuerMode, 'direct');
  assert.equal(direct.issuer, new ethers.Wallet(process.env.ISSUER_PRIVATE_KEY!).address);

  process.env.ROTATING_ISSUER_ADDRESS = '0x' + '33'.repeat(20);
  process.env.ISSUER_KEY_EPOCH = '7';
  const rotating = issuanceTarget();
  assert.equal(rotating.issuerMode, 'rotating');
  assert.equal(rotating.issuer, ethers.getAddress(process.env.ROTATING_ISSUER_ADDRESS));
  assert.equal(rotating.operatingKey, direct.issuer);
  assert.equal(rotating.issuerKeyEpoch, 7);

  delete process.env.ISSUER_KEY_EPOCH;
  assert.throws(() => issuanceTarget(), /configured together/);
  process.env.ISSUER_KEY_EPOCH = '0';
  assert.throws(() => issuanceTarget(), /positive integer/);
});
