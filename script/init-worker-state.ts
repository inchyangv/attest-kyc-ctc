import { dirname, join, resolve } from 'node:path';
import { ethers } from 'ethers';
import { cfg } from '../worker/config.js';
import { PROOFMARK_ASC_ABI } from '../worker/abi.js';
import { acquireWorkerLease } from '../worker/lease.js';
import { EvmHubRecoveryReader, initializeHubRecovery } from '../worker/recovery.js';
import { Store } from '../worker/store.js';

const provider = (url: string) => {
  const request = new ethers.FetchRequest(url); request.timeout = 15_000;
  return new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
};
const statePath = resolve(cfg.statePath), source = provider(cfg.sourceRpc), hub = provider(cfg.hubRpc);
const signer = new ethers.Wallet(cfg.privateKey, hub), asc = new ethers.Contract(cfg.ascAddress, PROOFMARK_ASC_ABI, hub);
const releases: (() => void)[] = [];
try {
  releases.push(acquireWorkerLease(`${statePath}.lock`));
  releases.push(acquireWorkerLease(join(dirname(statePath), `relay-102031-${signer.address.toLowerCase()}.lock`)));
  const [sourceNetwork, hubNetwork, expectedKey, expectedSource] = await Promise.all([
    source.getNetwork(), hub.getNetwork(), asc.expectedChainKey(), asc.sourceContract(),
  ]);
  if (sourceNetwork.chainId !== 11155111n || hubNetwork.chainId !== 102031n || Number(expectedKey) !== cfg.chainKey
    || expectedSource.toLowerCase() !== cfg.sourceAddress.toLowerCase()) throw new Error('WORKER_STATE_INIT_SCOPE_MISMATCH');
  const store = new Store(statePath);
  store.bindScope({ sourceChainId: 11155111, hubChainId: 102031, chainKey: cfg.chainKey,
    source: cfg.sourceAddress.toLowerCase(), asc: cfg.ascAddress.toLowerCase(), signer: signer.address.toLowerCase(), startBlock: cfg.startBlock });
  await initializeHubRecovery(store, new EvmHubRecoveryReader(hub, asc));
  console.log('initialized Proofmark worker state for a zero-nonce dedicated signer; no transaction sent');
} finally {
  source.destroy(); hub.destroy();
  for (const release of releases.reverse()) release();
}
