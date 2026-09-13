import { ethers } from 'ethers';

export const runtimeRoleNames = [
  'deployer', 'governance-owner', 'source-issuer', 'source-rescreener', 'epoch-publisher', 'worker-payer',
  'asset-owner', 'denial-correction-approver', 'asset-recovery-proposer', 'asset-recovery-approver',
] as const;

export type RuntimeRoleName = typeof runtimeRoleNames[number];
export type RuntimeRoleBindings = Record<RuntimeRoleName, string>;

export class RuntimeRoleBoundaryError extends Error {
  constructor(readonly code: 'ROLE_ADDRESS_INVALID' | 'ROLE_PRINCIPAL_REUSED') {
    super(code); this.name = 'RuntimeRoleBoundaryError';
  }
}

/** Validates public principals only. It never loads, prints or persists private-key material. */
export function assertDistinctRuntimeRoles(bindings: RuntimeRoleBindings): Record<RuntimeRoleName, string> {
  const normalized = {} as Record<RuntimeRoleName, string>;
  const owners = new Map<string, RuntimeRoleName>();
  for (const role of runtimeRoleNames) {
    const address = bindings?.[role];
    if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new RuntimeRoleBoundaryError('ROLE_ADDRESS_INVALID');
    const canonical = ethers.getAddress(address);
    const reused = owners.get(canonical.toLowerCase());
    if (reused) throw new RuntimeRoleBoundaryError('ROLE_PRINCIPAL_REUSED');
    owners.set(canonical.toLowerCase(), role);
    normalized[role] = canonical;
  }
  return normalized;
}
