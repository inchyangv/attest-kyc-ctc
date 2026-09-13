import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { ATTRS_SCHEMA_VERSION, SUPPORTED_METHODS, packAttrs, unpackAttrs, validCredentialAttrs } from './attrs.js';
import { Methods } from './methods.js';
import { POLICY_SCHEMA_VERSION, POLICY_REGISTRY_ABI, requirePolicySchema, policyWarnings, validatePolicy, type PolicyInput } from './policy.js';

const valid = '0x01030002019a00010024006553f100006b49d200000000000000000000000000';
const field = (shift: bigint, bits: bigint, value: bigint) => ethers.toBeHex((BigInt(valid) & ~(((1n << bits) - 1n) << shift)) | (value << shift), 32);
test('schema 0 keeps the Solidity vector and exact supported method vocabulary', () => {
  assert.equal(ATTRS_SCHEMA_VERSION, 0); assert.equal(packAttrs(unpackAttrs(valid)), valid);
  assert.equal(validCredentialAttrs(valid, 1700000000), true);
  assert.equal(SUPPORTED_METHODS, Object.values(Methods).reduce((a, b) => a | b, 0));
  assert.equal(validCredentialAttrs(field(248n, 8n, 2n)), true);
});

test('same 16 invalid schema vectors as Solidity are rejected, including unknown version/reserved bits', () => {
  const bad = [ethers.toBeHex(BigInt(valid) | 1n, 32), ethers.toBeHex(BigInt(valid) | (1n << 63n), 32),
    field(248n, 8n, 0n), field(248n, 8n, 3n), field(248n, 8n, 255n), field(240n, 8n, 0n), field(240n, 8n, 6n),
    field(224n, 16n, 0n), field(224n, 16n, 3n), field(224n, 16n, 410n), field(208n, 16n, 0n), field(208n, 16n, 1000n),
    field(176n, 32n, 1n << 11n), field(176n, 32n, 1n << 31n), field(136n, 40n, 0n), field(96n, 40n, 1700000000n)];
  for (const attrs of bad) assert.equal(validCredentialAttrs(attrs), false, attrs);
});

test('schema validity is distinct from source-time validity; future, expiry and malformed bytes fail', () => {
  assert.equal(validCredentialAttrs(valid), true);
  for (const now of [1699999999, 1800000000, -1, NaN, 1.5]) assert.equal(validCredentialAttrs(valid, now), false);
  for (const raw of ['0x0', '-1', '0x' + '00'.repeat(33), '0x' + 'gg'.repeat(32)]) {
    assert.equal(validCredentialAttrs(raw), false); assert.throws(() => unpackAttrs(raw), /bytes32/);
  }
  for (const kind of [NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => packAttrs({ ...unpackAttrs(valid), kind }), /safe integer/);
});

const permissive: PolicyInput = { requireAll: 0, minAssurance: 0, maxAge: 0, requiredRegime: 0,
  requiredJurisdiction: 0, trustedIssuer: ethers.ZeroAddress, requireRoster: false };
test('policy kind is mandatory, sandbox wildcard and Direct freshness receive explicit warnings', () => {
  assert.equal(POLICY_SCHEMA_VERSION, 2);
  validatePolicy(permissive, 1); validatePolicy(permissive, 2);
  assert.equal(policyWarnings(permissive, 1).length, 7);
  assert.ok(policyWarnings(permissive, 1).some(w => w.includes('sandbox')));
  for (const kind of [0, 3, 255, NaN]) assert.throws(() => validatePolicy(permissive, kind), /invalid policy/);
});

test('policy registration rejects unknown methods, assurance, regime, range and malformed SDK values', () => {
  for (const change of [{ requireAll: 1 << 11 }, { requireAll: 2 ** 31 }, { minAssurance: 6 }, { requiredRegime: 410 },
    { requiredJurisdiction: 1000 }, { maxAge: -1 }, { maxAge: 2 ** 40 }, { maxAge: 1.5 }, { trustedIssuer: 'invalid' }]) {
    assert.throws(() => validatePolicy({ ...permissive, ...change }, 1), /invalid policy/);
  }
  validatePolicy({ ...permissive, requireAll: SUPPORTED_METHODS, minAssurance: 5, requiredRegime: 2, requiredJurisdiction: 999, maxAge: 2 ** 40 - 1 }, 2);
});

test('typed policy integration refuses legacy, future, and unreachable schema versions', async () => {
  const iface = new ethers.Interface(POLICY_REGISTRY_ABI);
  const provider = (attrs: bigint, policy: bigint, unavailable = false) => ({ call: async (tx: { data: string }) => {
    if (unavailable) throw new Error('unavailable');
    const name = iface.getFunction(tx.data.slice(0, 10))!.name;
    return iface.encodeFunctionResult(name, [name === 'ATTRS_SCHEMA_VERSION' ? attrs : policy]);
  } }) as unknown as ethers.Provider;
  const address = '0x' + '11'.repeat(20);
  await requirePolicySchema(provider(0n, 2n), address);
  for (const p of [provider(0n, 1n), provider(1n, 2n), provider(0n, 3n), provider(0n, 2n, true)]) {
    await assert.rejects(requirePolicySchema(p, address), /unsupported or unconfirmed/);
  }
});
