import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { verifyReleaseRuntimes, verifyReleaseRuntimeCode, type FoundryArtifact } from '../pipeline/release-runtime.js';

const artifact = (name: string) => JSON.parse(
  readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'),
) as FoundryArtifact & { abi: ethers.InterfaceAbi; bytecode: { object: string; linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>> } };
const key = (index: number) => ethers.HDNodeWallet.fromPhrase(
  'test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${index}`,
).privateKey;

test('two local EVM release scope matches exact pins, build settings and linked decoder', { timeout: 30000 }, async t => {
  async function chain(chainId: number) {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
      }
    });
    const provider = issuanceProvider(`http://127.0.0.1:${port}`);
    t.after(() => provider.destroy());
    for (let attempt = 0; ; ++attempt) {
      try { await provider.getBlockNumber(); break; }
      catch {
        if (attempt >= 30 || child.exitCode !== null) throw new Error('isolated Anvil unavailable');
        await delay(100);
      }
    }
    return provider;
  }

  function linkedCreation(name: string, libraries: Record<string, string> = {}) {
    const compiled = artifact(name);
    let object = compiled.bytecode.object;
    for (const byName of Object.values(compiled.bytecode.linkReferences ?? {})) {
      for (const [libraryName, references] of Object.entries(byName)) {
        const address = libraries[libraryName];
        assert.ok(address, `missing ${libraryName}`);
        for (const reference of references) {
          assert.equal(reference.length, 20);
          const start = 2 + reference.start * 2;
          object = object.slice(0, start) + address.slice(2) + object.slice(start + 40);
        }
      }
    }
    return object;
  }

  async function deploy(name: string, signer: ethers.Wallet, args: unknown[] = [], libraries: Record<string, string> = {}) {
    const compiled = artifact(name);
    const deployed = await new ethers.ContractFactory(compiled.abi, linkedCreation(name, libraries), signer).deploy(...args);
    await deployed.waitForDeployment();
    return deployed;
  }

  const sourceRpc = await chain(11155111), hubRpc = await chain(102031);
  const sourceOwner = new ethers.Wallet(key(0), sourceRpc), hubOwner = new ethers.Wallet(key(0), hubRpc);
  const source = await deploy('ComplianceSource', sourceOwner, [sourceOwner.address]);
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  const decoderAddress = await decoder.getAddress();
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], { EvmV1Decoder: decoderAddress });
  const registry = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  await (await new ethers.Contract(await registry.getAddress(), artifact('ProofmarkRegistry').abi, hubOwner).registerPolicy({
    requireAll: 0, minAssurance: 0, maxAge: 0, requiredRegime: 0, requiredJurisdiction: 0,
    trustedIssuer: ethers.ZeroAddress, requireRoster: true, exists: false,
  })).wait();
  await (await new ethers.Contract(await registry.getAddress(), artifact('ProofmarkRegistry').abi, hubOwner).freezePolicy(1)).wait();
  const note = await deploy('GatedRwaNote', hubOwner, ['Proofmark Runtime Fixture', 'PMRF', await registry.getAddress(), 1, hubOwner.address]);

  const sourceAddress = await source.getAddress(), ascAddress = await asc.getAddress(), registryAddress = await registry.getAddress();
  const noteAddress = await note.getAddress();
  const sourceBlock = await sourceRpc.getBlockNumber(), hubBlock = await hubRpc.getBlockNumber();
  const pin = async (provider: ethers.Provider, address: string) => ethers.keccak256(await provider.getCode(address));
  const sourceObservation = await verifyReleaseRuntimes(sourceRpc, 11155111n, sourceBlock, [{
    name: 'ComplianceSource', address: sourceAddress, artifact: artifact('ComplianceSource'), target: 'src/ComplianceSource.sol',
    exactCodeHash: await pin(sourceRpc, sourceAddress),
  }]);
  const hubObservation = await verifyReleaseRuntimes(hubRpc, 102031n, hubBlock, [
    { name: 'EvmV1Decoder', address: decoderAddress, artifact: artifact('EvmV1Decoder'),
      target: 'node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol', exactCodeHash: await pin(hubRpc, decoderAddress) },
    { name: 'ProofmarkASC', address: ascAddress, artifact: artifact('ProofmarkASC'), target: 'src/ProofmarkASC.sol',
      exactCodeHash: await pin(hubRpc, ascAddress), libraries: { EvmV1Decoder: decoderAddress } },
    { name: 'ProofmarkRegistry', address: registryAddress, artifact: artifact('ProofmarkRegistry'),
      target: 'src/ProofmarkRegistry.sol', exactCodeHash: await pin(hubRpc, registryAddress) },
    { name: 'GatedRwaNote', address: noteAddress, artifact: artifact('GatedRwaNote'),
      target: 'src/GatedRwaNote.sol', exactCodeHash: await pin(hubRpc, noteAddress) },
  ]);
  assert.equal(sourceObservation.contracts.length, 1);
  assert.deepEqual(hubObservation.contracts.map(item => item.name), [
    'EvmV1Decoder', 'ProofmarkASC', 'ProofmarkRegistry', 'GatedRwaNote',
  ]);
  assert.deepEqual(hubObservation.contracts[1].libraries, { EvmV1Decoder: ethers.getAddress(decoderAddress) });

  // T-14 negative boundary: an exact hash alone must not bless an ASC linked to a different
  // decoder address than the reviewed release scope.
  const otherDecoder = await deploy('EvmV1Decoder', hubOwner);
  const wrongAsc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], { EvmV1Decoder: await otherDecoder.getAddress() });
  const wrongAddress = await wrongAsc.getAddress(), wrongCode = await hubRpc.getCode(wrongAddress);
  assert.throws(() => verifyReleaseRuntimeCode(wrongCode, {
    name: 'ProofmarkASC', address: wrongAddress, artifact: artifact('ProofmarkASC'), target: 'src/ProofmarkASC.sol',
    exactCodeHash: ethers.keccak256(wrongCode), libraries: { EvmV1Decoder: decoderAddress },
  }), /RELEASE_RUNTIME_BUILD_MISMATCH/);

  await assert.rejects(verifyReleaseRuntimes(hubRpc, 1n, hubBlock, [{
    name: 'ProofmarkASC', address: ascAddress, artifact: artifact('ProofmarkASC'), target: 'src/ProofmarkASC.sol',
    exactCodeHash: await pin(hubRpc, ascAddress), libraries: { EvmV1Decoder: decoderAddress },
  }]), /RELEASE_RUNTIME_CHAIN_MISMATCH/);
});
