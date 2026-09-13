// Parse a mined source receipt against independently supplied public issuance expectations.
// No network, signer, dotenv, file access or raw error projection.
import { Interface } from 'ethers';

try {
  const expected = process.argv.slice(2);
  if (expected.length !== 10) throw new Error();
  const [tx, source, transactionTo, issuer, subject, attrs, claimsRoot, evidenceHash, headText, depthText] = expected;
  const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
  const word = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const quantity = value => {
    if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      && !(typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value))) throw new Error();
    const n = BigInt(value); if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(); return n;
  };
  if (![source, transactionTo, issuer, subject].every(address) || ![tx, attrs, claimsRoot, evidenceHash].every(word)
    || !/^\d+$/.test(headText) || !/^[1-9]\d*$/.test(depthText)) throw new Error();
  const head = quantity(headText), depth = quantity(depthText);
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 2_000_000) throw new Error(); chunks.push(bytes);
  }
  const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!receipt || !same(receipt.transactionHash, tx) || !same(receipt.to, transactionTo)
    || quantity(receipt.status) !== 1n || !word(receipt.blockHash) || /^0x0{64}$/.test(receipt.blockHash)
    || !Array.isArray(receipt.logs)) throw new Error();
  const height = quantity(receipt.blockNumber), index = quantity(receipt.transactionIndex);
  if (height === 0n || height > head || head - height + 1n < depth) throw new Error();
  const abi = new Interface([
    'event MarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,bytes32 claimsRoot,bytes32 evidenceHash)',
    'event KeyedMarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,uint64 issuerKeyEpoch,bytes32 claimsRoot,bytes32 evidenceHash)',
    'event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)',
    'event SanctionDenied(address indexed subject,uint32 indexed listVersion,uint32 indexed epoch)',
  ]);
  const known = new Set(['MarkIssued', 'KeyedMarkIssued', 'MarkRevoked', 'SanctionDenied'].map(name => abi.getEvent(name).topicHash));
  let previous = -1n; const matches = [];
  for (const [position, log] of receipt.logs.entries()) {
    if (!log || !address(log.address) || !Array.isArray(log.topics) || !log.topics.every(word)
      || typeof log.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      || (log.removed !== undefined && log.removed !== false)
      || !same(log.transactionHash, tx) || !same(log.blockHash, receipt.blockHash)
      || quantity(log.blockNumber) !== height || quantity(log.transactionIndex) !== index) throw new Error();
    const logIndex = quantity(log.logIndex);
    if (logIndex <= previous) throw new Error(); previous = logIndex;
    if (!same(log.address, source) || !known.has(log.topics[0]?.toLowerCase())) continue;
    const decoded = abi.parseLog(log);
    if (!decoded) throw new Error();
    const encoded = abi.encodeEventLog(decoded.fragment, decoded.args);
    if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length
      || encoded.topics.some((topic, i) => !same(topic, log.topics[i]))) throw new Error();
    if (same(decoded.args.subject, subject)) matches.push({ decoded, position });
  }
  // A unique issuance for this subject, not an issuance later overwritten/revoked/denied in the receipt.
  if (matches.length !== 1) throw new Error();
  const { decoded, position } = matches[0];
  if (!['MarkIssued', 'KeyedMarkIssued'].includes(decoded.name) || !same(decoded.args.issuer, issuer) || !same(decoded.args.attrs, attrs)
    || !same(decoded.args.claimsRoot, claimsRoot) || !same(decoded.args.evidenceHash, evidenceHash)) throw new Error();
  console.log(`${height} ${receipt.blockHash.toLowerCase()} ${index} ${position}`);
} catch { console.error('FAIL: DEMO_ISSUANCE_RECEIPT_MISMATCH'); process.exitCode = 1; }
