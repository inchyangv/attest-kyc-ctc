import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { assertDistinctRuntimeRoles, RuntimeRoleBoundaryError, runtimeRoleNames, type RuntimeRoleBindings } from './runtime-roles.js';

const bindings = (): RuntimeRoleBindings => Object.fromEntries(runtimeRoleNames.map((role, index) => [
  role, ethers.getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`),
])) as RuntimeRoleBindings;

test('PM-T23-01 refuses a deployer reused as issuer, publisher or worker payer', () => {
  for (const role of ['source-issuer', 'epoch-publisher', 'worker-payer'] as const) {
    const value = bindings(); value[role] = value.deployer;
    assert.throws(() => assertDistinctRuntimeRoles(value), (error: unknown) =>
      error instanceof RuntimeRoleBoundaryError && error.code === 'ROLE_PRINCIPAL_REUSED');
  }
  assert.equal(Object.keys(assertDistinctRuntimeRoles(bindings())).length, runtimeRoleNames.length);
});

test('runtime role boundary rejects missing, malformed and zero principals without reflecting them', () => {
  for (const value of ['', 'PRIVATE', ethers.ZeroAddress]) {
    const input = bindings(); input['asset-recovery-approver'] = value;
    assert.throws(() => assertDistinctRuntimeRoles(input), (error: unknown) =>
      error instanceof RuntimeRoleBoundaryError && error.code === 'ROLE_ADDRESS_INVALID'
        && (value === '' || !error.message.includes(value)));
  }
});
