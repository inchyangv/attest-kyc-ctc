// Bounded cast JSON parser only: no RPC, dotenv, signer or filesystem access.
try {
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 2_000_000) throw new Error();
    chunks.push(buffer);
  }
  const block = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error();
  const number = block.number;
  if (!(typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)
    && !(typeof number === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(number))) throw new Error();
  const height = BigInt(number);
  if (height < 0n || height > BigInt(Number.MAX_SAFE_INTEGER) || typeof block.hash !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) || /^0x0{64}$/.test(block.hash)) throw new Error();
  const hash = block.hash.toLowerCase(), [mode, ...expected] = process.argv.slice(2);
  if (mode === 'pin' && expected.length === 0) console.log(`${height} ${hash}`);
  else if (mode === 'check' && expected.length === 2 && expected[0] === height.toString() && expected[1] === hash) {
    console.log('PASS: chain block anchor unchanged');
  } else throw new Error();
} catch { console.error('FAIL: DEMO_BLOCK_ANCHOR_INVALID_OR_CHANGED'); process.exitCode = 1; }
