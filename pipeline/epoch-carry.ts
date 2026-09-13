import { ethers } from 'ethers';
import { PROOFMARK_ASC_ABI } from '../worker/abi.js';
import { computeQueryId, txIndexFromProof } from '../worker/proof.js';

const ABI = new ethers.Interface(PROOFMARK_ASC_ABI);
export interface ExpectedEpochCarry {
  asc: string; epoch: number; root: string; validUntil: number; sourceCutoff: number;
  publishedAt: number; listVersion: number; snapshotId: string; sourceBlock: number; sourceTxIndex: number;
}
export function requireCurrentPublishedEpoch(expected: number, observed: number): void {
  if (expected !== observed) throw new Error('EPOCH_HUB_NO_LONGER_CURRENT');
}

/** RPC receipt/event/call-coordinate reconciliation, not independent native proof validation.
 * A latestEpoch counter alone cannot prove that this publication was ever accepted.
 */
export async function observeEpochCarry(provider: ethers.Provider, expected: ExpectedEpochCarry,
  fromBlock: number, confirmations: number, maxBlocks = 20000) {
  if (![fromBlock, confirmations, maxBlocks].every(Number.isSafeInteger) || fromBlock < 0 || confirmations < 1 || maxBlocks < 1) throw new Error('EPOCH_CARRY_CONFIG_INVALID');
  if ((await provider.getNetwork()).chainId !== 102031n) throw new Error('EPOCH_CARRY_CHAIN_MISMATCH');
  const head = await provider.getBlockNumber();
  if (!Number.isSafeInteger(head) || head < fromBlock || head - fromBlock + 1 > maxBlocks) throw new Error('EPOCH_CARRY_SCAN_UNAVAILABLE');
  const accepted = ABI.encodeEventLog(ABI.getEvent('EpochAccepted')!, [expected.epoch, expected.root, expected.validUntil]);
  const provenance = ABI.encodeEventLog(ABI.getEvent('EpochProvenance')!, [expected.epoch, expected.sourceCutoff, expected.publishedAt, expected.listVersion, expected.snapshotId]);
  const logs: ethers.Log[] = [];
  for (let from = fromBlock; from <= head; from += 500) logs.push(...await provider.getLogs({ address: expected.asc,
    topics: accepted.topics, fromBlock: from, toBlock: Math.min(head, from + 499) }));
  if (!logs.length) return null;
  if (logs.length !== 1) throw new Error('EPOCH_CARRY_EVENT_MISMATCH');
  const log = logs[0], same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const matches = (l: ethers.Log, event: { data: string; topics: string[] }) => same(l.address, expected.asc)
    && l.data === event.data && JSON.stringify(l.topics) === JSON.stringify(event.topics);
  if (!matches(log, accepted) || log.removed || !Number.isSafeInteger(log.blockNumber) || log.blockNumber < fromBlock || log.blockNumber > head
    || !ethers.isHexString(log.blockHash, 32) || !ethers.isHexString(log.transactionHash, 32)) throw new Error('EPOCH_CARRY_EVENT_MISMATCH');
  const receipt = await provider.getTransactionReceipt(log.transactionHash);
  if (!receipt || receipt.status !== 1 || !receipt.to || !same(receipt.to, expected.asc) || receipt.hash !== log.transactionHash
    || receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash) throw new Error('EPOCH_CARRY_RECEIPT_MISMATCH');
  const own = receipt.logs.filter(l => same(l.address, expected.asc));
  const epochLogs = own.filter(l => l.topics[0] === accepted.topics[0]), provenanceLogs = own.filter(l => l.topics[0] === provenance.topics[0]);
  if (epochLogs.length !== 1 || !matches(epochLogs[0], accepted) || epochLogs[0].index !== log.index
    || provenanceLogs.length !== 1 || !matches(provenanceLogs[0], provenance)) throw new Error('EPOCH_CARRY_EVENT_MISMATCH');
  const tx = await provider.getTransaction(receipt.hash);
  if (!tx || tx.hash !== receipt.hash || !tx.to || !same(tx.to, expected.asc) || tx.chainId !== 102031n || tx.value !== 0n) throw new Error('EPOCH_CARRY_TRANSACTION_MISMATCH');
  const call = ABI.parseTransaction({ data: tx.data });
  if (!call || call.name !== 'execute' || call.args.action !== 3n || call.args.chainKey !== 1n
    || call.args.blockHeight !== BigInt(expected.sourceBlock) || txIndexFromProof(call.args.siblings) !== BigInt(expected.sourceTxIndex)) throw new Error('EPOCH_CARRY_SOURCE_COORDINATES_MISMATCH');
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.number !== receipt.blockNumber || block.hash !== receipt.blockHash || head - block.number + 1 < confirmations) return null;
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < expected.publishedAt) throw new Error('EPOCH_CARRY_TIMESTAMP_INVALID');
  const queryId = computeQueryId(1, expected.sourceBlock, expected.sourceTxIndex);
  const asc = new ethers.Contract(expected.asc, PROOFMARK_ASC_ABI, provider);
  if (!(await asc.processedQueries(queryId, { blockTag: block.number }))) throw new Error('EPOCH_CARRY_QUERY_UNCONFIRMED');
  const finalHead = await provider.getBlockNumber(), finalBlock = await provider.getBlock(block.number);
  if (!Number.isSafeInteger(finalHead) || finalHead - block.number + 1 < confirmations || finalBlock?.number !== block.number || finalBlock.hash !== block.hash) return null;
  return { transactionHash: receipt.hash, blockNumber: block.number, blockHash: block.hash,
    timestamp: block.timestamp, confirmations: finalHead - block.number + 1, queryId, sourceBlock: expected.sourceBlock, sourceTxIndex: expected.sourceTxIndex };
}
