import { ethers } from 'ethers';
import { assertRevocationTarget, type RevocationTransport } from './rescreen.js';
import type { RevocationJob } from './vault.js';

export const RESCREEN_SOURCE_ABI = [
  'function revokeBatch(address[] subjects,uint16[] reasonCodes,uint32 epoch)',
  'event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)',
] as const;
const abi = new ethers.Interface(RESCREEN_SOURCE_ABI);
type Transaction = NonNullable<RevocationJob['transaction']>;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Caller owns provider lifetime and the exclusive runner lease; signer must be dedicated to it. */
export async function createEvmRevocationTransport(provider: ethers.JsonRpcProvider, signer: ethers.Wallet,
  config: { chainId: number; source: string; confirmations: number; epoch?: number }): Promise<RevocationTransport> {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0
    || (await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error('source chain ID mismatch');
  const source = ethers.getAddress(config.source);
  if (source === ethers.ZeroAddress || await provider.getCode(source) === '0x') throw new Error('source contract has no code');
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw new Error('invalid source confirmation count');
  if (signer.provider !== provider) throw new Error('rescreen signer provider mismatch');
  if (config.epoch !== undefined && (!Number.isInteger(config.epoch) || config.epoch <= 0 || config.epoch > 0xffffffff)) throw new Error('rescreen epoch must fit uint32');
  function validate(transaction: Transaction) {
    if (transaction.chainId !== config.chainId || !same(transaction.source, source)) throw new Error('outbox belongs to another source deployment');
    const signed = ethers.Transaction.from(transaction.raw);
    if (!signed.isSigned() || signed.hash !== transaction.hash || signed.chainId !== BigInt(config.chainId)
      || !signed.to || !same(signed.to, source) || !same(signed.from!, signer.address) || signed.value !== 0n) throw new Error('outbox signed transaction binding mismatch');
    const call = abi.parseTransaction({ data: signed.data });
    if (call?.name !== 'revokeBatch' || call.args.subjects.length !== 1 || call.args.reasonCodes.length !== 1
      || call.args.reasonCodes[0] !== 2n || call.args.epoch === 0n || same(call.args.subjects[0], ethers.ZeroAddress)) throw new Error('outbox revocation payload mismatch');
    return { subject: call.args.subjects[0] as string, epoch: call.args.epoch as bigint };
  }
  async function receipt(transaction: Transaction): Promise<'success' | 'reverted' | null> {
    const intent = validate(transaction);
    const result = await provider.getTransactionReceipt(transaction.hash);
    if (!result) return null;
    if (result.hash !== transaction.hash || !result.to || !same(result.to, source) || !same(result.from, signer.address)) throw new Error('source receipt binding mismatch');
    const [head, block] = await Promise.all([provider.getBlockNumber(), provider.getBlock(result.blockNumber)]);
    if (!block || block.hash !== result.blockHash || head - result.blockNumber + 1 < config.confirmations) return null;
    if (result.status === 0) return (await provider.getBlock(result.blockNumber))?.hash === result.blockHash ? 'reverted' : null;
    if (result.status !== 1) throw new Error('invalid source receipt status');
    const matches = result.logs.filter(log => {
      if (!same(log.address, source)) return false;
      try {
        const event = abi.parseLog(log);
        return event?.name === 'MarkRevoked' && same(event.args.subject, intent.subject)
          && event.args.reasonCode === 2n && event.args.epoch === intent.epoch && log.topics.length === 4 && log.data === '0x';
      } catch { return false; }
    });
    if (matches.length !== 1) throw new Error('source revocation event mismatch');
    if ((await provider.getBlock(result.blockNumber))?.hash !== result.blockHash) return null;
    return 'success';
  }
  return {
    assertJob(job, transaction) {
      assertRevocationTarget(job, { chainId: config.chainId, source });
      if (!same(validate(transaction).subject, job.walletAddress)) throw new Error('outbox signed subject does not match revocation job');
    },
    async prepare(job) {
      assertRevocationTarget(job, { chainId: config.chainId, source });
      const epoch = config.epoch ?? Math.floor(job.createdAt / 1000);
      if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch > 0xffffffff) throw new Error('rescreen epoch must fit uint32');
      const populated = await signer.populateTransaction({ to: source, value: 0n,
        data: abi.encodeFunctionData('revokeBatch', [[job.walletAddress], [2], epoch]) });
      const raw = await signer.signTransaction(populated);
      const transaction = { raw, hash: ethers.keccak256(raw), chainId: config.chainId, source };
      validate(transaction); return transaction;
    },
    receipt,
    async broadcast(transaction) {
      validate(transaction);
      if ((await provider.broadcastTransaction(transaction.raw)).hash !== transaction.hash) throw new Error('broadcast hash mismatch');
    },
    async wait(transaction) {
      validate(transaction);
      await provider.waitForTransaction(transaction.hash, config.confirmations, 30000);
      return receipt(transaction); // Recheck canonicality and exact event, not only wait's status bit.
    },
  };
}
