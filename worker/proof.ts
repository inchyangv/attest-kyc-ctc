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
 * 증명 획득. SDK 의 `getProof` 자체는 문제가 없으므로 그대로 쓰되 **재시도로 감싼다.**
 * (교체한 것은 `waitUntilHeightAttested` 뿐 — attestation.ts 참조)
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
      if (!res?.success) throw new Error(res?.error ?? '증명 생성 실패 (사유 미상)');
      return res.data as ProofData;
    },
    { attempts: 5, backoff: new Backoff(2_000, 30_000), signal },
  );
}

/**
 * ASC 의 `_computeQueryId` 와 **바이트 단위로 동일한** 계산.
 *
 * 레이아웃 (총 72바이트) — test/QueryId.t.sol 이 이 해석을 퍼즈로 고정한다:
 *   [0  .. 32)  uint256(chainKey)
 *   [32 .. 40)  uint64  blockHeight  (big-endian 8바이트)
 *   [40 .. 72)  uint256(txIndex)
 *
 * 이걸로 제출 전에 `processedQueries(queryId)` 를 조회해 **이미 처리된 쿼리에 가스를 태우지 않는다.**
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

/** 머클 증명의 isLeft 비트열에서 txIndex 를 복원한다 (프리컴파일 calculateTxIndex 와 동일 규칙). */
export function txIndexFromProof(siblings: Array<{ isLeft: boolean }>): bigint {
  let idx = 0n;
  for (let i = siblings.length - 1; i >= 0; i--) {
    idx = (idx << 1n) | (siblings[i].isLeft ? 1n : 0n);
  }
  return idx;
}
