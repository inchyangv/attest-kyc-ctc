// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

contract EpochBoundsTest is Test {
    ComplianceSource source;
    ProofmarkASC asc;
    ReceiptFixture fx;
    bytes32 constant ROOT = bytes32(uint256(1));
    bytes32 constant SNAPSHOT = bytes32(uint256(2));
    uint40 constant NOW = 1_800_000_000;

    function setUp() public {
        vm.warp(NOW);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        source = new ComplianceSource(address(this));
        source.setEpochPublisher(address(this), true);
        source.setIssuer(address(this), true);
        asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(source));
        fx = new ReceiptFixture();
    }

    function _log(uint32 epoch, uint40 cutoff, uint40 publishedAt, uint40 validUntil)
        private
        view
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40,uint40,uint40,bytes32)");
        topics[1] = bytes32(uint256(epoch));
        topics[2] = ROOT;
        topics[3] = bytes32(uint256(7));
        return fx.log(address(source), topics, abi.encode(validUntil, cutoff, publishedAt, SNAPSHOT));
    }

    function _execute(EvmV1Decoder.LogEntryTuple memory eventLog, uint64 height) private {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = eventLog;
        bytes32[] memory approval = new bytes32[](4);
        approval[0] = keccak256("RosterIssuerAuthorized(uint32,bytes32,address)");
        approval[1] = eventLog.topics[1];
        approval[2] = eventLog.topics[2];
        approval[3] = bytes32(uint256(uint160(address(this))));
        logs[1] = fx.log(address(source), approval, bytes(""));
        asc.execute(
            3,
            1,
            height,
            fx.tx2(logs),
            bytes32(uint256(height)),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function test_SourceRejectsInvalidEpochBeforeAdvancingSequence() public {
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, bytes32(0), 7, NOW + 1 days, NOW, SNAPSHOT);
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1 days, NOW, bytes32(0));
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1 days, 0, SNAPSHOT);
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1 days, NOW + 1, SNAPSHOT);
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1, NOW - 1 hours - 1, SNAPSHOT);
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW, NOW, SNAPSHOT);
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1 days + 1, NOW, SNAPSHOT);
        // A full day from publication is too long when the source cutoff is already one hour old.
        vm.expectRevert(ComplianceSource.InvalidEpoch.selector);
        source.publishEpoch(1, ROOT, 7, NOW + 1 days, NOW - 1 hours, SNAPSHOT);
        assertEq(source.lastEpoch(), 0);
        source.publishEpoch(1, ROOT, 7, NOW + 23 hours, NOW - 1 hours, SNAPSHOT);
        assertEq(source.lastEpoch(), 1);
        assertEq(source.EPOCH_SCHEMA_VERSION(), 2);
        assertEq(source.MAX_EPOCH_AGE(), 1 days);
    }

    function test_HubDelayCannotRestartCutoffLifetimeAndFutureClockFailsClosed() public {
        vm.warp(NOW + 12 hours);
        _execute(_log(1, NOW - 1 hours, NOW, NOW + 23 hours), 1);
        assertTrue(asc.isRosterFresh());
        assertEq(asc.epochSourceCutoff(), NOW - 1 hours);
        assertEq(asc.epochPublishedAt(), NOW);
        assertEq(asc.epochValidUntil(), NOW + 23 hours);
        assertEq(asc.epochSnapshotId(), SNAPSHOT);
        assertEq(asc.epochListVersion(), 7);
        vm.warp(NOW - 1);
        assertFalse(asc.isRosterFresh());
        vm.warp(NOW + 23 hours - 1);
        assertTrue(asc.isRosterFresh());
        vm.warp(NOW + 23 hours);
        assertFalse(asc.isRosterFresh());
    }

    function test_ExpiredNewerEpochSupersedesOldWithoutRenewalAndOldDeliveryCannotRestoreIt() public {
        _execute(_log(1, NOW, NOW, NOW + 1 days), 1);
        vm.warp(NOW + 120);
        // A valid source event can legitimately arrive after its short expiry.
        _execute(_log(2, NOW, NOW, NOW + 60), 2);
        assertEq(asc.latestEpoch(), 2);
        assertFalse(asc.isRosterFresh());
        _execute(_log(1, NOW, NOW, NOW + 1 days), 3);
        assertEq(asc.latestEpoch(), 2);
        assertFalse(asc.isRosterFresh());
    }

    function test_HubRejectsInvalidProvenanceRatherThanTruncatingAbiWords() public {
        _reject(_log(1, NOW, NOW + 1, NOW + 1 days), 1, ProofmarkASC.InvalidEpoch.selector);
        _reject(_log(1, NOW, NOW, NOW + 1 days + 1), 2, ProofmarkASC.InvalidEpoch.selector);
        _reject(_log(1, NOW - 1 hours - 1, NOW, NOW + 1), 3, ProofmarkASC.InvalidEpoch.selector);
        EvmV1Decoder.LogEntryTuple memory bad = _log(1, NOW, NOW, NOW + 1 days);
        bad.topics[1] = bytes32(uint256(1) << 32);
        _reject(bad, 4, ProofmarkASC.InvalidEpoch.selector);
        bad = _log(1, NOW, NOW, NOW + 1 days);
        bad.data = abi.encode(uint256(1) << 40, NOW, NOW, SNAPSHOT);
        _reject(bad, 5, bytes4(0));
        bad = _log(1, NOW, NOW, NOW + 1 days);
        bad.data = abi.encode(NOW + 1 days, NOW, NOW, SNAPSHOT, uint256(0));
        _reject(bad, 6, ProofmarkASC.InvalidEpoch.selector);
        assertEq(asc.latestEpoch(), 0);
    }

    function test_LegacyEpochSignatureCannotBeAcceptedAsCurrentSchema() public {
        EvmV1Decoder.LogEntryTuple memory old = _log(1, NOW, NOW, NOW + 1 days);
        old.topics[0] = keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40)");
        old.data = abi.encode(NOW + 1 days);
        _reject(old, 1, ProofmarkASC.NoMatchingEvent.selector);
        assertEq(asc.latestEpoch(), 0);
    }

    function executeLog(EvmV1Decoder.LogEntryTuple memory eventLog, uint64 height) external {
        _execute(eventLog, height);
    }

    function _reject(EvmV1Decoder.LogEntryTuple memory eventLog, uint64 height, bytes4 selector) private {
        if (selector == bytes4(0)) vm.expectRevert();
        else vm.expectRevert(selector);
        this.executeLog(eventLog, height);
    }
}
