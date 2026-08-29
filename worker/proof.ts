import { ethers } from 'ethers';
import { proofProvider } from '@gluwa/usc-sdk';

import { Backoff, withRetry } from './retry.js';

export interface ProofData {
  chainKey: number;
  headerNumber: number;
  txBytes: string;
  merkleProof: { root: string; siblings: Array<{ hash: string; isLeft: boolean }> };
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
}

/**
 * Proof retrieval. The SDK's `getProof` is fine, so we keep it and wrap it in a retry.
 * (Only `waitUntilHeightAttested` was replaced. See attestation.ts.)
 */
export async function fetchProof(
  proofBuilderUrl: string,
  chainKey: number,
  txHash: string,
  signal?: AbortSignal,
): Promise<ProofData> {
  const builder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);

  return withRetry(
    `getProof(${txHash.slice(0, 10)}…)`,
    async () => {
      const res: any = await builder.getProof(txHash);
      if (!res?.success) throw new Error(res?.error ?? 'proof generation failed with no reason given');
      return res.data as ProofData;
    },
    { attempts: 5, backoff: new Backoff(2_000, 30_000), signal },
  );
}

/**
 * Byte-identical to the ASC's `_computeQueryId`.
 *
 * Layout, 72 bytes total. test/QueryId.t.sol fuzzes this reading:
 *   [0  .. 32)  uint256(chainKey)
 *   [32 .. 40)  uint64  blockHeight  (big-endian, 8 bytes)
 *   [40 .. 72)  uint256(txIndex)
 *
 * We call `processedQueries(queryId)` with this before submitting, so an already-processed query
 */
export function computeQueryId(chainKey: number | bigint, blockHeight: number | bigint, txIndex: number | bigint): string {
  return ethers.keccak256(
    ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(BigInt(chainKey)), 32),
      ethers.zeroPadValue(ethers.toBeHex(BigInt(blockHeight)), 8),
      ethers.zeroPadValue(ethers.toBeHex(BigInt(txIndex)), 32),
    ]),
  );
}

/** Recovers txIndex from the isLeft bits of a Merkle proof, matching the precompile. */
export function txIndexFromProof(siblings: Array<{ isLeft: boolean }>): bigint {
  let idx = 0n;
  for (let i = siblings.length - 1; i >= 0; i--) {
    idx = (idx << 1n) | (siblings[i].isLeft ? 1n : 0n);
  }
  return idx;
}
