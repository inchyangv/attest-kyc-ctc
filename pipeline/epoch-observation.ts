import { ethers } from 'ethers';

export interface EpochHubObservation { chainId: 102031; blockNumber: number; blockHash: string; timestamp: number }
export async function captureEpochHub(provider: ethers.Provider): Promise<EpochHubObservation> {
  if ((await provider.getNetwork()).chainId !== 102031n) throw new Error('EPOCH_HUB_CHAIN_MISMATCH');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number) || block.number < 1 || !ethers.isHexString(block.hash, 32)
    || !Number.isSafeInteger(block.timestamp) || block.timestamp < 1) throw new Error('EPOCH_HUB_BLOCK_UNAVAILABLE');
  return { chainId: 102031, blockNumber: block.number, blockHash: block.hash!, timestamp: block.timestamp };
}
export async function assertEpochHub(provider: ethers.Provider, observation: EpochHubObservation): Promise<void> {
  const block = await provider.getBlock(observation.blockNumber);
  if ((await provider.getNetwork()).chainId !== BigInt(observation.chainId) || !block
    || block.number !== observation.blockNumber || block.hash !== observation.blockHash
    || block.timestamp !== observation.timestamp) throw new Error('EPOCH_HUB_OBSERVATION_CHANGED');
}
