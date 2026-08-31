import { NextResponse } from 'next/server';
import { createPublicClient, http, defineChain, parseAbi, type Address } from 'viem';

export const runtime = 'nodejs';
export const revalidate = 0;

const cc3 = defineChain({
  id: 102031, name: 'Creditcoin CC3 Testnet',
  nativeCurrency: { name: 'CTC', symbol: 'CTC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_CC3_RPC!] } },
});
const client = createPublicClient({ chain: cc3, transport: http() });

const ASC = process.env.NEXT_PUBLIC_ASC as Address;
const REG = process.env.NEXT_PUBLIC_REGISTRY as Address;

const ascAbi = parseAbi([
  'function expectedChainKey() view returns (uint64)',
  'function sourceContract() view returns (address)',
  'function tombstone(address) view returns (bool)',
  'function getMark(address) view returns ((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))',
  'function latestEpoch() view returns (uint32)',
  'function epochValidUntil() view returns (uint40)',
  'function isRosterFresh() view returns (bool)',
  'function epochRoots(uint32) view returns (bytes32)',
]);
const regAbi = parseAbi([
  'function isVerified(address,uint256) view returns (bool)',
  'function policies(uint256) view returns (uint32,uint8,uint40,bool,bool)',
]);

export async function GET(req: Request) {
  const subject = (new URL(req.url).searchParams.get('subject') ??
    '0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1') as Address;

  const [chainKey, source, tomb, mark, p1, p2, v1, v2, block, latestEpoch, epochValidUntil, rosterFresh] = await Promise.all([
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'expectedChainKey' }),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'sourceContract' }),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'tombstone', args: [subject] }),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'getMark', args: [subject] }),
    client.readContract({ address: REG, abi: regAbi, functionName: 'policies', args: [1n] }),
    client.readContract({ address: REG, abi: regAbi, functionName: 'policies', args: [2n] }),
    client.readContract({ address: REG, abi: regAbi, functionName: 'isVerified', args: [subject, 1n] }),
    client.readContract({ address: REG, abi: regAbi, functionName: 'isVerified', args: [subject, 2n] }),
    client.getBlockNumber(),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'latestEpoch' }),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'epochValidUntil' }),
    client.readContract({ address: ASC, abi: ascAbi, functionName: 'isRosterFresh' }),
  ]);

  /* epochRoots needs latestEpoch first, so it cannot ride in the batch above. Epoch 0 is never a
     published epoch — the source enforces `epoch > lastEpoch` from zero — so we report a null root
     rather than reading `epochRoots(0)` and passing off bytes32(0) as data. */
  const epochRoot = latestEpoch === 0
    ? null
    : await client.readContract({ address: ASC, abi: ascAbi, functionName: 'epochRoots', args: [latestEpoch] });

  const m = mark as readonly [number, number, number, number, number, number, number, number, number, number, `0x${string}`, `0x${string}`, Address];

  /* The issuer field is carried data: `isVerified` never checks it against a tombstone. We read it
     anyway because on this testnet one EOA is deployer, issuer and revoked demo subject, and the
     page has to say so before anyone reads it as a compromised issuer key. */
  const issuer = m[12];
  const issuerTombstoned = issuer === '0x0000000000000000000000000000000000000000'
    ? false
    : await client.readContract({ address: ASC, abi: ascAbi, functionName: 'tombstone', args: [issuer] });

  const pol = (p: readonly [number, number, number, boolean, boolean]) => ({
    requireAll: p[0], requireAllHex: '0x' + p[0].toString(16),
    minAssurance: p[1], maxAge: Number(p[2]), requireRoster: p[3], exists: p[4],
  });

  return NextResponse.json({
    subject, blockNumber: Number(block),
    asc: { address: ASC, expectedChainKey: Number(chainKey), sourceContract: source },
    registry: { address: REG },
    tombstone: tomb,
    mark: {
      status: m[0], origin: m[1], kind: m[2], assurance: m[3], regime: m[4], jurisdiction: m[5],
      methods: m[6], methodsHex: '0x' + m[6].toString(16),
      issuedAt: m[7], expiry: m[8], epoch: m[9],
      claimsRoot: m[10], evidenceHash: m[11], issuer, issuerTombstoned,
    },
    policies: [
      { id: 1, name: 'KR VASP production', ...pol(p1 as never), verified: v1 },
      { id: 2, name: 'KR pilot',           ...pol(p2 as never), verified: v2 },
    ],
    epoch: {
      latestEpoch: Number(latestEpoch),
      root: epochRoot,
      validUntil: Number(epochValidUntil),
      fresh: rosterFresh,
    },
  });
}
