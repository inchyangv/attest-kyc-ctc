import { ethers } from 'ethers';

import { Backoff, withRetry } from './retry.js';
import { proofJson } from './proof-http.js';

export interface ProofData {
  chainKey: number;
  headerNumber: number;
  txBytes: string;
  merkleProof: { root: string; siblings: Array<{ hash: string; isLeft: boolean }> };
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
}

/**
 * Same GET route/raw JSON mapping as pinned SDK 0.18.0, with native cancellation and bounds.
 */
export async function fetchProof(
  proofBuilderUrl: string,
  chainKey: number,
  txHash: string,
  signal?: AbortSignal,
): Promise<ProofData> {
  return withRetry(
    `getProof(${txHash.slice(0, 10)}…)`,
    async () => {
      return await proofJson(`${proofBuilderUrl.replace(/\/+$/, '')}/api/v1/proof-by-tx/${chainKey}/${txHash}`,
        { signal, timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 }) as ProofData;
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
