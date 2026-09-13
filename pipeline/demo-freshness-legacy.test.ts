import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { DEMO_NOTE_ABI } from './demo-freshness.js';
import { checkLegacyDemoFreshness, PILOT_POLICY_MAX_AGE_SECONDS, REQUIRED_METHODS } from './demo-freshness-legacy.js';
import { LEGACY_ASC_ABI, LEGACY_REGISTRY_ABI } from './roster-legacy-v1.js';

/** Synthetic v1 RPC state: Direct marks, no roster views, ROSTER_FORMAT_VERSION reverts. */
class LegacyFixture {
  asc = '0x' + '11'.repeat(20); registry = '0x' + '22'.repeat(20); note = '0x' + '55'.repeat(20);
  holderA = '0x' + '33'.repeat(20); holderB = '0x' + '66'.repeat(20); control = '0x' + '77'.repeat(20); issuer = '0x' + '44'.repeat(20);
  now = 1800000000; hash = ethers.id('observation'); chainId = 102031n; reorg = false; v2 = false;
  issuedAt = this.now - 100; expiry = this.now + 31536000; regime = 2; methods = 0x190027; status = 1; tombstone = false;
  production = false; pilot = true; controlVerified = false; allowControl = false; allowHolders = true;
  policyIssuer = this.issuer; frozen = true; pilotAge = PILOT_POLICY_MAX_AGE_SECONDS; noteRegistry = this.registry; notePolicy = 2;
  reads: { method: string; blockTag: unknown }[] = []; blockReads: unknown[] = [];
  readonly ascAbi = new ethers.Interface(LEGACY_ASC_ABI); readonly regAbi = new ethers.Interface(LEGACY_REGISTRY_ABI); readonly noteAbi = new ethers.Interface(DEMO_NOTE_ABI);
  config(minFreshSeconds = 900) {
    return { asc: this.asc, registry: this.registry, note: this.note, source: this.issuer, expectedIssuer: this.issuer,
      holders: [this.holderA, this.holderB] as const, control: this.control, minFreshSeconds };
  }
  call(to: string, data: string, blockTag: unknown): string {
    const abi = to.toLowerCase() === this.note ? this.noteAbi : to.toLowerCase() === this.asc ? this.ascAbi : this.regAbi;
    const f = abi.getFunction(data.slice(0, 10))!; const args = abi.decodeFunctionData(f, data);
    this.reads.push({ method: f.name, blockTag });
    const isControl = (a: unknown) => String(a).toLowerCase() === this.control;
    let value: unknown[];
    switch (f.name) {
      case 'ROSTER_FORMAT_VERSION': if (this.v2) { value = [2]; break; } throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
      case 'REGISTRY': value = [this.noteRegistry]; break;
      case 'POLICY_ID': value = [this.notePolicy]; break;
      case 'canTransfer': value = [isControl(args[1]) ? this.allowControl : this.allowHolders]; break;
      case 'expectedChainKey': value = [1]; break;
      case 'sourceContract': value = [this.issuer]; break;
      case 'tombstone': value = [!isControl(args[0]) && this.tombstone]; break;
      case 'getMark': value = [isControl(args[0]) ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroAddress]
        : [this.status, 1, 1, 3, this.regime, 410, this.methods, this.issuedAt, this.expiry, 0, ethers.id('claims'), ethers.id('evidence'), this.issuer]]; break;
      case 'policies': value = [REQUIRED_METHODS, 2, args[0] === 1n ? 2592000 : this.pilotAge, Number(args[0]), 410, this.policyIssuer, false, true]; break;
      case 'policyFrozen': value = [this.frozen]; break;
      case 'isVerified': value = [isControl(args[0]) ? this.controlVerified : args[1] === 1n ? this.production : this.pilot]; break;
      default: throw new Error('unsupported fixture call ' + f.name);
    }
    return abi.encodeFunctionResult(f, value);
  }
  provider(): ethers.Provider {
    return { getNetwork: async () => ethers.Network.from(this.chainId),
      getBlock: async (tag: unknown) => { this.blockReads.push(tag); return { number: 100, timestamp: this.now,
        hash: this.reorg && this.blockReads.length > 1 ? ethers.id('fork') : this.hash }; },
      getCode: async (_address: string, blockTag: unknown) => { this.reads.push({ method: 'getCode', blockTag }); return '0x6080'; },
      call: async (tx: { to: string; data: string; blockTag: unknown }) => this.call(tx.to, tx.data, tx.blockTag),
    } as unknown as ethers.Provider;
  }
  run(minFreshSeconds = 900) { return checkLegacyDemoFreshness(this.provider(), this.config(minFreshSeconds), this.now); }
}

test('legacy freshness reads every subject, policy and note call at one block and bounds the window by policy age', async () => {
  const f = new LegacyFixture(); const r = await f.run();
  assert.equal(r.generation, 'v1-live');
  assert.equal(r.holders[0].remainingSeconds, PILOT_POLICY_MAX_AGE_SECONDS - 100);
  assert.equal(r.holders[0].limits.policyAgeBoundary, f.issuedAt + PILOT_POLICY_MAX_AGE_SECONDS);
  assert.equal(r.scheduledUntilExclusive, f.issuedAt + PILOT_POLICY_MAX_AGE_SECONDS);
  assert.ok(f.reads.every(read => read.blockTag === 100), 'all reads are pinned to the observation block');
  assert.equal(f.blockReads.filter(b => b === 'latest').length, 1);
  assert.equal(r.observation.blockHash, f.hash); assert.match(r.guarantee, /none/);
  assert.ok(r.notVerified.some(item => item.startsWith('roster witnesses')));
});

test('the exclusive policy-age boundary, credential expiry and the requested window each gate the result', async () => {
  const f = new LegacyFixture(); f.issuedAt = f.now - PILOT_POLICY_MAX_AGE_SECONDS + 900;
  assert.equal((await f.run()).holders[0].remainingSeconds, 900);
  f.issuedAt = f.now - PILOT_POLICY_MAX_AGE_SECONDS + 899; await assert.rejects(f.run(), /scheduled freshness is only 899s/);
  const g = new LegacyFixture(); g.expiry = g.now + 950;
  assert.equal((await g.run()).holders[0].remainingSeconds, 950);
  await assert.rejects(new LegacyFixture().run(PILOT_POLICY_MAX_AGE_SECONDS + 1), /at most the pilot policy age/);
  await assert.rejects(new LegacyFixture().run(0), /positive whole number/);
});

test('tombstone, wrong regime/issuer/methods, dishonest verdicts, note mismatch, v2 registry and reorg all fail', async () => {
  const scenarios: [string, (f: LegacyFixture) => void][] = [
    ['tombstoned', f => { f.tombstone = true; }], ['inactive', f => { f.status = 0; }], ['production regime', f => { f.regime = 1; }],
    ['missing methods', f => { f.methods = 0; }], ['other issuer', f => { f.policyIssuer = f.control; }], ['not frozen', f => { f.frozen = false; }],
    ['passes production', f => { f.production = true; }], ['fails pilot', f => { f.pilot = false; }], ['control verified', f => { f.controlVerified = true; }],
    ['gate lets control through', f => { f.allowControl = true; }], ['gate blocks holders', f => { f.allowHolders = false; }],
    ['note bound elsewhere', f => { f.noteRegistry = f.control; }], ['note policy 1', f => { f.notePolicy = 1; }],
    ['pilot age drifted', f => { f.pilotAge = 86400; }], ['wrong chain', f => { f.chainId = 1n; }],
    ['v2 registry', f => { f.v2 = true; }], ['reorg', f => { f.reorg = true; }], ['future issuance', f => { f.issuedAt = f.now + 1; }],
  ];
  for (const [label, change] of scenarios) {
    const f = new LegacyFixture(); change(f);
    await assert.rejects(f.run(), Error, `${label} must be rejected`);
  }
});
