import type { Interface, Log } from 'ethers';
import { groupSourceEvents } from './source-events.js';
import { Store, SourceSafetyError } from './store.js';

interface Block { number: number; hash: string | null }
export interface SourceReader {
  getBlockNumber(): Promise<number>;
  getBlock(tag: number | 'finalized'): Promise<Block | null>;
  getLogs(filter: { address: string; fromBlock: number; toBlock: number }): Promise<Log[]>;
}
const validBlock = (block: Block | null, height?: number): block is Block & { hash: string } => !!block
  && Number.isSafeInteger(block.number) && block.number >= 0 && (height === undefined || block.number === height)
  && /^0x[0-9a-fA-F]{64}$/.test(block.hash ?? '');

/** One bounded, hash-pinned scan step. An unsigned fork can be replayed only when callers have
 * no executing jobs; otherwise stop/fence those jobs and restart before rewinding. */
export async function scanSourceStep(store: Store, source: SourceReader, iface: Interface,
  options: { address: string; startBlock: number; confirmations: number; chunk: number; beforeRewind?: () => void },
): Promise<{ scanned: boolean; jobs: number; rewound: number }> {
  store.assertSourceReady(); store.assertHubReady();
  if ([options.startBlock, options.confirmations, options.chunk].some(n => !Number.isSafeInteger(n) || n < 1)) throw new SourceSafetyError('INVALID_SOURCE_SCAN_SETTINGS');
  const [head, finalized] = await Promise.all([source.getBlockNumber(), source.getBlock('finalized')]);
  if (!Number.isSafeInteger(head) || !validBlock(finalized) || finalized.number > head) throw new SourceSafetyError('SOURCE_FINALITY_UNCONFIRMED');
  const safeHead = Math.min(finalized.number, head - options.confirmations);
  if (!store.checkpoints.length) {
    if (options.startBlock - 1 > safeHead) return { scanned: false, jobs: 0, rewound: 0 };
    const anchor = await source.getBlock(options.startBlock - 1);
    if (!validBlock(anchor, options.startBlock - 1)) throw new SourceSafetyError('SOURCE_ANCHOR_UNAVAILABLE');
    store.initializeSource({ height: anchor.number, hash: anchor.hash });
  }
  const checkpoints = store.checkpoints; const last = checkpoints.at(-1)!;
  if (last.height !== store.cursor) throw new SourceSafetyError('SOURCE_CHECKPOINT_CURSOR_MISMATCH');
  const current = await source.getBlock(last.height);
  if (!validBlock(current, last.height)) throw new SourceSafetyError('SOURCE_CHECKPOINT_UNAVAILABLE');
  let rewound = 0;
  if (current.hash !== last.hash) {
    options.beforeRewind?.();
    let ancestor;
    for (const checkpoint of [...checkpoints].reverse()) {
      const block = await source.getBlock(checkpoint.height);
      if (validBlock(block, checkpoint.height) && block.hash === checkpoint.hash && block.number <= safeHead) { ancestor = checkpoint; break; }
    }
    if (!ancestor) store.holdSource('SOURCE_REORG_BEYOND_VERIFIED_ANCHOR');
    rewound = store.rewindUnsignedSource(ancestor!);
  }
  const from = store.cursor + 1;
  if (from > safeHead) return { scanned: false, jobs: 0, rewound };
  const to = Math.min(from + options.chunk - 1, safeHead);
  const end = await source.getBlock(to);
  if (!validBlock(end, to)) throw new SourceSafetyError('SOURCE_RANGE_END_UNAVAILABLE');
  const logs = await source.getLogs({ address: options.address, fromBlock: from, toBlock: to });
  const blocks = new Map<number, string>();
  const locations = new Map<string, { blockHash: string; transactionIndex: number }>();
  for (const entry of logs) {
    if (entry.removed || entry.address.toLowerCase() !== options.address.toLowerCase() || entry.blockNumber < from || entry.blockNumber > to
      || !Number.isSafeInteger(entry.transactionIndex) || entry.transactionIndex < 0) throw new SourceSafetyError('SOURCE_LOG_COORDINATE_MISMATCH');
    if (!blocks.has(entry.blockNumber)) {
      const block = await source.getBlock(entry.blockNumber);
      if (!validBlock(block, entry.blockNumber)) throw new SourceSafetyError('SOURCE_LOG_BLOCK_UNAVAILABLE');
      blocks.set(entry.blockNumber, block.hash);
    }
    if (blocks.get(entry.blockNumber) !== entry.blockHash) throw new SourceSafetyError('SOURCE_LOG_HASH_MISMATCH');
    const previous = locations.get(entry.transactionHash);
    if (previous && (previous.blockHash !== entry.blockHash || previous.transactionIndex !== entry.transactionIndex)) throw new SourceSafetyError('SOURCE_TRANSACTION_COORDINATE_MISMATCH');
    locations.set(entry.transactionHash, { blockHash: entry.blockHash, transactionIndex: entry.transactionIndex });
  }
  // Recheck both ends after the log request. An RPC range that changed mid-read is not committed.
  const startCheckpoint = store.checkpoints.at(-1)!;
  const [endAgain, startAgain, finalAgain, headAgain] = await Promise.all([source.getBlock(to), source.getBlock(startCheckpoint.height), source.getBlock('finalized'), source.getBlockNumber()]);
  if (!validBlock(endAgain, to) || endAgain.hash !== end.hash || !validBlock(startAgain, startCheckpoint.height) || startAgain.hash !== startCheckpoint.hash
    || !validBlock(finalAgain) || !Number.isSafeInteger(headAgain) || finalAgain.number > headAgain
    || finalAgain.number < to || headAgain - options.confirmations < to) throw new SourceSafetyError('SOURCE_RANGE_CHANGED_DURING_SCAN');
  const jobs = groupSourceEvents(logs, options.address, iface).map(job => ({ ...job, ...locations.get(job.txHash)!, state: 'discovered' as const, attempts: 0 }));
  store.assertHubReady();
  store.commitSourceRange(from, { height: to, hash: end.hash }, jobs);
  return { scanned: true, jobs: jobs.length, rewound };
}
