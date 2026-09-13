// Parses cast/curl output only. No dotenv, network, signer, or filesystem access.
import { keccak256 } from 'ethers';

let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (Buffer.byteLength(body) > 2_000_000) throw new Error('verification output exceeds limit');
}
const [mode, label, ...expected] = process.argv.slice(2);
const fail = () => { throw new Error(`FAIL: ${label || 'demo assertion'} (${mode})`); };
function scalar(raw) {
  const value = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (/^(true|false)$/.test(value)) return value;
  const integer = /^(\d+)(?: \[\d+(?:\.\d+)?(?:e[+-]?\d+)?\])?$/.exec(value);
  if (integer) return BigInt(integer[1]).toString();
  fail();
}
if (mode === 'scalar') {
  if (expected.length !== 1 || scalar(body) !== scalar(expected[0])) fail();
} else if (mode === 'tuple') {
  const lines = body.trim().split('\n');
  if (lines.length !== expected.length || !expected.length) fail();
  for (let i = 0; i < lines.length; i++) if (scalar(lines[i]) !== scalar(expected[i])) fail();
} else if (mode === 'runtime') {
  const code = body.trim();
  if (expected.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(expected[0]) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)
    || keccak256(code).toLowerCase() !== expected[0].toLowerCase()) fail();
} else if (mode === 'screen') {
  const data = JSON.parse(body);
  if (data.decision !== 'BLOCK' || data.riskBand !== 5 || !Array.isArray(data.hits)
    || !data.hits.some(hit => hit.listId === 'OFAC_SDN' && hit.entryId === '20157' && hit.corroborated === true)) fail();
} else if (mode === 'status') {
  const data = JSON.parse(body);
  if (expected.length !== 1 || data.demo !== true || data.sandboxBits !== true
    || data.id?.configured !== true || data.id?.vendor !== 'demo:id' || data.id?.live !== false
    || data.bank?.configured !== true || data.bank?.vendor !== 'demo:bank' || data.bank?.live !== false
    || data.issuer?.configured !== true || typeof data.issuer.address !== 'string'
    || scalar(data.issuer.address) !== scalar(expected[0]) || data.issuanceJournal?.configured !== true) fail();
} else if (mode === 'revert') {
  // Match exact ABI data (selector plus recipient and policy), not an arbitrary selector substring.
  if (expected.length !== 1 || !/^0x[0-9a-fA-F]{136}$/.test(expected[0])) fail();
  const hex = body.match(/0x[0-9a-fA-F]+/g) ?? [];
  if (!hex.some(value => value.toLowerCase() === expected[0].toLowerCase())) fail();
} else if (mode === 'receipt') {
  const receipt = JSON.parse(body);
  if (expected.length !== 2 || !/^0x[0-9a-fA-F]{64}$/.test(expected[0])
    || typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== expected[0].toLowerCase()
    || typeof receipt.to !== 'string' || scalar(receipt.to) !== scalar(expected[1])
    || ![1, '1', '0x1', '0x01'].includes(receipt.status) || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
    || !/^(?:0x[0-9a-fA-F]+|\d+)$/.test(String(receipt.blockNumber)) || BigInt(receipt.blockNumber) <= 0n) fail();
} else fail();
console.log(`PASS: ${label}`);
