import { ethers } from 'ethers';

type Reference = { start: number; length: number };
type LinkReferences = Record<string, Record<string, Reference[]>>;
export type FoundryArtifact = {
  id: number;
  metadata: {
    compiler: { version: string };
    settings: {
      optimizer: { enabled: boolean; runs: number };
      evmVersion: string;
      viaIR?: boolean;
      compilationTarget: Record<string, string>;
    };
  };
  deployedBytecode: {
    object: string;
    linkReferences?: LinkReferences;
    immutableReferences?: Record<string, Reference[]>;
  };
};

export type ReleaseRuntimeSpec = {
  name: string;
  address: string;
  artifact: FoundryArtifact;
  target: string;
  exactCodeHash: string;
  libraries?: Record<string, string>;
};

const EXPECTED_COMPILER = '0.8.30+commit.73712a01';

function replaceAt(object: string, reference: Reference, replacement: string) {
  if (!Number.isSafeInteger(reference.start) || reference.start < 0 || reference.length < 1) {
    throw new Error('RELEASE_ARTIFACT_REFERENCE_INVALID');
  }
  const bytes = replacement.startsWith('0x') ? replacement.slice(2) : replacement;
  if (bytes.length !== reference.length * 2 || !/^[0-9a-fA-F]+$/.test(bytes)) {
    throw new Error('RELEASE_ARTIFACT_REPLACEMENT_INVALID');
  }
  const start = reference.start * 2;
  if (start + bytes.length > object.length) throw new Error('RELEASE_ARTIFACT_REFERENCE_INVALID');
  return object.slice(0, start) + bytes.toLowerCase() + object.slice(start + bytes.length);
}

function assertArtifact(artifact: FoundryArtifact, target: string) {
  const settings = artifact?.metadata?.settings;
  if (
    artifact?.metadata?.compiler?.version !== EXPECTED_COMPILER
    || settings?.optimizer?.enabled !== true
    || settings.optimizer.runs !== 200
    || settings.evmVersion !== 'shanghai'
    || (settings.viaIR ?? false) !== false
    || Object.entries(settings.compilationTarget ?? {}).length !== 1
    || settings.compilationTarget[target] === undefined
  ) throw new Error('RELEASE_COMPILER_SETTINGS_MISMATCH');
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 0 || typeof artifact.deployedBytecode?.object !== 'string') {
    throw new Error('RELEASE_ARTIFACT_INVALID');
  }
}

function linkedArtifactRuntime(spec: ReleaseRuntimeSpec) {
  assertArtifact(spec.artifact, spec.target);
  let object = spec.artifact.deployedBytecode.object.toLowerCase();
  if (object.startsWith('0x')) object = object.slice(2);
  // Solidity libraries start with a PUSH20 self-address guard. solc leaves this deployment
  // address zeroed in the artifact even though it is not reported as a link/immutable reference.
  if (object.startsWith(`73${'00'.repeat(20)}`)) {
    object = replaceAt(object, { start: 1, length: 20 }, spec.address);
  }
  const supplied = spec.libraries ?? {};
  const used = new Set<string>();
  for (const byName of Object.values(spec.artifact.deployedBytecode.linkReferences ?? {})) {
    for (const [name, references] of Object.entries(byName)) {
      const address = supplied[name];
      if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
        throw new Error('RELEASE_LIBRARY_ADDRESS_REQUIRED');
      }
      used.add(name);
      for (const reference of references) {
        if (reference.length !== 20) throw new Error('RELEASE_ARTIFACT_REFERENCE_INVALID');
        object = replaceAt(object, reference, address);
      }
    }
  }
  if (Object.keys(supplied).some(name => !used.has(name))) throw new Error('RELEASE_LIBRARY_ADDRESS_UNUSED');
  if (!/^[0-9a-f]*$/.test(object) || object.length === 0 || object.length % 2 !== 0) {
    throw new Error('RELEASE_ARTIFACT_INVALID');
  }
  return object;
}

function maskImmutables(object: string, artifact: FoundryArtifact) {
  let masked = object;
  for (const references of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const reference of references) masked = replaceAt(masked, reference, '00'.repeat(reference.length));
  }
  return masked;
}

export function verifyReleaseRuntimeCode(code: string, spec: ReleaseRuntimeSpec) {
  if (!ethers.isAddress(spec.address) || spec.address === ethers.ZeroAddress) {
    throw new Error('RELEASE_RUNTIME_ADDRESS_INVALID');
  }
  if (!ethers.isHexString(spec.exactCodeHash, 32) || spec.exactCodeHash === ethers.ZeroHash) {
    throw new Error('RELEASE_RUNTIME_PIN_REQUIRED');
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || ethers.keccak256(code).toLowerCase() !== spec.exactCodeHash.toLowerCase()) {
    throw new Error('RELEASE_RUNTIME_HASH_MISMATCH');
  }
  const artifact = linkedArtifactRuntime(spec);
  const runtime = code.slice(2).toLowerCase();
  if (maskImmutables(runtime, spec.artifact) !== maskImmutables(artifact, spec.artifact)) {
    throw new Error(`RELEASE_RUNTIME_BUILD_MISMATCH:${spec.name}`);
  }
  return {
    name: spec.name,
    address: ethers.getAddress(spec.address),
    codeHash: ethers.keccak256(code),
    byteLength: runtime.length / 2,
    artifactId: spec.artifact.id,
    compiler: EXPECTED_COMPILER,
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    viaIR: false,
    libraries: Object.fromEntries(Object.entries(spec.libraries ?? {}).map(([name, address]) => [name, ethers.getAddress(address)])),
    immutableIds: Object.keys(spec.artifact.deployedBytecode.immutableReferences ?? {}).sort(),
  };
}

export async function verifyReleaseRuntimes(
  provider: ethers.Provider,
  expectedChainId: bigint,
  blockNumber: number,
  specs: ReleaseRuntimeSpec[],
) {
  if ((await provider.getNetwork()).chainId !== expectedChainId) throw new Error('RELEASE_RUNTIME_CHAIN_MISMATCH');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1 || specs.length === 0) {
    throw new Error('RELEASE_RUNTIME_SCOPE_INVALID');
  }
  const block = await provider.getBlock(blockNumber);
  if (!block || block.number !== blockNumber || !ethers.isHexString(block.hash, 32)) {
    throw new Error('RELEASE_RUNTIME_BLOCK_UNAVAILABLE');
  }
  const observations = [];
  for (const spec of specs) {
    const code = await provider.getCode(spec.address, blockNumber);
    observations.push(verifyReleaseRuntimeCode(code, spec));
  }
  const stable = await provider.getBlock(blockNumber);
  if (!stable || stable.hash !== block.hash) throw new Error('RELEASE_RUNTIME_OBSERVATION_CHANGED');
  return { chainId: expectedChainId.toString(), blockNumber, blockHash: block.hash, contracts: observations };
}
