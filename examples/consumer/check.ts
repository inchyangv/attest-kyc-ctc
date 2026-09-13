/** Explicit consumer configuration; no dotenv, key, transaction or historical-default fallback. */
import { ethers } from 'ethers';
import { ConsumerReadError, readConsumerVerdict } from '../../pipeline/consumer-verdict.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !/^[1-9][0-9]{0,77}$/.test(args[1])) throw new ConsumerReadError('CONSUMER_ARGUMENTS_INVALID');
  const rpc = process.env.CREDITCOIN_RPC_URL;
  if (!rpc) throw new ConsumerReadError('CONSUMER_CONFIG_INVALID');
  let url: URL;
  try { url = new URL(rpc); } catch { throw new ConsumerReadError('CONSUMER_CONFIG_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConsumerReadError('CONSUMER_CONFIG_INVALID');
  const request = new ethers.FetchRequest(rpc); request.timeout = 10000;
  const provider = new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const result = await readConsumerVerdict(provider, {
      registry: process.env.REGISTRY_CONTRACT_ADDRESS ?? '', asc: process.env.ASC_CONTRACT_ADDRESS ?? '',
      source: process.env.SOURCE_CONTRACT_ADDRESS ?? '', registryCodeHash: process.env.DEMO_REGISTRY_CODEHASH ?? '',
      ascCodeHash: process.env.DEMO_ASC_CODEHASH ?? '',
    }, args[0], BigInt(args[1]));
    console.log(JSON.stringify(result, null, 2));
  } finally { provider.destroy(); }
}

main().catch(error => {
  console.log(JSON.stringify({ verdict: 'unavailable', verified: null,
    error: error instanceof ConsumerReadError ? error.code : 'CONSUMER_DEPENDENCY_UNAVAILABLE' }));
  process.exitCode = 2;
});
