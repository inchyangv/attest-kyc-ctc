import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

const built = (name: string) => new ethers.Interface(JSON.parse(readFileSync(
  new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8',
)).abi);

function matches(actual: ethers.Interface, expected: ethers.Interface) {
  for (const fragment of expected.fragments) {
    const found = fragment.type === 'event'
      ? actual.getEvent((fragment as ethers.EventFragment).topicHash)
      : actual.getFunction((fragment as ethers.FunctionFragment).selector);
    assert.equal(found!.format('sighash'), fragment.format('sighash'));
  }
}

test('denial correction source and ASC transport ABIs match compiled contracts', () => {
  matches(built('ComplianceSource'), new ethers.Interface([
    'function DENIAL_CORRECTION_VERSION() view returns (uint256)',
    'function MIN_DENIAL_CORRECTION_DELAY() view returns (uint40)',
    'function setDenialCorrectionApprover(address,bool)',
    'function proposeDenialCorrection(address,bytes32,bytes32,bytes32,bytes32) returns (uint256)',
    'function approveDenialCorrection(uint256)',
    'function executeDenialCorrection(uint256)',
    'event SanctionDenialCorrected(address indexed,uint64 indexed,uint256 indexed,bytes32,address,address)',
  ]));
  matches(built('ProofmarkASC'), new ethers.Interface([
    'function DENIAL_CORRECTION_VERSION() view returns (uint256)',
    'function permanentDenial(address) view returns (bool)',
    'function lastCorrectedDenialRevision(address) view returns (uint64)',
    'function lastDenialCorrectionId(address) view returns (uint256)',
    'function lastDenialCorrectionReasonHash(address) view returns (bytes32)',
    'function lastDenialCorrectionProposer(address) view returns (address)',
    'function lastDenialCorrectionApprover(address) view returns (address)',
    'event DenialCorrectionAccepted(address indexed,uint64 indexed,uint256 indexed,bytes32,address,address)',
  ]));
});

test('asset recovery proposal, approval and execution ABIs match the compiled gate', () => {
  matches(built('GatedRwaNote'), new ethers.Interface([
    'function RECOVERY_GOVERNANCE_VERSION() view returns (uint256)',
    'function MIN_RECOVERY_DELAY() view returns (uint40)',
    'function configureRecoveryGovernance(address,address)',
    'function proposeRecovery(uint8,address,address,uint256,bytes32) returns (uint256)',
    'function approveRecovery(uint256)',
    'function executeRecovery(uint256)',
    'event RecoveryApproved(uint256 indexed,address indexed,bytes32 indexed)',
    'event RecoveryExecuted(uint256 indexed,uint8 indexed,address indexed,address,uint256,bytes32,address,address)',
  ]));
  assert.equal(built('GatedRwaNote').getFunction('forceTransfer'), null);
  assert.equal(built('GatedRwaNote').getFunction('forceBurn'), null);
});
