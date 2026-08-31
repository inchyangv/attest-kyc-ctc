/**
 * Publishes an epoch roster (Mode B) and proves it landed.
 *
 * Mode A carries one mark at a time: an individual proof that subject X was issued at source
 * block N. It proves issuance and says nothing about a revocation nobody submitted.
 * Mode B publishes the whole active set as one sorted-key Merkle root. Membership is the mark;
 * falling OUT of the root is the revocation. That is the only shape in which a verifier can be
 * handed positive evidence of absence, which is why `Policy.requireRoster` exists.
 *
 * The tree itself is `pipeline/roster.ts` and its Solidity twin `src/lib/RosterProof.sol`. This
 * script does not reimplement either; it imports the TypeScript side and then asks the deployed
 * contracts whether they agree.
 *
 * Usage (repository root):
 *
 *     npx tsx script/publish-epoch.ts             # same as --dry-run
 *     npx tsx script/publish-epoch.ts --dry-run   # build the roster, print the plan, send nothing
 *     npx tsx script/publish-epoch.ts --publish    # one setEpochPublisher tx (if needed) + one publishEpoch tx
 *     npx tsx script/publish-epoch.ts --check      # view calls only: is the on-chain root ours, do the proofs verify
 *     npx tsx script/publish-epoch.ts --help
 *
 * Only `--publish` reads a private key, and only `--publish` loads `.env`. Every other mode runs
 * with no key and no configuration at all: the RPC URLs fall back to the public endpoints, so a
 * dry run works from an empty directory.
 *
 * One transaction emits one kind of ASC event. `publishEpoch` is therefore always sent on its own,
 * never batched with issuance or role changes: ASCBase derives queryId from
 * (chainKey, blockHeight, txIndex) and carries neither the action nor the log index, so a source
 * transaction gets exactly one execute(). Mixing event kinds lets an attacker land the cheap
 * action first, consume the queryId, and seal the rest of that transaction forever.
 */
import { ethers } from 'ethers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRoster, inclusionProof, nonInclusionProof, leafIndexOf, rosterLeaf,
  verifyInclusion, verifyNonInclusion,
  type RosterEntry, type RosterTree,
} from '../pipeline/roster.js';
import { packAttrs } from '../pipeline/attrs.js';

// ── Address book. deployments/cc3-testnet.json, pinned here so a dry run needs no files. ──

const SOURCE_ADDRESS   = '0x93C62D3016123Da0aBdB4AC1857564c30CbE5629';   // ComplianceSource, Sepolia
const ASC_ADDRESS      = '0x93C62D3016123Da0aBdB4AC1857564c30CbE5629';   // ProofmarkASC, CC3 (same address, different bytecode)
const REGISTRY_ADDRESS = '0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc';   // ProofmarkRegistry, CC3

const DEFAULT_SOURCE_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_HUB_RPC    = 'https://rpc.cc3-testnet.creditcoin.network';

/** The mark the demo is built around: passes deployed policy 2, fails policy 1. */
const DEMO_SUBJECT = '0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1';
/** Deployer, issuer and deliberately revoked demo subject, all one testnet EOA. Excluded as a subject. */
const REVOKED_SUBJECT = '0xFD1222e35a536A62f180aA44826656940e86bD5E';
/** Never issued to. The other half of the non-membership demonstration. */
const NEVER_ISSUED = '0x00000000000000000000000000000000DeaDBeef';

const POLICY_PILOT = 2n;        // KR pilot, requireAll 0x190001
const POLICY_PRODUCTION = 1n;   // KR VASP production, requireAll 0x10024, minAssurance 2

// ── ABIs. Hand-written fragments, so the script runs without `forge build`. ──

/** ComplianceSource.MarkIssued(address,bytes32,address,bytes32,bytes32), docs/04 section 8. */
const MARK_ISSUED_TOPIC = '0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3';
/** ProofmarkASC.MarkMaterialized(address,bytes32,uint64) */
const MARK_MATERIALIZED_TOPIC = '0xd39908fbf96ca1a6a6921f1ba6a603b019b3b87fbb4262c3f40ef45e3373d49a';
/** ProofmarkASC.MarkTombstoned(address,uint8,uint64) */
const MARK_TOMBSTONED_TOPIC = '0x880e750f20f345a8a90fdaf287f423e33cea724427e3838a9e906d85b4dde2e3';
/** ProofmarkASC.EpochAccepted(uint32,bytes32,uint40) */
const EPOCH_ACCEPTED_TOPIC = '0xfcff600f0b9092688b51858706a9ecb86f00ca2cc9a2cc7fd495f6ddeee9663c';

const SOURCE_ABI = [
  'function lastEpoch() view returns (uint32)',
  'function owner() view returns (address)',
  'function isEpochPublisher(address) view returns (bool)',
  'function setEpochPublisher(address account, bool allowed)',
  'function publishEpoch(uint32 epoch, bytes32 root, uint32 listVersion, uint40 validUntil)',
];

const ASC_ABI = [
  'function tombstone(address) view returns (bool)',
  'function latestEpoch() view returns (uint32)',
  'function epochValidUntil() view returns (uint40)',
  'function epochRoots(uint32) view returns (bytes32)',
  'function isRosterFresh() view returns (bool)',
  'function getMark(address) view returns (tuple(uint8 status, uint8 origin, uint8 kind, uint8 assurance, uint16 regime, uint16 jurisdiction, uint32 methods, uint40 issuedAt, uint40 expiry, uint32 epoch, bytes32 claimsRoot, bytes32 evidenceHash, address issuer))',
];

const REGISTRY_ABI = [
  'function verifyWithRoster(address subject, uint256 policyId, tuple(bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash, address issuer) mark, tuple(uint256 index, bytes32[] siblings) inclusion) view returns (bool)',
  'function proveNotInRoster(address subject, tuple(tuple(uint256 index, bytes32[] siblings) left, bytes32 leftLeaf, bytes32 leftKey, tuple(uint256 index, bytes32[] siblings) right, bytes32 rightLeaf, bytes32 rightKey) proof) view returns (bool)',
];

// ── Small helpers ──

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const num = (name: string, dflt: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`environment variable ${name} must be a non-negative integer, got ${v}`);
  return n;
};

const say  = (s = '') => console.log(s);
const ok   = (s: string) => console.log(`  ok ${s}`);
const bad  = (s: string) => console.error(`  x  ${s}`);
const step = (s: string) => console.log(`\n${s}`);

const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
const short = (h: string) => `${h.slice(0, 10)}…`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Retry an RPC read.
 *
 * The default public Sepolia endpoint is load balanced across backends that do not agree with each
 * other, and some answers arrive as transport errors ("could not coalesce error"). Reads are free
 * and idempotent, so retrying one is strictly better than failing the run. Nothing that writes
 * goes through here.
 */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = num('RPC_ATTEMPTS', 5)): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (i < attempts) await sleep(400 * i);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${last?.shortMessage ?? last?.message ?? last}`);
}

// ── 1. Roster construction ─────────────────────────────────────────────────────

/**
 * Oldest ComplianceSource log this repository has observed on Sepolia: the `setIssuer` call made
 * immediately after deployment (block 11597760, 2026-08-31). Used only as a floor for the source
 * scan, so a public endpoint that answers a wide `eth_getLogs` incompletely cannot shorten the
 * range. Discovery still runs; this is the backstop, and `SOURCE_FROM_BLOCK` overrides both.
 */
const SOURCE_EARLIEST_KNOWN_BLOCK = 11_597_760;

interface Candidate {
  subject: string;
  entry: RosterEntry;
  blockNumber: number;
  logIndex: number;
  txHash: string;
}

interface Excluded { subject: string; reason: string }

interface Roster {
  tree: RosterTree;
  excluded: Excluded[];
  scannedFrom: number;
  scannedTo: number;
  startMethod: string;
}

/**
 * Smallest block at which the contract already has code.
 *
 * Cheap — about 24 calls for an 11.6M-block chain — but it needs historical state, which the
 * public Sepolia endpoint prunes ("state at block #N is pruned"). The caller falls back when this
 * throws, so an archive endpoint gets the exact answer and a pruned one still works.
 */
async function creationBlockByCode(src: ethers.JsonRpcProvider, address: string, head: number): Promise<number> {
  if ((await src.getCode(address, head)) === '0x') throw new Error(`no code at ${address} on the source chain`);
  let lo = 0, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await src.getCode(address, mid);   // throws on a pruned node
    if (code === '0x') lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Oldest block carrying a log from `address`, found by walking backwards in windows.
 *
 * Works on a pruned node, because the log index survives state pruning. Two consecutive empty
 * windows are required before stopping: one endpoint behind this URL answered a 15,000-block range
 * with one of the four logs it returned for a 1,000-block sub-range, so a single empty answer is
 * not evidence that history ended.
 */
async function earliestLogBlock(
  provider: ethers.JsonRpcProvider, address: string, head: number, window: number, maxWindows: number,
): Promise<number | null> {
  let earliest: number | null = null;
  let emptyRun = 0;
  let to = head;
  for (let i = 0; i < maxWindows && to >= 0; i++) {
    const from = Math.max(0, to - window + 1);
    const logs = await retry(`getLogs ${from}-${to}`, () => provider.getLogs({ address, fromBlock: from, toBlock: to }));
    if (logs.length > 0) {
      const min = Math.min(...logs.map((l) => l.blockNumber));
      earliest = earliest === null ? min : Math.min(earliest, min);
      emptyRun = 0;
    } else if (++emptyRun >= 2 && earliest !== null) {
      return earliest;
    }
    if (from === 0) break;
    to = from - 1;
  }
  return earliest;
}

/**
 * What the chain of record has ever materialised, read from the ASC's own events on CC3.
 *
 * This is the completeness anchor for the source scan. `MarkMaterialized` and `MarkTombstoned`
 * carry the SOURCE block height they were applied from, so CC3 states, independently of any
 * Sepolia log query, both which subjects exist and how far back the source scan has to reach.
 * Without it a public endpoint that drops a `MarkIssued` from its answer would silently produce a
 * roster missing an active mark — and absence from a roster is exactly how revocation is expressed.
 */
async function hubKnownSubjects(
  hub: ethers.JsonRpcProvider, head: number, window: number, maxWindows: number,
): Promise<{ subjects: Set<string>; minSourceHeight: number | null }> {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const subjects = new Set<string>();
  let minSourceHeight: number | null = null;
  let emptyRun = 0;
  let to = head;

  for (let i = 0; i < maxWindows && to >= 0; i++) {
    const from = Math.max(0, to - window + 1);
    // No topic filter, matching the worker: an event added later is not silently missed.
    const logs = await retry(`CC3 getLogs ${from}-${to}`, () => hub.getLogs({ address: ASC_ADDRESS, fromBlock: from, toBlock: to }));
    let hits = 0;
    for (const l of logs) {
      if (l.topics[0] !== MARK_MATERIALIZED_TOPIC && l.topics[0] !== MARK_TOMBSTONED_TOPIC) continue;
      hits++;
      subjects.add(ethers.getAddress(ethers.dataSlice(l.topics[1], 12)));
      // data: MarkMaterialized (bytes32 attrs, uint64 blockHeight) · MarkTombstoned (uint8 status, uint64 blockHeight)
      const shape = l.topics[0] === MARK_MATERIALIZED_TOPIC ? ['bytes32', 'uint64'] : ['uint8', 'uint64'];
      const srcHeight = Number(coder.decode(shape, l.data)[1]);
      if (srcHeight > 0) minSourceHeight = minSourceHeight === null ? srcHeight : Math.min(minSourceHeight, srcHeight);
    }
    if (logs.length > 0) emptyRun = 0; else if (++emptyRun >= 2 && hits === 0 && subjects.size > 0) break;
    if (from === 0) break;
    to = from - 1;
  }
  return { subjects, minSourceHeight };
}

async function findScanStart(
  src: ethers.JsonRpcProvider, head: number, hubMinSourceHeight: number | null,
): Promise<{ block: number; method: string }> {
  if (process.env.SOURCE_FROM_BLOCK) {
    return { block: num('SOURCE_FROM_BLOCK', 0), method: 'SOURCE_FROM_BLOCK' };
  }

  const floors: string[] = [];
  let block = SOURCE_EARLIEST_KNOWN_BLOCK;
  floors.push('oldest observed contract log');

  if (hubMinSourceHeight !== null && hubMinSourceHeight < block) {
    block = hubMinSourceHeight;
    floors.unshift('oldest source height in the ASC events on CC3');
  }

  try {
    const created = await creationBlockByCode(src, SOURCE_ADDRESS, head);
    if (created < block) { block = created; floors.unshift('contract creation block (eth_getCode binary search)'); }
    else floors.push('contract creation block (eth_getCode binary search)');
  } catch (e: any) {
    say(`  note: eth_getCode over history is unavailable here (${e?.shortMessage ?? e?.message ?? e}); using the log-index floors instead`);
    const walked = await earliestLogBlock(src, SOURCE_ADDRESS, head, num('SOURCE_LOG_WINDOW', 50_000), num('SOURCE_LOG_WINDOWS', 40));
    if (walked !== null && walked < block) { block = walked; floors.unshift('oldest contract log (eth_getLogs backward walk)'); }
  }

  return { block, method: `lowest of: ${floors.join(', ')}` };
}

/**
 * One `eth_getLogs` pass over [from, to], stepping by `span`, unioned into `into`.
 *
 * Filtered by address only and matched on topic0 here, the way the worker does it: the same
 * endpoint answered an address-and-topic query for a range with none of the logs it returned for
 * the identical address-only query, so the topic filter is not something to rely on. Client-side
 * matching costs one comparison per log and cannot lose one.
 */
async function issuancePass(
  src: ethers.JsonRpcProvider, from: number, to: number, span: number, into: Map<string, Candidate>,
): Promise<number> {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let seen = 0;

  for (let start = from; start <= to; start += span) {
    const end = Math.min(start + span - 1, to);
    const logs = await retry(`getLogs ${start}-${end}`, () => src.getLogs({ address: SOURCE_ADDRESS, fromBlock: start, toBlock: end }));
    for (const l of logs) {
      if (l.topics[0] !== MARK_ISSUED_TOPIC) continue;
      seen++;
      // topics: sig, subject, attrs, issuer. data: claimsRoot, evidenceHash.
      const subject = ethers.getAddress(ethers.dataSlice(l.topics[1], 12));
      const issuer = ethers.getAddress(ethers.dataSlice(l.topics[3], 12));
      const [claimsRoot, evidenceHash] = coder.decode(['bytes32', 'bytes32'], l.data);
      into.set(`${l.transactionHash}:${l.index}`, {
        subject,
        entry: { subject, attrs: l.topics[2], claimsRoot, evidenceHash, issuer },
        blockNumber: l.blockNumber, logIndex: l.index, txHash: l.transactionHash,
      });
    }
  }
  return seen;
}

/** Newest MarkIssued per subject out of everything collected so far. */
function newestPerSubject(all: Map<string, Candidate>): Map<string, Candidate> {
  const latest = new Map<string, Candidate>();
  for (const c of all.values()) {
    const prev = latest.get(c.subject);
    const newer = !prev || c.blockNumber > prev.blockNumber
      || (c.blockNumber === prev.blockNumber && c.logIndex > prev.logIndex);
    if (newer) latest.set(c.subject, c);
  }
  return latest;
}

/**
 * Every MarkIssued in the range, collected until the ASC's own subject set is covered.
 *
 * Each attempt sweeps the range twice, once in small chunks and once in wide windows, and unions
 * the results. Two widths because the endpoint's answers disagree by width, and a union because it
 * can only ever be too complete — a surplus candidate is thrown out by the ASC filters afterwards,
 * whereas a missing one silently becomes a revocation. The loop stops as soon as the union covers
 * every subject CC3 knows about; the caller fails closed if it never does.
 */
async function collectIssuances(
  src: ethers.JsonRpcProvider, from: number, to: number,
  chunk: number, window: number, attempts: number, hubSubjects: Set<string>,
): Promise<{ latest: Map<string, Candidate>; all: Map<string, Candidate>; attemptsUsed: number }> {
  const all = new Map<string, Candidate>();
  let latest = new Map<string, Candidate>();

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const before = all.size;
    const chunked = await issuancePass(src, from, to, chunk, all);
    const windowed = await issuancePass(src, from, to, window, all);
    latest = newestPerSubject(all);
    const missing = [...hubSubjects].filter((s) => !latest.has(s)).length;
    say(`               pass ${attempt}: ${chunked} in chunks of ${chunk}, ${windowed} in windows of ${window}, `
      + `${all.size} unioned (+${all.size - before}) → ${latest.size} subject(s), ${missing} known to CC3 still missing`);
    if (missing === 0) return { latest, all, attemptsUsed: attempt };
  }
  return { latest, all, attemptsUsed: Math.max(1, attempts) };
}

/**
 * The active set as the chain of record sees it.
 *
 * Sepolia says what was issued; CC3 says what survived. A subject enters the roster only if the
 * ASC holds it Active, untombstoned and unexpired — the same three conditions `isVerified`
 * applies — and only if the ASC's stored attributes are the ones the source event carries. Every
 * other subject is named with its reason: a roster that quietly drops a subject is
 * indistinguishable from one that quietly keeps a revoked one.
 */
async function buildFromChain(src: ethers.JsonRpcProvider, hub: ethers.JsonRpcProvider): Promise<Roster> {
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  const [srcHead, hubHead] = await Promise.all([
    retry('Sepolia getBlockNumber', () => src.getBlockNumber()),
    retry('CC3 getBlockNumber', () => hub.getBlockNumber()),
  ]);

  const hubKnown = await hubKnownSubjects(hub, hubHead, num('HUB_LOG_WINDOW', 20_000), num('HUB_LOG_WINDOWS', 20));
  say(`  hub scan     ProofmarkASC ${ASC_ADDRESS} on CC3`);
  say(`               ${hubKnown.subjects.size} subject(s) ever materialised or tombstoned, oldest source height ${hubKnown.minSourceHeight ?? 'unknown'}`);

  const { block: startBlock, method: startMethod } = await findScanStart(src, srcHead, hubKnown.minSourceHeight);
  const chunk = num('SOURCE_SCAN_CHUNK', 500);
  const window = num('SOURCE_LOG_WINDOW', 50_000);

  say(`  source scan  ComplianceSource ${SOURCE_ADDRESS} on Sepolia`);
  say(`               blocks ${startBlock}..${srcHead}, chunks of ${chunk} unioned with windows of ${window}`);
  say(`               start = ${startMethod}`);

  const scan = await collectIssuances(
    src, startBlock, srcHead, chunk, window, num('SOURCE_SCAN_ATTEMPTS', 4), hubKnown.subjects,
  );

  // Fail closed on an incomplete source scan. The ASC cannot know a subject that was never issued
  // on the source chain, so anything it knows and the scan never saw means the log query lost it.
  const missing = [...hubKnown.subjects].filter((s) => !scan.latest.has(s));
  if (missing.length) {
    bad(`the source scan is still incomplete after ${scan.attemptsUsed} pass(es): the ASC on CC3 knows`);
    bad('subjects with no MarkIssued event anywhere in the scanned range');
    for (const s of missing) bad(`  ${s}`);
    bad('Refusing to build a roster from a partial view — a missing active mark reads as a revocation.');
    bad('Widen the range with SOURCE_FROM_BLOCK, raise SOURCE_SCAN_ATTEMPTS, or point');
    bad('SOURCE_CHAIN_RPC_URL at an endpoint whose log index answers the whole range.');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const entries: RosterEntry[] = [];
  const excluded: Excluded[] = [];

  for (const c of [...scan.latest.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)) {
    const [tomb, mark] = await Promise.all([
      retry(`tombstone(${c.subject})`, () => asc.tombstone(c.subject) as Promise<boolean>),
      retry(`getMark(${c.subject})`, () => asc.getMark(c.subject) as Promise<any>),
    ]);
    const status = Number(mark.status);
    const expiry = Number(mark.expiry);

    if (tomb) { excluded.push({ subject: c.subject, reason: 'tombstoned on CC3 (revoked or sanctioned), so it is out of the roster — absence is the revocation' }); continue; }
    if (status !== 1) { excluded.push({ subject: c.subject, reason: `ASC status ${status}, not Active (1)` }); continue; }
    if (expiry <= now) { excluded.push({ subject: c.subject, reason: `mark expired at ${iso(expiry)}` }); continue; }

    // The roster entry has to be the mark the chain of record actually holds. If the ASC's stored
    // attributes repack to something else, the newest issuance has not been carried across yet,
    // and publishing the source's version would put a mark in the root that no verifier can
    // reconcile with ASC state.
    const repacked = packAttrs({
      kind: Number(mark.kind), assurance: Number(mark.assurance), regime: Number(mark.regime),
      jurisdiction: Number(mark.jurisdiction), methods: Number(mark.methods),
      issuedAt: Number(mark.issuedAt), expiry, epoch: Number(mark.epoch),
    });
    if (repacked.toLowerCase() !== c.entry.attrs.toLowerCase()) {
      excluded.push({ subject: c.subject, reason: `CC3 holds attrs ${repacked}, the source event carries ${c.entry.attrs} — the latest issuance has not been carried across yet` });
      continue;
    }
    if (mark.issuer.toLowerCase() !== c.entry.issuer.toLowerCase()
      || mark.claimsRoot.toLowerCase() !== c.entry.claimsRoot.toLowerCase()
      || mark.evidenceHash.toLowerCase() !== c.entry.evidenceHash.toLowerCase()) {
      excluded.push({ subject: c.subject, reason: 'CC3 holds a different issuer, claims root or evidence hash than the source event' });
      continue;
    }

    entries.push(c.entry);
  }

  const tree = buildRoster(entries);

  // Fail closed. Re-read the two conditions that must never hold for an included subject, rather
  // than trusting the loop above to have been written correctly.
  for (const e of tree.entries) {
    const [tomb, mark] = await Promise.all([
      retry(`tombstone(${e.subject})`, () => asc.tombstone(e.subject) as Promise<boolean>),
      retry(`getMark(${e.subject})`, () => asc.getMark(e.subject) as Promise<any>),
    ]);
    if (tomb || Number(mark.status) !== 1) {
      bad(`refusing to publish: ${e.subject} is tombstoned=${tomb} status=${Number(mark.status)} yet sits in the roster`);
      process.exit(1);
    }
  }

  return { tree, excluded, scannedFrom: startBlock, scannedTo: srcHead, startMethod };
}

function printRoster(r: Roster): void {
  const { tree } = r;
  step(`Roster — ${tree.entries.length} active mark(s), ${tree.leaves.length} leaves including both sentinels`);
  tree.entries.forEach((e, i) => {
    say(`  in   ${e.subject}  leaf ${leafIndexOf(i)}  attrs ${e.attrs}`);
  });
  for (const x of r.excluded) say(`  out  ${x.subject}  excluded: ${x.reason}`);
  if (!r.excluded.some((x) => x.subject.toLowerCase() === REVOKED_SUBJECT.toLowerCase())
    && !tree.entries.some((e) => e.subject.toLowerCase() === REVOKED_SUBJECT.toLowerCase())) {
    say(`  out  ${REVOKED_SUBJECT}  excluded: no MarkIssued event in the scanned range, so absent from the roster by construction`);
  }
  say(`  root ${tree.root}`);
}

/** Proves the tree we are about to publish against the same code the contract mirrors. */
function selfCheck(tree: RosterTree): void {
  step('Self-check against pipeline/roster.ts');
  let inclusionOk = true;
  tree.entries.forEach((e, i) => {
    const idx = leafIndexOf(i);
    if (!verifyInclusion(tree.root, rosterLeaf(e), inclusionProof(tree, idx))) {
      inclusionOk = false;
      bad(`inclusion failed for ${e.subject} at leaf ${idx}`);
    }
  });
  if (!inclusionOk) process.exit(1);
  say('  self-check inclusion: ok');

  let nonInclusionOk = true;
  for (const target of [REVOKED_SUBJECT, NEVER_ISSUED]) {
    try {
      if (!verifyNonInclusion(tree.root, target, nonInclusionProof(tree, target))) {
        nonInclusionOk = false;
        bad(`non-inclusion failed for ${target}`);
      }
    } catch (e: any) {
      nonInclusionOk = false;
      bad(`non-inclusion proof unavailable for ${target}: ${e?.message ?? e}`);
    }
  }
  if (!nonInclusionOk) process.exit(1);
  say('  self-check non-inclusion: ok');
}

// ── 2. Epoch parameters ────────────────────────────────────────────────────────

interface EpochParams { listVersion: number; validDays: number; validUntil: number }

function epochParams(): EpochParams {
  const listVersion = num('EPOCH_LIST_VERSION', 1);
  const validDays = num('EPOCH_VALID_DAYS', 60);
  const validUntil = Math.floor(Date.now() / 1000) + validDays * 86_400;
  if (validUntil >= 2 ** 40) throw new Error('validUntil does not fit in uint40');
  return { listVersion, validDays, validUntil };
}

/**
 * The freshness trade-off, stated with the numbers of this run.
 *
 * `validUntil` is a demo parameter, not a claim about how often we would publish. Once it passes,
 * `ASC.isRosterFresh()` is false and `verifyWithRoster` fails closed for everyone — there is no
 * "unknown means allowed" path. In production the epoch cadence would be daily so the roster
 * window matches the revocation SLA; here it is stretched so the roster is still fresh for anyone
 * reading the submission.
 */
function freshnessNote(p: EpochParams): string[] {
  return [
    `  validUntil ${p.validUntil} (${iso(p.validUntil)}), ${p.validDays} days from now`,
    '  That window is a demo parameter chosen so the roster stays fresh for anyone reading the',
    '  submission after the 2026-09-13 judging deadline. In production the epoch cadence would be',
    '  daily, so the roster window matches the revocation SLA rather than a review period.',
    '  Once validUntil passes, ASC.isRosterFresh() is false and verifyWithRoster fails closed for',
    '  every subject. An expired roster verifies nobody.',
  ];
}

// ── 3. Verdicts against the deployed contracts ─────────────────────────────────

interface Verdict { label: string; expected: boolean; actual: boolean }

async function rosterVerdicts(hub: ethers.JsonRpcProvider, tree: RosterTree): Promise<Verdict[]> {
  const reg = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, hub);
  const out: Verdict[] = [];

  const i = tree.entries.findIndex((e) => e.subject.toLowerCase() === DEMO_SUBJECT.toLowerCase());
  if (i < 0) {
    bad(`${DEMO_SUBJECT} is not in the roster, so the membership verdicts cannot be produced`);
    process.exit(1);
  }
  const e = tree.entries[i];
  const mark = { attrs: e.attrs, claimsRoot: e.claimsRoot, evidenceHash: e.evidenceHash, issuer: e.issuer };
  const inc = inclusionProof(tree, leafIndexOf(i));

  out.push({
    label: `verifyWithRoster(${short(DEMO_SUBJECT)}, policy ${POLICY_PILOT} KR pilot)`,
    expected: true,
    actual: await retry('verifyWithRoster(policy 2)', () => reg.verifyWithRoster(DEMO_SUBJECT, POLICY_PILOT, mark, inc)),
  });
  out.push({
    label: `verifyWithRoster(${short(DEMO_SUBJECT)}, policy ${POLICY_PRODUCTION} KR VASP production)`,
    expected: false,
    actual: await retry('verifyWithRoster(policy 1)', () => reg.verifyWithRoster(DEMO_SUBJECT, POLICY_PRODUCTION, mark, inc)),
  });

  for (const [target, what] of [[NEVER_ISSUED, 'never issued'], [REVOKED_SUBJECT, 'revoked']] as const) {
    const p = nonInclusionProof(tree, target);
    const arg = {
      left: p.left, leftLeaf: p.leftLeaf, leftKey: p.leftKey,
      right: p.right, rightLeaf: p.rightLeaf, rightKey: p.rightKey,
    };
    out.push({
      label: `proveNotInRoster(${short(target)}, ${what})`,
      expected: true,
      actual: await retry(`proveNotInRoster(${target})`, () => reg.proveNotInRoster(target, arg)),
    });
  }
  return out;
}

function printVerdicts(vs: Verdict[]): boolean {
  step('Registry verdicts (eth_call, no state written)');
  let allMatch = true;
  for (const v of vs) {
    const match = v.expected === v.actual;
    if (!match) allMatch = false;
    say(`  ${match ? 'ok ' : 'x  '}${v.label}\n       expected ${v.expected}  actual ${v.actual}`);
  }
  return allMatch;
}

// ── 4. Recording ──────────────────────────────────────────────────────────────

interface Record {
  epoch: number;
  root: string;
  listVersion: number;
  validUntil: number;
  validUntilIso?: string;
  validDays?: number;
  entryCount: number;
  entries: RosterEntry[];
  excluded?: Excluded[];
  setEpochPublisherTx?: string | null;
  publishEpochTx?: string;
  sepoliaBlock?: number;
  sepoliaConfirmedAt?: string;
  cc3AcceptedAt?: string;
  propagationSeconds?: number;
  propagationMethod?: string;
  checks?: { label: string; expected: boolean; actual: boolean }[];
  checkedAt?: string;
}

const recordPath = (epoch: number) => join(REPO, 'deployments', `epoch-${epoch}.json`);

/** Merge, so `--check` adds verdicts to what `--publish` measured instead of erasing it. */
function writeRecord(patch: Record): string {
  const p = recordPath(patch.epoch);
  let prev: Partial<Record> = {};
  try { prev = JSON.parse(readFileSync(p, 'utf8')); } catch { /* first write */ }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ ...prev, ...patch }, null, 2)}\n`);
  return p;
}

/**
 * The README snippet, built only from what this run measured.
 *
 * Nothing here is a template with a number pencilled in: if propagation was not measured, the
 * propagation row is not written. The repo's other measured numbers are not restated.
 */
function writeSnippet(rec: Record): string {
  const p = join(REPO, 'deployments', `epoch-${rec.epoch}.md`);
  const L: string[] = [];
  const prop = rec.propagationSeconds !== undefined ? mmss(rec.propagationSeconds) : null;

  L.push(`# Epoch ${rec.epoch} — measured README snippets`);
  L.push('');
  L.push(`Generated by \`script/publish-epoch.ts\`. Every number below was measured in the run that wrote this file${rec.checkedAt ? ` (checks ${rec.checkedAt})` : ''}. Paste, do not edit.`);
  L.push('');
  L.push('## Section 8 — replaces the bullet "Epoch rosters (Mode B) are built but not published on chain."');
  L.push('');

  const b: string[] = [];
  b.push(`- **Epoch rosters (Mode B) are live: epoch ${rec.epoch} is published on chain.** `);
  b.push(`The active set of ${rec.entryCount} mark${rec.entryCount === 1 ? '' : 's'} is one sorted-key Merkle root, \`${rec.root}\`, published by \`ComplianceSource.publishEpoch\` on Sepolia (\`${rec.publishEpochTx}\`) and accepted by \`ProofmarkASC\` on CC3`);
  if (prop) b.push(` ${prop} later (one run)`);
  b.push('. ');
  if (rec.checks?.length) {
    const v = (i: number) => String(rec.checks![i].actual);
    b.push(`Against that root the registry answers \`verifyWithRoster\` ${v(0)} under policy 2 and ${v(1)} under policy 1 for the same mark, and \`proveNotInRoster\` ${v(2)} for an address never issued to and ${v(3)} for the revoked subject — revocation as positive evidence of absence, not a missing record. `);
  }
  b.push(`The roster carries \`validUntil ${rec.validUntil}\` (${rec.validUntilIso ? `${rec.validUntilIso}, ` : ''}a demo parameter; production cadence would be daily), after which \`ASC.isRosterFresh()\` is false and \`verifyWithRoster\` fails closed for every subject. `);
  b.push('Marks issued before the epoch keep `origin = Direct`; the roster is the set, not a rewrite of their provenance.');
  L.push(b.join(''));
  L.push('');
  L.push('## Section 6 — one row for the cross-chain propagation table');
  L.push('');
  if (prop) {
    L.push('| Step | Value |');
    L.push('|---|---|');
    L.push(`| Epoch publish to \`latestEpoch\` on CC3 | ${prop}, one run |`);
    L.push('');
    L.push(`Measured ${rec.propagationMethod ?? 'from the publish confirmation to the epoch flip'}: ${rec.sepoliaConfirmedAt} to ${rec.cc3AcceptedAt}.`);
  } else {
    L.push('_Not written: this run did not measure propagation (no publish transaction in it)._');
  }
  L.push('');
  writeFileSync(p, `${L.join('\n')}\n`);
  return p;
}

// ── 5. Modes ──────────────────────────────────────────────────────────────────

function usage(): void {
  say(`Publish an epoch roster (Mode B) and prove it landed.

  npx tsx script/publish-epoch.ts [--dry-run | --publish | --check | --help]

  --dry-run   default. Rebuild the active set from chain, print the roster, the root and the
              planned calls, self-check the tree. Reads no key and sends nothing.
  --publish   Send at most two transactions on Sepolia, each on its own: setEpochPublisher (only
              when the signer is the owner and not yet a publisher), then publishEpoch. Then poll
              ProofmarkASC.latestEpoch() on CC3 until the worker has carried the event across
              (attestation measured 6.5-8.5 minutes) and record the measurement.
  --check     View calls only. Rebuild the roster, compare it with the on-chain root, then ask the
              deployed ProofmarkRegistry for membership and non-membership verdicts.
  --help      This text.

Environment (all optional except the key, which only --publish reads):

  SOURCE_CHAIN_RPC_URL   default ${DEFAULT_SOURCE_RPC}
  CREDITCOIN_RPC_URL     default ${DEFAULT_HUB_RPC}
  SOURCE_FROM_BLOCK      skip creation-block discovery and scan from here
  SOURCE_SCAN_CHUNK      default 500. Small eth_getLogs span for the source scan
  SOURCE_LOG_WINDOW      default 50000. Wide span, used for the second sweep and the backward walk
  SOURCE_LOG_WINDOWS     default 40. How many wide windows to walk before giving up
  SOURCE_SCAN_ATTEMPTS   default 4. Sweeps of the source range before an incomplete scan is fatal
  HUB_LOG_WINDOW         default 20000. CC3 eth_getLogs span (10s server-side query timeout)
  HUB_LOG_WINDOWS        default 20. How many CC3 windows to walk back
  EPOCH_LIST_VERSION     default 1. Version of the screening list set the roster was built against
  EPOCH_VALID_DAYS       default 60. Roster validity window in days (uint40 seconds on chain)
  EPOCH_POLL_SECONDS     default 15. Interval while waiting for CC3 to accept the epoch
  EPOCH_TIMEOUT_MINUTES  default 30. How long to wait before reporting the wait failed
  RPC_ATTEMPTS           default 5. Retries per RPC read; public endpoints answer inconsistently
  DEPLOYER_PRIVATE_KEY   --publish only, read from the root .env. Never printed or persisted

The roster is only ever built from chain state: the latest MarkIssued per subject on Sepolia,
filtered by what ProofmarkASC on CC3 still holds Active, untombstoned and unexpired.`);
}

/**
 * One request per call, never a JSON-RPC batch. Batching is what turns one flaky backend answer
 * into a whole failed sweep, and neither public endpoint here is reliable enough to batch against.
 */
function providers(): { src: ethers.JsonRpcProvider; hub: ethers.JsonRpcProvider } {
  const opts = { batchMaxCount: 1, staticNetwork: true } as const;
  return {
    src: new ethers.JsonRpcProvider(process.env.SOURCE_CHAIN_RPC_URL || DEFAULT_SOURCE_RPC, 11_155_111, opts),
    hub: new ethers.JsonRpcProvider(process.env.CREDITCOIN_RPC_URL || DEFAULT_HUB_RPC, 102_031, opts),
  };
}

async function dryRun(): Promise<void> {
  const { src, hub } = providers();
  step('Building the roster from chain state');
  const r = await buildFromChain(src, hub);
  printRoster(r);
  selfCheck(r.tree);

  const source = new ethers.Contract(SOURCE_ADDRESS, SOURCE_ABI, src);
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  const [lastEpoch, latestEpoch] = await Promise.all([
    retry('lastEpoch()', () => source.lastEpoch()),
    retry('latestEpoch()', () => asc.latestEpoch()),
  ]);
  const epoch = Number(lastEpoch) + 1;
  const p = epochParams();

  step('Planned calls');
  say(`  source lastEpoch ${Number(lastEpoch)} on Sepolia, ASC latestEpoch ${Number(latestEpoch)} on CC3, so this would publish epoch ${epoch}`);
  say('  1. setEpochPublisher(<signer>, true)  only if the signer is the owner and not already a publisher, as its own transaction');
  say(`  2. publishEpoch(${epoch}, ${r.tree.root}, ${p.listVersion}, ${p.validUntil})  as its own transaction, never batched`);
  for (const line of freshnessNote(p)) say(line);

  step('dry run — no transaction sent');
}

async function publish(): Promise<void> {
  await import('dotenv/config');   // only this path needs .env
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    bad('DEPLOYER_PRIVATE_KEY is not set. --publish signs two transactions on Sepolia; fill the root .env first.');
    process.exit(1);
  }

  const { src, hub } = providers();
  const wallet = new ethers.Wallet(key, src);
  const signer = await wallet.getAddress();

  step('Building the roster from chain state');
  const r = await buildFromChain(src, hub);
  printRoster(r);
  selfCheck(r.tree);

  const source = new ethers.Contract(SOURCE_ADDRESS, SOURCE_ABI, wallet);
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);

  const [lastEpoch, owner, alreadyPublisher, balance] = await Promise.all([
    retry('lastEpoch()', () => source.lastEpoch()),
    retry('owner()', () => source.owner()),
    retry('isEpochPublisher()', () => source.isEpochPublisher(signer)),
    retry('getBalance()', () => src.getBalance(signer)),
  ]);
  const epoch = Number(lastEpoch) + 1;
  const p = epochParams();

  step('Signer');
  say(`  address        ${signer}`);
  say(`  Sepolia ETH    ${ethers.formatEther(balance)}`);
  say(`  source owner   ${owner}`);
  say(`  epoch publisher ${alreadyPublisher}`);

  let setPublisherTx: string | null = null;
  if (!alreadyPublisher) {
    if (owner.toLowerCase() !== signer.toLowerCase()) {
      bad(`${signer} is neither the ComplianceSource owner (${owner}) nor an epoch publisher.`);
      bad('publishEpoch is onlyEpochPublisher and setEpochPublisher is onlyOwner, so this signer cannot publish.');
      process.exit(1);
    }
    step('Granting the epoch publisher role (its own transaction)');
    const tx = await source.setEpochPublisher(signer, true);
    say(`  sent ${tx.hash}`);
    const rc = await tx.wait();
    if (rc?.status !== 1) { bad(`setEpochPublisher failed: ${tx.hash}`); process.exit(1); }
    setPublisherTx = tx.hash;
    ok(`epoch publisher role granted in block ${rc.blockNumber}, gas ${rc.gasUsed}`);
  }

  step(`Publishing epoch ${epoch} (its own transaction — one transaction, one kind of ASC event)`);
  say(`  root        ${r.tree.root}`);
  say(`  listVersion ${p.listVersion}`);
  for (const line of freshnessNote(p)) say(line);

  const cc3BlockBefore = await retry('CC3 getBlockNumber', () => hub.getBlockNumber());
  const tx = await source.publishEpoch(epoch, r.tree.root, p.listVersion, p.validUntil);
  say(`  sent ${tx.hash}`);
  const rc = await tx.wait();
  if (rc?.status !== 1) { bad(`publishEpoch failed: ${tx.hash}`); process.exit(1); }
  const srcBlock = await retry('getBlock()', () => src.getBlock(rc.blockNumber));
  const t0 = Number(srcBlock!.timestamp);
  ok(`published in Sepolia block ${rc.blockNumber} at ${iso(t0)}, gas ${rc.gasUsed}`);

  let rec: Record = {
    epoch, root: r.tree.root, listVersion: p.listVersion,
    validUntil: p.validUntil, validUntilIso: iso(p.validUntil), validDays: p.validDays,
    entryCount: r.tree.entries.length, entries: r.tree.entries, excluded: r.excluded,
    setEpochPublisherTx: setPublisherTx, publishEpochTx: tx.hash,
    sepoliaBlock: rc.blockNumber, sepoliaConfirmedAt: iso(t0),
  };
  writeRecord(rec);

  // The worker carries the event: it watches ComplianceSource, waits for the Attestcoin
  // attestation, then submits execute() to the ASC. Nothing here can hurry that along.
  step('Waiting for CC3 to accept the epoch');
  say('  the separately-running worker carries the event; attestation measured 6.5 to 8.5 minutes');
  const pollMs = num('EPOCH_POLL_SECONDS', 15) * 1000;
  const timeoutMs = num('EPOCH_TIMEOUT_MINUTES', 30) * 60_000;
  const started = Date.now();
  let accepted = false;

  while (Date.now() - started < timeoutMs) {
    const latest = Number(await retry('latestEpoch()', () => asc.latestEpoch()));
    const elapsed = (Date.now() - started) / 1000;
    process.stdout.write(`\r  elapsed ${mmss(elapsed)}  latestEpoch ${latest}   `);
    if (latest >= epoch) { accepted = true; break; }
    await sleep(pollMs);
  }
  say();

  if (!accepted) {
    bad(`CC3 latestEpoch never reached ${epoch} within ${num('EPOCH_TIMEOUT_MINUTES', 30)} minutes.`);
    bad('The publish transaction is on Sepolia and stays valid; only the carry is missing. Check:');
    bad('  - is `npm run worker` running?');
    bad('  - was it started BEFORE the publish transaction? Its cursor starts at the current head,');
    bad(`    so an earlier event is never seen. Restart it with WORKER_START_BLOCK=${rc.blockNumber}.`);
    bad('  - does state/worker.json list this transaction, and in what state?');
    process.exit(1);
  }

  // Prefer on-chain timestamps: EpochAccepted gives the CC3 block the epoch landed in, which is
  // exact, where the poll loop only knows the epoch flipped some time in the last interval.
  let t1 = Math.floor(Date.now() / 1000);
  let method = `source block timestamp to poll detection (${num('EPOCH_POLL_SECONDS', 15)}s resolution)`;
  try {
    const hubHead = await retry('CC3 getBlockNumber', () => hub.getBlockNumber());
    const topic = ethers.zeroPadValue(ethers.toBeHex(epoch), 32);
    for (let from = cc3BlockBefore; from <= hubHead; from += 500) {
      const logs = await retry('CC3 EpochAccepted lookup', () => hub.getLogs({
        address: ASC_ADDRESS, topics: [EPOCH_ACCEPTED_TOPIC, topic],
        fromBlock: from, toBlock: Math.min(from + 499, hubHead),
      }));
      if (logs.length) {
        const blk = await retry('CC3 getBlock()', () => hub.getBlock(logs[0].blockNumber));
        t1 = Number(blk!.timestamp);
        method = 'source block timestamp to CC3 EpochAccepted block timestamp';
        say(`  EpochAccepted in CC3 block ${logs[0].blockNumber}, tx ${logs[0].transactionHash}`);
        break;
      }
    }
  } catch (e: any) {
    say(`  note: could not locate the EpochAccepted log (${e?.shortMessage ?? e?.message}); falling back to the poll timestamp`);
  }

  ok(`CC3 latestEpoch is ${epoch}`);
  ok(`propagation ${mmss(t1 - t0)} (one run), ${method}`);

  rec = { ...rec, cc3AcceptedAt: iso(t1), propagationSeconds: t1 - t0, propagationMethod: method };
  const jsonPath = writeRecord(rec);
  say(`  wrote ${jsonPath}`);

  step('Verifying against the deployed contracts');
  await check(rec);
}

/** `--check`, also reused as the tail of `--publish` so a publish is never reported unverified. */
async function check(carried?: Record): Promise<void> {
  const { src, hub } = providers();
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);

  step('Building the roster from chain state');
  const r = await buildFromChain(src, hub);
  printRoster(r);

  const latestEpoch = Number(await retry('latestEpoch()', () => asc.latestEpoch()));
  if (latestEpoch === 0) {
    step('no epoch published yet (latestEpoch=0)');
    say('  Mode B is implemented and tested, but nothing has been published on chain, so there is no');
    say('  root to verify against. Every deployed mark is origin = Direct.');
    say('  Publish one with: npx tsx script/publish-epoch.ts --publish   (worker running first)');
    process.exit(1);
  }

  const [onChainRoot, validUntil, fresh] = await Promise.all([
    retry('epochRoots()', () => asc.epochRoots(latestEpoch) as Promise<string>),
    retry('epochValidUntil()', () => asc.epochValidUntil() as Promise<bigint>),
    retry('isRosterFresh()', () => asc.isRosterFresh() as Promise<boolean>),
  ]);

  step(`On-chain epoch ${latestEpoch}`);
  say(`  root       ${onChainRoot}`);
  say(`  validUntil ${Number(validUntil)} (${iso(Number(validUntil))})`);
  say(`  fresh      ${fresh}`);

  if (onChainRoot.toLowerCase() !== r.tree.root.toLowerCase()) {
    step('roster drift — refusing to print verdicts');
    bad(`rebuilt root  ${r.tree.root}`);
    bad(`on-chain root ${onChainRoot}`);
    bad('The active set changed after epoch ' + latestEpoch + ' was published: a mark was issued,');
    bad('revoked, or expired since. Proofs built from the rebuilt tree cannot verify against the');
    bad('published root, and verdicts against a root that is not ours would mean nothing.');
    bad('Remedy: publish a fresh epoch (npx tsx script/publish-epoch.ts --publish). Do not edit');
    bad(`the roster to match; deployments/epoch-${latestEpoch}.json holds the entries as published.`);
    process.exit(1);
  }
  ok('rebuilt root matches the on-chain root');

  if (!fresh) {
    bad(`the roster is past its validUntil, so verifyWithRoster fails closed for every subject`);
  }

  const verdicts = await rosterVerdicts(hub, r.tree);
  const allMatch = printVerdicts(verdicts);

  // `carried` holds what --publish measured; the epoch state just read from chain wins where the
  // two overlap, and writeRecord merges both over whatever an earlier run left on disk.
  const rec: Record = {
    ...(carried ?? {}),
    epoch: latestEpoch,
    root: onChainRoot,
    listVersion: carried?.listVersion ?? epochParams().listVersion,
    validUntil: Number(validUntil),
    validUntilIso: iso(Number(validUntil)),
    entryCount: r.tree.entries.length,
    entries: r.tree.entries,
    excluded: r.excluded,
    checks: verdicts,
    checkedAt: new Date().toISOString().replace('.000Z', 'Z'),
  };

  const jsonPath = writeRecord(rec);
  const merged: Record = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const mdPath = writeSnippet(merged);
  step('Recorded');
  say(`  ${jsonPath}`);
  say(`  ${mdPath}   paste into README sections 8 and 6`);

  if (!allMatch || !fresh) {
    bad('at least one verdict did not match expectation');
    process.exit(1);
  }
  step('all verdicts match expectation');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const unknown = flags.filter((f) => !['--dry-run', '--publish', '--check', '--help'].includes(f));
  if (unknown.length) { bad(`unknown flag ${unknown.join(' ')}`); usage(); process.exit(1); }

  if (flags.includes('--help')) { usage(); return; }
  if (flags.includes('--publish')) return publish();
  if (flags.includes('--check')) return check();
  return dryRun();
}

main().catch((e) => {
  bad(e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
