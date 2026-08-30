/** methods bitmap — mirrors src/ProofmarkASC.sol / pipeline/methods.ts. Bits 0–10 identity, 16–20 screening. */
export const METHOD_BITS: { key: string; bit: number; label: string }[] = [
  { key: 'WALLET_CONTROL', bit: 0, label: 'Wallet control' },
  { key: 'ID_DOC_IMAGE', bit: 1, label: 'ID document image' },
  { key: 'ID_DOC_AUTHENTICITY', bit: 2, label: 'Document authenticity' },
  { key: 'FACE_MATCH', bit: 3, label: 'Face match' },
  { key: 'LIVENESS', bit: 4, label: 'Liveness' },
  { key: 'BANK_ACCOUNT', bit: 5, label: 'Bank account' },
  { key: 'MOBILE_CARRIER', bit: 6, label: 'Mobile carrier' },
  { key: 'VIDEO_CALL', bit: 7, label: 'Video call' },
  { key: 'IN_PERSON', bit: 8, label: 'In person' },
  { key: 'EPASSPORT_NFC', bit: 9, label: 'ePassport NFC' },
  { key: 'GOV_EID', bit: 10, label: 'Government eID' },
  { key: 'SANCTIONS_SCREENED', bit: 16, label: 'Sanctions screened' },
  { key: 'PEP_SCREENED', bit: 17, label: 'PEP screened' },
  { key: 'ADVERSE_MEDIA', bit: 18, label: 'Adverse media' },
  { key: 'JURISDICTION_CHECK', bit: 19, label: 'Jurisdiction check' },
  { key: 'ONCHAIN_EXPOSURE', bit: 20, label: 'On-chain exposure' },
];

export const bitOf = (key: string) => METHOD_BITS.find(m => m.key === key)?.bit;
export const setBits = (mask: number) => METHOD_BITS.filter(m => (mask & (1 << m.bit)) !== 0);
export const missingBits = (mask: number, required: number) =>
  METHOD_BITS.filter(m => (required & (1 << m.bit)) !== 0 && (mask & (1 << m.bit)) === 0);
export const hex = (n: number) => '0x' + n.toString(16);
