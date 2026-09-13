/** Explicit local artifact workflow. Never loads .env, issuer keys, or sends a transaction. */
import { readSync, openSync, closeSync, fstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';
import { exportRosterBundle, loadRosterBundle, MAX_BUNDLE_BYTES, type RosterBundle, type RosterScope } from '../pipeline/roster-bundle.js';
import { checkBundleProof } from '../pipeline/roster-bundle-chain.js';
import { rosterProofServer } from '../pipeline/roster-proof-server.js';
import { recoverRosterBundleFromSeed } from '../pipeline/roster-bundle-availability.js';

const [mode, ...args] = process.argv.slice(2);
function boundedFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error('bundle/record input must be a bounded regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length !== stat.size) throw new Error('input changed size while reading');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function scopeFile(path: string): RosterScope {
  const d = JSON.parse(boundedFile(path).toString('utf8'));
  return { sourceChainId: d.network.sourceChainId, sourceChainKey: d.sourceChainKey, hubChainId: d.network.hubChainId,
    source: d.contracts.ComplianceSource, asc: d.contracts.ProofmarkASC, registry: d.contracts.ProofmarkRegistry };
}
if (mode === 'export' && args.length === 4 && args[3] === '--ack-linkable-roster') {
  const record = JSON.parse(boundedFile(args[0]).toString('utf8')) as RosterBundle;
  const scope = scopeFile(args[1]);
  if (!record || typeof record !== 'object') throw new Error('epoch record required');
  // All destinations are explicit. Source scan records, if present, must match this export scope.
  const sourceSnapshot = (record as unknown as { sourceSnapshot?: { source: string; chainId: string } }).sourceSnapshot;
  if (sourceSnapshot && (sourceSnapshot.source.toLowerCase() !== scope.source.toLowerCase() || sourceSnapshot.chainId !== String(scope.sourceChainId))) throw new Error('epoch record belongs to another source');
  const out = exportRosterBundle(record, scope);
  const directory = resolve(args[2]); mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${out.contentHash}.json`);
  writeFileSync(destination, out.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file: destination, contentHash: out.contentHash, bytes: out.bytes.length,
    chainValidation: 'not-performed', disclosure: 'wallet-linkable-full-roster; do not upload without data-rights approval' }, null, 2));
} else if (mode === 'proof' && args.length === 3) {
  const bundle = loadRosterBundle(boundedFile(args[0]), args[1]);
  console.log(JSON.stringify(bundle.proof(args[2]), null, 2));
} else if (mode === 'recover-seed' && args.length === 5 && args[4] === '--ack-linkable-roster') {
  const publishedAt = Number(args[2]);
  if (!Number.isSafeInteger(publishedAt) || publishedAt < 1 || !/^\d+$/.test(args[2])) throw new Error('positive source publication timestamp required');
  const recovered = recoverRosterBundleFromSeed(boundedFile(args[0]), args[1], publishedAt);
  const directory = resolve(args[3]); mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${recovered.contentHash}.json`);
  writeFileSync(destination, recovered.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file: destination, seedHash: args[1], contentHash: recovered.contentHash,
    bytes: recovered.bytes.length, chainValidation: 'not-performed',
    disclosure: 'wallet-linkable-full-roster; recovery does not establish current chain eligibility' }, null, 2));
} else if (mode === 'check' && args.length === 6) {
  const [file, pin, subject, policy, trustedDeployment, rpc] = args;
  if (!/^[1-9][0-9]*$/.test(policy)) throw new Error('positive policy ID required');
  const request = new ethers.FetchRequest(rpc); request.timeout = 10_000;
  const provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  try {
    const proof = loadRosterBundle(boundedFile(file), pin).proof(subject);
    console.log(JSON.stringify(await checkBundleProof(provider, scopeFile(trustedDeployment), proof, BigInt(policy)), null, 2));
  } finally { provider.destroy(); }
} else if (mode === 'serve' && args.length === 4 && args[3] === '--ack-linkable-roster') {
  const port = Number(args[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !/^\d+$/.test(args[2])) throw new Error('invalid local port');
  const bundle = loadRosterBundle(boundedFile(args[0]), args[1]);
  const server = rosterProofServer(bundle);
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: server.address(), contentHash: args[1], chainValidation: 'not-performed' })));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.closeAllConnections(); server.close(); });
} else {
  console.log(`Local immutable roster artifacts (no keys or transactions):
  export RECORD DEPLOYMENT OUTPUT_DIR --ack-linkable-roster
  proof BUNDLE SHA256 SUBJECT
  recover-seed SEED SHA256 SOURCE_PUBLISHED_AT OUTPUT_DIR --ack-linkable-roster
  check BUNDLE SHA256 SUBJECT POLICY_ID TRUSTED_DEPLOYMENT HUB_RPC
  serve BUNDLE SHA256 LOCAL_PORT --ack-linkable-roster

Publication mode stages complete seeds in configured replicas before signing. A surviving seed can
be finalized with the independently observed source receipt timestamp after publisher outage.
Content validity is not current chain eligibility. Distribution exposes wallet-linked credentials.
No automatic remote upload, public listener, latest alias, raw PII or production SLA is provided.`);
  if (mode !== '--help') process.exitCode = 1;
}
