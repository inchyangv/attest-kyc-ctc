/** Explorer links. Testnet contracts live on CC3 Testnet (Blockscout) and Sepolia (Etherscan). */
export const CC3_EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';
export const CREDITCOIN_EXPLORER = 'https://creditcoin.blockscout.com';

export const cc3Address = (a: string) => `${CC3_EXPLORER}/address/${a}`;
export const cc3Block = (n: number | string) => `${CC3_EXPLORER}/block/${n}`;
export const sepoliaAddress = (a: string) => `${SEPOLIA_EXPLORER}/address/${a}`;
export const sepoliaTx = (h: string) => `${SEPOLIA_EXPLORER}/tx/${h}`;

export type Chain = 'CC3' | 'Sepolia';
export const addressUrl = (chain: Chain, a: string) => (chain === 'CC3' ? cc3Address(a) : sepoliaAddress(a));

type Contract = { name: string; role: string; chain: Chain; address: string };
export const CONTRACTS: Contract[] = ([
  { name: 'ProofmarkASC', role: 'Verifier', chain: 'CC3', address: process.env.NEXT_PUBLIC_ASC ?? '' },
  { name: 'ProofmarkRegistry', role: 'Policies', chain: 'CC3', address: process.env.NEXT_PUBLIC_REGISTRY ?? '' },
  { name: 'GatedRwaNote', role: 'Gated token', chain: 'CC3', address: process.env.NEXT_PUBLIC_NOTE ?? '' },
  { name: 'ComplianceSource', role: 'Issuer', chain: 'Sepolia', address: process.env.NEXT_PUBLIC_SOURCE ?? '' },
] as Contract[]).filter(c => c.address);
