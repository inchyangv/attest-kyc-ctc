/**
 * Read-only freshness gate. Requires an explicitly approved window; it never refreshes state.
 * Routes by the deployed registry generation: the live v1 build gets the Direct-mark gate, a v2
 * deployment gets the roster-witness gate. Neither learns the expected issuer from the chain.
 */
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { checkDemoFreshness, parseMinFreshHours } from '../pipeline/demo-freshness.js';
import { checkLegacyDemoFreshness } from '../pipeline/demo-freshness-legacy.js';
import { detectRosterGeneration } from '../pipeline/roster-legacy-v1.js';

const minFreshSeconds = parseMinFreshHours(process.env.MIN_FRESH_HOURS);
const expectedIssuer = process.env.DEMO_EXPECTED_ISSUER;
if (!expectedIssuer || !ethers.isAddress(expectedIssuer) || expectedIssuer === ethers.ZeroAddress) {
  throw new Error('DEMO_EXPECTED_ISSUER must be an independently approved nonzero issuer address');
}
const deployment = JSON.parse(readFileSync('deployments/cc3-testnet.json', 'utf8')) as {
  contracts: { ProofmarkASC: string; ProofmarkRegistry: string; GatedRwaNote: string; ComplianceSource: string };
};
// Reorg rechecks must reach the RPC, not ethers' short-lived request cache.
const provider = new ethers.JsonRpcProvider(process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network', undefined, { cacheTimeout: -1 });
try {
  const config = {
    asc: deployment.contracts.ProofmarkASC, registry: deployment.contracts.ProofmarkRegistry,
    note: deployment.contracts.GatedRwaNote, source: deployment.contracts.ComplianceSource, expectedIssuer,
    holders: ['0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2', '0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee'] as const,
    control: '0x00000000000000000000000000000000DeaDBeef', minFreshSeconds,
  };
  if ((await provider.getNetwork()).chainId !== 102031n) throw new Error('wrong hub chain');
  // One pinned probe decides the route; each gate then makes its own single-block observation.
  const head = await provider.getBlock('latest');
  if (!head) throw new Error('observation block unavailable');
  const generation = await detectRosterGeneration(provider, config.registry, head.number);
  const result = generation === 'v1-live'
    ? await checkLegacyDemoFreshness(provider, config)
    : await checkDemoFreshness(provider, config);
  console.log(JSON.stringify({ generation, ...result }, null, 2));
  console.log(`PASS: observed pilot state (${generation}) has the requested scheduled window. This does not guarantee future eligibility or judging-period availability.`);
} finally { provider.destroy(); }
