import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ISSUER_KEY_ABI } from '../pipeline/issuer-key.js';

test('stable issuer SDK selectors and return layouts match the compiled contract', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/RotatingIssuer.sol/RotatingIssuer.json', import.meta.url), 'utf8')).abi);
  for (const f of new ethers.Interface(ISSUER_KEY_ABI).fragments) {
    assert.equal(built.getFunction((f as ethers.FunctionFragment).name)!.format('full'), f.format('full'));
  }
});

test('issuer generation and compromise provenance ABI matches source and ASC boundaries', () => {
  const source = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8')).abi);
  const asc = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ProofmarkASC.sol/ProofmarkASC.json', import.meta.url), 'utf8')).abi);
  const expectedSource = new ethers.Interface([
    'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
    'function issueOnceWithKey(bytes32,address,bytes32,bytes32,bytes32,uint64)',
    'function declareIssuerKeyCompromise(uint64,uint64,bytes32)',
    'event KeyedMarkIssued(address indexed,bytes32 indexed,address indexed,uint64,bytes32,bytes32)',
    'event RosterIssuerKeyAuthorized(uint32 indexed,bytes32 indexed,address indexed,uint64)',
    'event IssuerKeyCompromised(address indexed,uint64 indexed,uint64,bytes32)',
  ]);
  const expectedAsc = new ethers.Interface([
    'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
    'function markIssuerKeyEpoch(address) view returns (uint64)',
    'function isMarkIssuerUsable(address) view returns (bool)',
    'function epochIssuerKeyEpoch(uint32,address) view returns (uint64)',
    'function epochIssuerApprovalHeight(uint32,address) view returns (uint64)',
    'function issuerKeyLastTrustedBlock(address,uint64) view returns (uint64)',
    'function isEpochIssuerUsable(uint32,address) view returns (bool)',
  ]);
  for (const fragment of expectedSource.fragments) {
    const actual = fragment.type === 'event' ? source.getEvent((fragment as ethers.EventFragment).topicHash)
      : source.getFunction((fragment as ethers.FunctionFragment).selector);
    assert.equal(actual!.format('sighash'), fragment.format('sighash'));
  }
  for (const fragment of expectedAsc.fragments) {
    assert.equal(asc.getFunction((fragment as ethers.FunctionFragment).selector)!.format('sighash'), fragment.format('sighash'));
  }
});
