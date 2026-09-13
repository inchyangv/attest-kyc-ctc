// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ComplianceSource} from "../src/ComplianceSource.sol";
import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry} from "../src/ProofmarkRegistry.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, MarkStatus, Methods, Policy} from "../src/lib/ProofmarkTypes.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

/// @notice T-13 local governance and cross-chain state-transition regression.
/// @dev Synthetic actors and the mock native verifier are used. Role assignment is not evidence
///      that a real human, legal authority or asset operator approved a correction.
contract DenialCorrectionTest is Test {
    uint64 private constant SEPOLIA_KEY = 1;
    address private constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    address private owner = address(0xA11CE);
    address private issuer = address(0x1554E4);
    address private approver = address(0xA9900);
    address private alice = address(0xA11);

    ComplianceSource private source;
    ProofmarkASC private asc;
    ProofmarkRegistry private registry;
    ReceiptFixture private fixture;
    uint256 private policyId;

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        source = new ComplianceSource(owner);
        vm.startPrank(owner);
        source.setIssuer(issuer, true);
        source.setDenialCorrectionApprover(approver, true);
        asc = new ProofmarkASC(owner);
        asc.configureSource(SEPOLIA_KEY, address(source));
        vm.stopPrank();
        registry = new ProofmarkRegistry(address(asc));
        policyId = registry.registerPolicy(
            Policy({
                requireAll: Methods.SANCTIONS_SCREENED,
                minAssurance: 2,
                maxAge: 0,
                requiredRegime: 1,
                requiredJurisdiction: 410,
                trustedIssuer: issuer,
                requireRoster: false,
                exists: false
            })
        );
        fixture = new ReceiptFixture();
    }

    function _attrs() private view returns (bytes32) {
        return MarkAttrs.pack(
            1, 3, 1, 410, Methods.SANCTIONS_SCREENED, uint40(block.timestamp), uint40(block.timestamp + 30 days), 1
        );
    }

    function _receipt(Vm.Log[] memory recorded) private view returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](recorded.length);
        for (uint256 i; i < recorded.length; ++i) {
            logs[i] = fixture.log(recorded[i].emitter, recorded[i].topics, recorded[i].data);
        }
        return fixture.tx2(logs);
    }

    function _relay(ProofmarkASC target, uint8 action, uint64 height, bytes memory receipt, uint256 salt) private {
        target.execute(
            action,
            SEPOLIA_KEY,
            height,
            receipt,
            bytes32(salt),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function _issueReceipt() private returns (bytes memory) {
        vm.recordLogs();
        vm.prank(issuer);
        source.issue(alice, _attrs(), keccak256("initial claims"), keccak256("initial evidence"));
        return _receipt(vm.getRecordedLogs());
    }

    function _denyReceipt() private returns (bytes memory) {
        vm.recordLogs();
        vm.prank(issuer);
        source.deny(alice, 7, 1);
        return _receipt(vm.getRecordedLogs());
    }

    function _propose() private returns (uint256) {
        vm.prank(issuer);
        return source.proposeDenialCorrection(
            alice,
            _attrs(),
            keccak256("replacement claims"),
            keccak256("replacement evidence"),
            keccak256("synthetic reviewed false-positive case")
        );
    }

    function _approvedCorrectionReceipt(uint256 correctionId) private returns (bytes memory) {
        vm.prank(approver);
        source.approveDenialCorrection(correctionId);
        vm.warp(block.timestamp + source.MIN_DENIAL_CORRECTION_DELAY());
        vm.recordLogs();
        vm.prank(address(0xE0E));
        source.executeDenialCorrection(correctionId);
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        assertEq(recorded.length, 2, "correction and exact replacement must share one receipt");
        return _receipt(recorded);
    }

    function test_DenialReviewApprovalCorrectionAndReplacementCredentialAreConnected() public {
        _relay(asc, uint8(Action.MarkIssued), 100, _issueReceipt(), 1);
        bytes memory denial = _denyReceipt();
        _relay(asc, uint8(Action.SanctionDenied), 200, denial, 2);
        assertTrue(asc.permanentDenial(alice));
        assertFalse(registry.isVerified(alice, policyId));

        uint256 correctionId = _propose();
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.DenialCorrectionNotApproved.selector, correctionId));
        source.executeDenialCorrection(correctionId);
        vm.prank(approver);
        source.approveDenialCorrection(correctionId);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceSource.DenialCorrectionDelayActive.selector,
                correctionId,
                uint40(block.timestamp + source.MIN_DENIAL_CORRECTION_DELAY())
            )
        );
        source.executeDenialCorrection(correctionId);
        vm.warp(block.timestamp + source.MIN_DENIAL_CORRECTION_DELAY());
        vm.recordLogs();
        source.executeDenialCorrection(correctionId);
        bytes memory corrected = _receipt(vm.getRecordedLogs());

        _relay(asc, uint8(Action.SanctionDenialCorrection), 300, corrected, 3);
        assertFalse(asc.permanentDenial(alice));
        assertFalse(asc.tombstone(alice));
        assertEq(asc.getMark(alice).status, uint8(MarkStatus.Active));
        assertTrue(registry.isVerified(alice, policyId));
        assertEq(asc.lastCorrectedDenialRevision(alice), 1);
        assertEq(asc.lastDenialCorrectionId(alice), correctionId);
        assertEq(asc.lastDenialCorrectionReasonHash(alice), keccak256("synthetic reviewed false-positive case"));
        assertEq(asc.lastDenialCorrectionProposer(alice), issuer);
        assertEq(asc.lastDenialCorrectionApprover(alice), approver);

        // Delivering the older denial after the governed correction cannot re-block the subject.
        ProofmarkASC reverse = new ProofmarkASC(owner);
        vm.prank(owner);
        reverse.configureSource(SEPOLIA_KEY, address(source));
        _relay(reverse, uint8(Action.SanctionDenialCorrection), 300, corrected, 4);
        _relay(reverse, uint8(Action.SanctionDenied), 200, denial, 5);
        assertFalse(reverse.permanentDenial(alice));
        assertEq(reverse.getMark(alice).status, uint8(MarkStatus.Active));

        // A later post-correction issuance may be relayed before the correction receipt. It stays
        // denied until the correction arrives, then wins by source order without proof replay.
        vm.recordLogs();
        vm.prank(issuer);
        source.issue(alice, _attrs(), keccak256("latest claims"), keccak256("latest evidence"));
        bytes memory latest = _receipt(vm.getRecordedLogs());
        ProofmarkASC concurrent = new ProofmarkASC(owner);
        vm.prank(owner);
        concurrent.configureSource(SEPOLIA_KEY, address(source));
        _relay(concurrent, uint8(Action.SanctionDenied), 200, denial, 6);
        _relay(concurrent, uint8(Action.MarkIssued), 400, latest, 7);
        assertTrue(concurrent.permanentDenial(alice));
        assertEq(concurrent.getMark(alice).status, uint8(MarkStatus.Denied));
        _relay(concurrent, uint8(Action.SanctionDenialCorrection), 300, corrected, 8);
        assertFalse(concurrent.permanentDenial(alice));
        assertEq(concurrent.getMark(alice).status, uint8(MarkStatus.Active));
        assertEq(concurrent.getMark(alice).claimsRoot, keccak256("latest claims"));
    }

    function test_CorrectionRequiresIndependentApproverAndCurrentDenialRevision() public {
        _denyReceipt();
        uint256 first = _propose();
        vm.prank(owner);
        source.setDenialCorrectionApprover(issuer, true);
        vm.prank(issuer);
        vm.expectRevert(ComplianceSource.InvalidDenialCorrection.selector);
        source.approveDenialCorrection(first);

        // A new denial supersedes the case snapshot; the stale approval cannot clear it.
        _denyReceipt();
        vm.prank(approver);
        vm.expectRevert(ComplianceSource.InvalidDenialCorrection.selector);
        source.approveDenialCorrection(first);
        assertTrue(source.sourceDenialActive(alice));
        assertEq(source.sourceDenialRevision(alice), 2);
    }

    function test_CorrectionWithoutReplacementIssuanceRemainsSuspended() public {
        bytes memory denial = _denyReceipt();
        _relay(asc, uint8(Action.SanctionDenied), 200, denial, 10);
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("SanctionDenialCorrected(address,uint64,uint256,bytes32,address,address)");
        topics[1] = bytes32(uint256(uint160(alice)));
        topics[2] = bytes32(uint256(1));
        topics[3] = bytes32(uint256(9));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fixture.log(address(source), topics, abi.encode(keccak256("case"), issuer, approver));
        _relay(asc, uint8(Action.SanctionDenialCorrection), 300, fixture.tx2(logs), 11);
        assertFalse(asc.permanentDenial(alice));
        assertTrue(asc.tombstone(alice));
        assertEq(asc.getMark(alice).status, uint8(MarkStatus.Suspended));
        assertFalse(registry.isVerified(alice, policyId));
    }
}
