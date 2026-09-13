import { ethers } from 'ethers';

const names = { source: 'DEMO_SOURCE_CODEHASH', asc: 'DEMO_ASC_CODEHASH', registry: 'DEMO_REGISTRY_CODEHASH' } as const;
export type EpochRuntimePins = Record<keyof typeof names, string>;
export function epochRuntimePins(env: NodeJS.ProcessEnv): EpochRuntimePins {
  const pins = {} as EpochRuntimePins;
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const value = env[names[key]];
    if (!value || !ethers.isHexString(value, 32) || value.toLowerCase() === ethers.ZeroHash) throw new Error('EPOCH_RUNTIME_PINS_REQUIRED');
    pins[key] = value.toLowerCase();
  }
  return pins;
}

/** Expected hashes must come from approved release evidence, not from the RPC being checked.
 * Checks these three runtimes only; no inferred proxy implementation/native verifier/library pin.
 */
export async function checkEpochRuntimes(src: ethers.Provider, hub: ethers.Provider,
  addresses: EpochRuntimePins, pins: EpochRuntimePins, hubBlockNumber?: number) {
  // Validate direct callers too, before any remote read.
  const expected = epochRuntimePins(Object.fromEntries(Object.entries(names).map(([key, name]) => [name, pins[key as keyof EpochRuntimePins]])));
  if (Object.values(addresses).some(a => !ethers.isAddress(a) || a.toLowerCase() === ethers.ZeroAddress)) throw new Error('EPOCH_RUNTIME_ADDRESS_INVALID');
  if ((await src.getNetwork()).chainId !== 11155111n || (await hub.getNetwork()).chainId !== 102031n) throw new Error('EPOCH_RUNTIME_CHAIN_MISMATCH');
  if (hubBlockNumber !== undefined && (!Number.isSafeInteger(hubBlockNumber) || hubBlockNumber < 1)) throw new Error('EPOCH_RUNTIME_BLOCK_INVALID');
  const [sourceBlock, hubBlock] = await Promise.all([src.getBlock('latest'), hub.getBlock(hubBlockNumber ?? 'latest')]);
  for (const b of [sourceBlock, hubBlock]) if (!b || !Number.isSafeInteger(b.number) || b.number < 1 || !ethers.isHexString(b.hash, 32)) throw new Error('EPOCH_RUNTIME_BLOCK_UNAVAILABLE');
  if (hubBlockNumber !== undefined && hubBlock!.number !== hubBlockNumber) throw new Error('EPOCH_RUNTIME_BLOCK_UNAVAILABLE');
  const result = {} as { [K in keyof EpochRuntimePins]: { address: string; codeHash: string; blockNumber: number; blockHash: string } };
  for (const key of Object.keys(names) as (keyof EpochRuntimePins)[]) {
    const provider = key === 'source' ? src : hub, block = key === 'source' ? sourceBlock! : hubBlock!;
    const code = await provider.getCode(addresses[key], block.number);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || ethers.keccak256(code) !== expected[key]) throw new Error('EPOCH_RUNTIME_MISMATCH');
    result[key] = { address: ethers.getAddress(addresses[key]), codeHash: expected[key], blockNumber: block.number, blockHash: block.hash! };
  }
  const [lastSource, lastHub] = await Promise.all([src.getBlock(sourceBlock!.number), hub.getBlock(hubBlock!.number)]);
  if (lastSource?.number !== sourceBlock!.number || lastSource.hash !== sourceBlock!.hash
    || lastHub?.number !== hubBlock!.number || lastHub.hash !== hubBlock!.hash) throw new Error('EPOCH_RUNTIME_OBSERVATION_CHANGED');
  return result;
}
