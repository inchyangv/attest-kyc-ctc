import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';

import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { Methods } from '../pipeline/methods.js';
import {
  Es256kJwtCredentialAdapter,
  InMemoryCredentialReplayStore,
  type ExternalCredentialAdapterConfig,
  type ExternalCredentialJwtClaims,
  type ExternalCredentialStatusClient,
} from '../pipeline/external-credential.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

test('signed external JWT crosses actual local Source/ASC and an independent consumer accepts and rejects exact policies', { timeout: 30_000 }, async t => {
  async function chain(chainId: number) {
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId),
      '--timestamp', '1800000000', '--silent'], { stdio: 'ignore' });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } });
    const provider = issuanceProvider(`http://127.0.0.1:${port}`); t.after(() => provider.destroy());
    for (let attempt = 0; ; attempt++) {
      try { await provider.getBlockNumber(); break; }
      catch { if (attempt >= 30 || child.exitCode !== null) throw new Error('isolated Anvil unavailable'); await delay(100); }
    }
    return provider;
  }
  const sourceRpc = await chain(11155111), hubRpc = await chain(102031);
  const mnemonic = 'test test test test test test test test test test test junk';
  const key = (n: number) => ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${n}`).privateKey;
  const sourceOwner = new ethers.Wallet(key(0), sourceRpc), externalIssuer = new ethers.Wallet(key(1), sourceRpc);
  const hubOwner = new ethers.Wallet(key(0), hubRpc);

  async function deploy(name: string, signer: ethers.Wallet, args: unknown[] = [], library?: string) {
    const compiled = artifact(name); let bytes: string = compiled.bytecode.object;
    for (const libraries of Object.values(compiled.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [libraryName, offsets] of Object.entries(libraries)) {
        assert.equal(libraryName, 'EvmV1Decoder'); assert.ok(library);
        for (const offset of offsets) {
          const start = 2 + offset.start * 2;
          bytes = bytes.slice(0, start) + library!.slice(2) + bytes.slice(start + offset.length * 2);
        }
      }
    }
    const contract = await new ethers.ContractFactory(compiled.abi, bytes, signer).deploy(...args);
    await contract.waitForDeployment(); return contract;
  }

  const source = await deploy('ComplianceSource', sourceOwner, [sourceOwner.address]);
  await (await source.setIssuer(externalIssuer.address, true)).wait();
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  await hubRpc.send('anvil_setCode', [PRECOMPILE, artifact('MockBlockProver').deployedBytecode.object]);
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const registry = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);

  const now = (await sourceRpc.getBlock('latest'))!.timestamp;
  const subject = new ethers.Wallet(key(2)).address;
  const methods = Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.SANCTIONS_SCREENED;
  const config: ExternalCredentialAdapterConfig = {
    id: 'synthetic-external-issuer', issuerId: `did:pkh:eip155:1:${externalIssuer.address}`,
    issuerAddress: externalIssuer.address, keyId: 'synthetic-key-1', audience: 'proofmark:source:sepolia',
    product: 'synthetic-individual-kyc', environment: 'production',
    publication: { model: 'provider', sourceIssuer: externalIssuer.address },
    assurance: { substantial: 3 }, regimes: { 'synthetic-live': 1 }, jurisdictions: { KR: 410 },
    methods: { 'wallet-control': Methods.WALLET_CONTROL, 'id-authenticity': Methods.ID_DOC_AUTHENTICITY,
      sanctions: Methods.SANCTIONS_SCREENED }, requiredChecks: ['wallet-control', 'id-authenticity', 'sanctions'],
    maxCredentialAgeSeconds: 7_200, credentialIdHmacKey: 'synthetic-local-external-id-key-at-least-32-characters',
  };
  const claims: ExternalCredentialJwtClaims = {
    iss: config.issuerId, aud: config.audience, sub: subject, jti: ethers.id('synthetic-external-jti'),
    iat: now - 60, exp: now + 3_600,
    proofmark: { schema: 'proofmark-external-jwt-v1', provider: config.id, product: config.product,
      environment: 'production', assurance: 'substantial', regime: 'synthetic-live', jurisdiction: 'KR',
      checks: ['wallet-control', 'id-authenticity', 'sanctions'], evidenceDigest: ethers.id('synthetic-external-evidence') },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'ES256K', typ: 'JWT', kid: config.keyId }), payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signed = externalIssuer.signingKey.sign(ethers.sha256(ethers.toUtf8Bytes(signingInput)));
  const token = `${signingInput}.${Buffer.concat([Buffer.from(ethers.getBytes(signed.r)), Buffer.from(ethers.getBytes(signed.s))]).toString('base64url')}`;
  class Status implements ExternalCredentialStatusClient {
    value: 'active' | 'revoked' = 'active';
    async status() { return this.value; }
  }
  const status = new Status();
  const adapter = new Es256kJwtCredentialAdapter(config, status, new InMemoryCredentialReplayStore(), () => now);
  const consumed = await adapter.consume(token, { wallet: subject });
  assert.equal(consumed.status, 'active'); if (consumed.status !== 'active') throw new Error('active synthetic credential expected');
  assert.equal(consumed.replay, 'fresh'); assert.equal(consumed.credential.methods, methods);
  const credential = consumed.credential;
  const issuance = await (await source.connect(externalIssuer).issueOnce(credential.requestId, credential.subject, credential.attrs,
    credential.claimsRoot, credential.evidenceHash)).wait();
  assert.equal(issuance.status, 1);
  assert.equal(await source.processedRequest(credential.requestId), true);
  const duplicate = await adapter.consume(token, { wallet: subject });
  assert.equal(duplicate.status, 'active'); if (duplicate.status !== 'active') throw new Error('active duplicate expected');
  assert.equal(duplicate.replay, 'duplicate');
  await assert.rejects(source.connect(externalIssuer).issueOnce.staticCall(credential.requestId, credential.subject, credential.attrs,
    credential.claimsRoot, credential.evidenceHash));

  function encoded(receipt: ethers.TransactionReceipt) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const body = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
      [receipt.status, receipt.gasUsed, receipt.logs.map(log => [log.address, [...log.topics], log.data]), '0x']);
    return coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', body]]);
  }
  async function relay(receipt: ethers.TransactionReceipt, action: number) {
    const sourceBlock = (await sourceRpc.getBlock(receipt.blockNumber))!;
    if ((await hubRpc.getBlock('latest'))!.timestamp <= sourceBlock.timestamp) await hubRpc.send('evm_setNextBlockTimestamp', [sourceBlock.timestamp + 1]);
    const txIndex = ethers.zeroPadValue(ethers.toBeHex(receipt.index), 32);
    const result = await (await asc.execute(action, 1, receipt.blockNumber, encoded(receipt), txIndex, [], ethers.ZeroHash, [])).wait();
    assert.equal(result.status, 1);
  }
  await relay(issuance, 0);

  const wrongIssuer = new ethers.Wallet(key(3)).address;
  const policies = [
    [methods, 3, 3_600, 1, 410, externalIssuer.address, false, false],
    [methods, 3, 3_600, 1, 410, wrongIssuer, false, false],
    [methods, 3, 3_600, 2, 410, externalIssuer.address, false, false],
    [methods, 3, 3_600, 1, 840, externalIssuer.address, false, false],
  ];
  for (const policy of policies) {
    const receipt = await (await registry.registerPolicy(policy)).wait();
    const event = receipt.logs.map((log: ethers.Log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
      .find((entry: ethers.LogDescription | null) => entry?.name === 'PolicyRegistered');
    await (await registry.freezePolicy(event!.args.policyId)).wait();
  }
  const consumerEnv = {
    PATH: process.env.PATH, CREDITCOIN_RPC_URL: hubRpc._getConnection().url,
    REGISTRY_CONTRACT_ADDRESS: await registry.getAddress(), ASC_CONTRACT_ADDRESS: await asc.getAddress(),
    SOURCE_CONTRACT_ADDRESS: await source.getAddress(), DEMO_REGISTRY_CODEHASH: ethers.keccak256(await hubRpc.getCode(await registry.getAddress())),
    DEMO_ASC_CODEHASH: ethers.keccak256(await hubRpc.getCode(await asc.getAddress())),
  };
  const consumePolicy = (policy: number) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'examples/consumer/check.ts', subject, String(policy)],
      { cwd: process.cwd(), env: consumerEnv, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const accepted = consumePolicy(1);
  assert.equal(accepted.verdict, 'accepted'); assert.equal(accepted.policy.trustedIssuer, externalIssuer.address);
  assert.equal(accepted.policy.requireRoster, false);
  for (const policy of [2, 3, 4]) assert.equal(consumePolicy(policy).verdict, 'rejected');

  status.value = 'revoked';
  const revoked = await adapter.consume(token, { wallet: subject });
  assert.equal(revoked.status, 'revoked');
  const revocation = await (await source.connect(externalIssuer).revoke(revoked.subject, 2, 1)).wait();
  await relay(revocation, 1);
  assert.equal(consumePolicy(1).verdict, 'rejected');
});
