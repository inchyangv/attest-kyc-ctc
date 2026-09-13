import { assertDistinctRuntimeRoles, runtimeRoleNames, type RuntimeRoleBindings } from '../pipeline/runtime-roles.js';

if (process.argv.length !== 2 + runtimeRoleNames.length) {
  throw new Error(`usage: check-runtime-roles ${runtimeRoleNames.join(' ')}`);
}
const bindings = Object.fromEntries(runtimeRoleNames.map((role, index) => [role, process.argv[index + 2]])) as RuntimeRoleBindings;
const checked = assertDistinctRuntimeRoles(bindings);
console.log(JSON.stringify({ status: 'ROLE_BOUNDARY_VERIFIED', roles: checked }));
