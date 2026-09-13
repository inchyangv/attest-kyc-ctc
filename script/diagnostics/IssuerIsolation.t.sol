// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {ComplianceSource} from "../../src/ComplianceSource.sol";
import {ProofmarkASC} from "../../src/ProofmarkASC.sol";
import {ProofmarkRegistry} from "../../src/ProofmarkRegistry.sol";
import {Policy} from "../../src/lib/ProofmarkTypes.sol";
import {MarkAttrs} from "../../src/lib/MarkAttrs.sol";
import {INativeQueryVerifier} from "../../src/lib/VerifierInterface.sol";
import {ReceiptFixture} from "../../test/ReceiptFixture.sol";
import {MockBlockProver} from "../../test/mocks/MockBlockProver.sol";

/// T-06 acceptance probes, deliberately RED on the current global-subject design.
/// Outside the default test directory: run explicitly, never count as passing safety evidence.
contract IssuerIsolationDiagnostic is Test {
    ComplianceSource private source;
    ProofmarkASC private asc;
    ProofmarkRegistry private registry;
    ReceiptFixture private fixture;
    address private constant A = address(0xA1);
    address private constant B = address(0xB1);
    address private constant SUBJECT = address(0x5151);
    uint256 private policyA;
    uint256 private policyB;

    function setUp() public {
        vm.warp(1_700_000_100);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        source = new ComplianceSource(address(this));
        source.setIssuer(A, true);
        source.setIssuer(B, true);
        asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(source));
        registry = new ProofmarkRegistry(address(asc));
        fixture = new ReceiptFixture();
        vm.prank(address(0xDA));
        policyA = registry.registerPolicy(_policy(A));
        vm.prank(address(0xDB));
        policyB = registry.registerPolicy(_policy(B));
        _issue(A, 100);
        assertTrue(registry.isVerified(SUBJECT, policyA), "baseline A missing");
        assertFalse(registry.isVerified(SUBJECT, policyB), "A must not impersonate B");
    }

    function _policy(address issuer) private pure returns (Policy memory) {
        return Policy({
            requireAll: 1,
            minAssurance: 3,
            maxAge: 0,
            requiredRegime: 2,
            requiredJurisdiction: 410,
            trustedIssuer: issuer,
            requireRoster: false,
            exists: false
        });
    }

    function _issue(address issuer, uint64 height) private {
        bytes32 attrs = MarkAttrs.pack(1, 3, 2, 410, 1, 1_700_000_000, 1_800_000_000, 1);
        vm.recordLogs();
        vm.prank(issuer);
        source.issue(SUBJECT, attrs, bytes32(uint256(uint160(issuer))), bytes32(uint256(height)));
        _relay(vm.getRecordedLogs(), 0, height);
    }

    function _relay(Vm.Log[] memory recorded, uint8 action, uint64 height) private {
        assertEq(recorded.length, 1, "expected actual source lifecycle event");
        assertEq(recorded[0].emitter, address(source));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fixture.log(recorded[0].emitter, recorded[0].topics, recorded[0].data);
        asc.execute(
            action,
            1,
            height,
            fixture.tx2(logs),
            bytes32(uint256(1)),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function test_IndependentIssuanceMustPreserveA() public {
        _issue(B, 101);
        assertTrue(registry.isVerified(SUBJECT, policyB), "B own credential must work");
        assertTrue(registry.isVerified(SUBJECT, policyA), "T06: B issuance displaced A");
    }

    function test_BWithoutCredentialMustNotRevokeA() public {
        vm.recordLogs();
        vm.prank(B);
        source.revoke(SUBJECT, 2, 1);
        _relay(vm.getRecordedLogs(), 1, 101);
        assertFalse(registry.isVerified(SUBJECT, policyB));
        assertTrue(registry.isVerified(SUBJECT, policyA), "T06: B revocation disabled A");
    }

    function test_BWithoutGlobalAuthorityMustNotDenyA() public {
        vm.recordLogs();
        vm.prank(B);
        source.deny(SUBJECT, 7, 1);
        _relay(vm.getRecordedLogs(), 2, 101);
        assertFalse(registry.isVerified(SUBJECT, policyB));
        assertTrue(registry.isVerified(SUBJECT, policyA), "T06: B denial disabled A");
    }
}
