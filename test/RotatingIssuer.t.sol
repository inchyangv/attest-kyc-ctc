// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {RotatingIssuer} from "../src/RotatingIssuer.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry, RosterMark} from "../src/ProofmarkRegistry.sol";
import {GatedRwaNote} from "../src/GatedRwaNote.sol";
import {Action, Policy} from "../src/lib/ProofmarkTypes.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";
import {RosterWitnessFixture} from "./RosterWitnessFixture.sol";

contract RotatingIssuerTest is Test {
    uint256 constant OLD_KEY = 123;
    uint256 constant NEW_KEY = 456;
    uint40 constant NOW = 1_800_000_000;
    address oldKey;
    address newKey;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    ComplianceSource source;
    RotatingIssuer issuer;
    ProofmarkASC asc;
    ProofmarkRegistry registry;
    GatedRwaNote note;
    ReceiptFixture fx;
    uint256 policy;
    uint64 height;
    address[] subjects;
    RosterMark[] marks;
    bytes32 root;

    function setUp() public {
        vm.warp(NOW);
        oldKey = vm.addr(OLD_KEY);
        newKey = vm.addr(NEW_KEY);
        source = new ComplianceSource(address(this));
        issuer = new RotatingIssuer(address(this), oldKey, address(source));
        source.setIssuer(address(issuer), true);
        source.setEpochPublisher(address(this), true);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(source));
        registry = new ProofmarkRegistry(address(asc));
        fx = new ReceiptFixture();
        policy = registry.registerPolicy(Policy(1 << 16, 2, 0, 1, 410, address(issuer), true, false));
        registry.freezePolicy(policy);
        note = new GatedRwaNote("Local rotation", "ROT", address(registry), policy, address(this));
        subjects.push(alice);
        subjects.push(bob);
        for (uint256 i; i < subjects.length; ++i) {
            marks.push(
                RosterMark(
                    MarkAttrs.pack(1, 3, 1, 410, 1 << 16, NOW, NOW + 7 days, 0),
                    bytes32(i + 1),
                    bytes32(i + 3),
                    address(issuer)
                )
            );
        }
        (root,) = RosterWitnessFixture.build(subjects, marks);
    }

    function _signature(bytes32 digest, uint256 key, uint64 epoch) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, issuer.approvalDigest(digest, epoch));
        return abi.encodePacked(epoch, r, s, v);
    }

    function _sourceDigest(uint32 epoch) private view returns (bytes32) {
        return source.rosterApprovalDigest(epoch, root, 9, NOW + 1 days, NOW, bytes32(uint256(7)), address(this));
    }

    function _publish(uint32 epoch, bytes memory signature) private {
        ComplianceSource.RootApproval[] memory approvals = new ComplianceSource.RootApproval[](1);
        approvals[0] = ComplianceSource.RootApproval(address(issuer), signature);
        source.publishEpochForIssuers(epoch, root, 9, NOW + 1 days, NOW, bytes32(uint256(7)), approvals);
    }

    function _relay(Vm.Log[] memory recorded, uint8 action) private {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](recorded.length);
        for (uint256 i; i < recorded.length; ++i) {
            logs[i] = fx.log(recorded[i].emitter, recorded[i].topics, recorded[i].data);
        }
        asc.execute(
            action,
            1,
            ++height,
            fx.tx2(logs),
            bytes32(uint256(height)),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function _publishAndCache(uint32 epoch, uint256 key) private {
        (, RosterProof.Inclusion[] memory proofs) = RosterWitnessFixture.build(subjects, marks);
        bytes memory sig = _signature(_sourceDigest(epoch), key, issuer.keyEpoch());
        vm.recordLogs();
        _publish(epoch, sig);
        _relay(vm.getRecordedLogs(), 3);
        for (uint256 i; i < subjects.length; ++i) {
            registry.cacheRosterWitness(subjects[i], marks[i], proofs[i]);
        }
    }

    function _issue(address key, uint64 epoch, bytes32 requestId, address subject) private {
        vm.prank(key);
        issuer.issueOnce(epoch, requestId, subject, marks[0].attrs, marks[0].claimsRoot, marks[0].evidenceHash);
    }

    function _rotate() private {
        issuer.proposeKey(newKey);
        uint64 epoch = issuer.keyEpoch();
        vm.prank(newKey);
        issuer.acceptKey(epoch);
    }

    function test_PlannedRotationKeepsFrozenIssuerAndHolderBalancesWithoutRelaxingPolicy() public {
        vm.recordLogs();
        _issue(oldKey, 1, bytes32(uint256(1)), alice);
        _relay(vm.getRecordedLogs(), 0);
        assertEq(asc.getMark(alice).issuer, address(issuer));
        _publishAndCache(1, OLD_KEY);
        note.mint(alice, 100);
        bytes memory retiredApproval = _signature(_sourceDigest(2), OLD_KEY, 1);
        _rotate();
        assertEq(issuer.keyEpoch(), 2);
        vm.expectRevert(RotatingIssuer.InactiveKey.selector);
        _issue(oldKey, 1, bytes32(uint256(2)), bob);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(2, retiredApproval);
        vm.recordLogs();
        _issue(newKey, 2, bytes32(uint256(3)), bob);
        _relay(vm.getRecordedLogs(), 0);
        assertEq(asc.getMark(bob).issuer, address(issuer));
        _publishAndCache(2, NEW_KEY);
        assertTrue(registry.policyFrozen(policy));
        (,,,,, address trusted,,) = registry.policies(policy);
        assertEq(trusted, address(issuer));
        vm.prank(alice);
        note.transfer(bob, 40);
        vm.prank(bob);
        note.burn(10);
        assertEq(note.balanceOf(alice), 60);
        assertEq(note.balanceOf(bob), 30);
        assertEq(note.totalSupply(), 90);
    }

    function test_CompromiseCutoffInvalidatesOnlyPostCutoffHistoricalHubEvidence() public {
        uint256 directPolicy = registry.registerPolicy(Policy(1 << 16, 2, 0, 1, 410, address(issuer), false, false));
        registry.freezePolicy(directPolicy);
        height = 99;
        vm.roll(100);
        vm.recordLogs();
        _issue(oldKey, 1, bytes32(uint256(10)), alice);
        _relay(vm.getRecordedLogs(), uint8(Action.MarkIssued));
        height = 199;
        vm.roll(200);
        vm.recordLogs();
        _issue(oldKey, 1, bytes32(uint256(20)), bob);
        _relay(vm.getRecordedLogs(), uint8(Action.MarkIssued));
        vm.roll(201);
        _publishAndCache(1, OLD_KEY);
        assertTrue(registry.isVerified(alice, directPolicy));
        assertTrue(registry.isVerified(bob, directPolicy));
        assertTrue(registry.isVerified(alice, policy));
        note.mint(alice, 100);
        issuer.proposeKey(newKey);
        bytes memory oldApproval = _signature(_sourceDigest(2), OLD_KEY, 1);
        vm.roll(202);
        vm.recordLogs();
        issuer.declareCompromise(keccak256("synthetic incident"), 150);
        _relay(vm.getRecordedLogs(), uint8(Action.IssuerKeyCompromise));
        assertEq(issuer.pendingKey(), address(0));
        assertEq(issuer.keyEpoch(), 2);
        assertEq(issuer.isValidSignature(_sourceDigest(2), oldApproval), bytes4(0xffffffff));
        vm.expectRevert(RotatingIssuer.InactiveKey.selector);
        _issue(oldKey, 2, bytes32(uint256(1)), alice);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        vm.prank(newKey);
        issuer.acceptKey(2);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        issuer.proposeKey(oldKey);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        issuer.transferOwnership(oldKey);
        assertEq(asc.epochIssuerKeyEpoch(1, address(issuer)), 1);
        assertEq(asc.epochIssuerApprovalHeight(1, address(issuer)), 201);
        assertEq(asc.issuerKeyLastTrustedBlock(address(issuer), 1), 150);
        assertTrue(registry.isVerified(alice, directPolicy), "pre-cutoff mark must retain the approved treatment");
        assertFalse(registry.isVerified(bob, directPolicy), "post-cutoff direct mark must fail closed");
        assertFalse(registry.isVerified(alice, policy), "compromised historical issuer generation must fail closed");
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.SenderNotVerified.selector, alice, policy));
        vm.prank(alice);
        note.burn(10);
        issuer.proposeKey(newKey);
        vm.prank(newKey);
        issuer.acceptKey(2);
        assertEq(issuer.keyEpoch(), 3);
        assertFalse(issuer.suspended());
        assertFalse(registry.isVerified(alice, policy), "key recovery alone cannot forgive compromised evidence");
        vm.roll(203);
        vm.recordLogs();
        _issue(newKey, 3, bytes32(uint256(30)), alice);
        _relay(vm.getRecordedLogs(), uint8(Action.MarkIssued));
        subjects.pop();
        marks.pop();
        (root,) = RosterWitnessFixture.build(subjects, marks);
        _publishAndCache(2, NEW_KEY);
        assertTrue(registry.policyFrozen(policy));
        vm.prank(alice);
        note.burn(10);
        assertEq(note.balanceOf(alice), 90, "reviewed holder can exit after reissue without policy relaxation");
    }

    function test_KeyAcceptanceAndForwardingBindEpochAndSourceIdempotencySurvivesRotation() public {
        bytes32 requestId = bytes32(uint256(123));
        _issue(oldKey, 1, requestId, alice);
        issuer.proposeKey(newKey);
        vm.expectRevert(RotatingIssuer.WrongKeyEpoch.selector);
        vm.prank(newKey);
        issuer.acceptKey(2);
        vm.prank(newKey);
        issuer.acceptKey(1);
        vm.expectRevert(RotatingIssuer.WrongKeyEpoch.selector);
        _issue(newKey, 1, bytes32(uint256(2)), bob);
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.RequestAlreadyProcessed.selector, requestId));
        _issue(newKey, 2, requestId, alice);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        issuer.proposeKey(oldKey);
    }

    function test_SignaturesRejectMalformedWrongEpochSignerDigestChainAndIssuerContract() public {
        bytes32 digest = _sourceDigest(1);
        bytes memory valid = _signature(digest, OLD_KEY, 1);
        assertEq(issuer.isValidSignature(digest, valid), IERC1271.isValidSignature.selector);
        assertEq(issuer.isValidSignature(digest, hex"01"), bytes4(0xffffffff));
        assertEq(issuer.isValidSignature(digest, new bytes(73)), bytes4(0xffffffff));
        assertEq(issuer.isValidSignature(digest, _signature(digest, OLD_KEY, 2)), bytes4(0xffffffff));
        assertEq(issuer.isValidSignature(digest, _signature(digest, NEW_KEY, 1)), bytes4(0xffffffff));
        assertEq(issuer.isValidSignature(bytes32(uint256(66)), valid), bytes4(0xffffffff));
        RotatingIssuer other = new RotatingIssuer(address(this), oldKey, address(source));
        source.setIssuer(address(other), true);
        assertEq(other.isValidSignature(digest, valid), bytes4(0xffffffff));
        vm.chainId(block.chainid + 1);
        assertEq(issuer.isValidSignature(digest, valid), bytes4(0xffffffff));
    }

    function test_SourceRoleRemovalAloneIsNotKeyRetirement() public {
        bytes32 digest = _sourceDigest(1);
        bytes memory valid = _signature(digest, OLD_KEY, 1);
        source.setIssuer(address(issuer), false);
        assertEq(issuer.isValidSignature(digest, valid), bytes4(0xffffffff));
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.NotIssuer.selector, address(issuer)));
        _issue(oldKey, 1, bytes32(uint256(1)), alice);
        source.setIssuer(address(issuer), true);
        assertEq(
            issuer.isValidSignature(digest, valid),
            IERC1271.isValidSignature.selector,
            "must suspend/rotate to retire signatures"
        );
        issuer.suspend(bytes32(uint256(1)));
        source.setIssuer(address(issuer), false);
        source.setIssuer(address(issuer), true);
        assertEq(issuer.isValidSignature(digest, valid), bytes4(0xffffffff));
    }

    function test_RecoveryOwnerIsSeparateAndCannotRenounceOrSilentlyActivateAKey() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, oldKey));
        vm.prank(oldKey);
        issuer.suspend(bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, oldKey));
        vm.prank(oldKey);
        issuer.proposeKey(newKey);
        issuer.proposeKey(newKey);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        issuer.acceptKey(1);
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        issuer.transferOwnership(newKey);
        vm.expectRevert(RotatingIssuer.RenunciationDisabled.selector);
        issuer.renounceOwnership();
        address nextOwner = address(0x1234);
        issuer.transferOwnership(nextOwner);
        assertEq(issuer.owner(), address(this));
        vm.prank(nextOwner);
        issuer.acceptOwnership();
        assertEq(issuer.owner(), nextOwner);
        assertEq(issuer.operatingKey(), oldKey);
        assertEq(issuer.pendingKey(), address(0));
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        vm.prank(newKey);
        issuer.acceptKey(1);
    }

    function test_RevocationAndPermanentDenialAreNotErasedByKeyRotation() public {
        vm.recordLogs();
        vm.prank(oldKey);
        issuer.deny(1, alice, 9, 1);
        _relay(vm.getRecordedLogs(), 2);
        assertTrue(asc.permanentDenial(alice));
        _rotate();
        vm.recordLogs();
        _issue(newKey, 2, bytes32(uint256(1)), alice);
        _relay(vm.getRecordedLogs(), 0);
        assertTrue(asc.permanentDenial(alice));
        assertFalse(registry.isVerified(alice, policy));
        vm.recordLogs();
        vm.prank(newKey);
        issuer.revoke(2, bob, 1, 1);
        _relay(vm.getRecordedLogs(), 1);
        assertTrue(asc.tombstone(bob));
        vm.expectRevert(RotatingIssuer.InactiveKey.selector);
        vm.prank(oldKey);
        issuer.deny(1, bob, 9, 1);
    }

    function test_ProposalCancellationAndDeploymentGuards() public {
        issuer.proposeKey(newKey);
        issuer.cancelKeyProposal();
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        vm.prank(newKey);
        issuer.acceptKey(1);
        vm.expectRevert(RotatingIssuer.MissingReason.selector);
        issuer.suspend(bytes32(0));
        vm.expectRevert(RotatingIssuer.InvalidKey.selector);
        new RotatingIssuer(address(this), address(this), address(source));
        vm.expectRevert(RotatingIssuer.InvalidSource.selector);
        new RotatingIssuer(address(this), oldKey, address(0x123));
    }
}
