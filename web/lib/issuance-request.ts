import { keccak256, toBytes } from 'viem';

/** Stable identifier for one authenticated wallet flow; knowing it grants no journal access. */
export function issuanceRequestId(address: string, flowId: string) {
  return keccak256(toBytes(`${address.toLowerCase()}|${flowId}`));
}
