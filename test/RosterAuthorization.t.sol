// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry, RosterMark} from "../src/ProofmarkRegistry.sol";
import {Policy} from "../src/lib/ProofmarkTypes.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

contract RosterAuthorizationTest is Test {
    uint256 constant KEY_A = 123;
    uint40 constant NOW = 1_800_000_000;
    bytes32 constant SNAPSHOT = bytes32(uint256(7));
    address publisher = address(0xB0B);
    address alice = address(0xA11CE);
    address issuer;
    ComplianceSource source;
    ProofmarkASC asc;
    ProofmarkRegistry registry;
    ReceiptFixture fx;
    RosterMark mark;
    RosterProof.Inclusion proof;
    bytes32 root;

    struct Params {
        uint32 epoch;
        bytes32 root;
        uint32 listVersion;
        uint40 validUntil;
        uint40 cutoff;
        bytes32 snapshotId;
    }

    function setUp() public {
        vm.warp(NOW);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        issuer = vm.addr(KEY_A);
        source = new ComplianceSource(address(this));
        source.setIssuer(issuer, true);
        source.setEpochPublisher(publisher, true);
        asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(source));
        registry = new ProofmarkRegistry(address(asc));
        fx = new ReceiptFixture();
        mark = RosterMark(
            MarkAttrs.pack(1, 3, 1, 410, 1 << 16, NOW, NOW + 1 days, 0),
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            issuer
        );
        bytes32 lower = RosterProof.leafOf(bytes32(0), bytes32(0));
        bytes32 upper = RosterProof.leafOf(bytes32(type(uint256).max), bytes32(0));
        bytes32 member = RosterProof.leafOf(
            RosterProof.subjectKey("eip155", alice),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        bytes32 right = keccak256(abi.encodePacked(bytes1(0x01), upper, upper));
        root = RosterProof.rootOf(
            keccak256(abi.encodePacked(bytes1(0x01), keccak256(abi.encodePacked(bytes1(0x01), lower, member)), right)),
            3
        );
        proof.index = 1;
        proof.leafCount = 3;
        proof.siblings.push(lower);
        proof.siblings.push(right);
    }

    function _params() private view returns (Params memory) {
        return Params(1, root, 9, NOW + 1 days, NOW, SNAPSHOT);
    }

    function _digest(ComplianceSource target, Params memory p, address sender) private view returns (bytes32) {
        return target.rosterApprovalDigest(p.epoch, p.root, p.listVersion, p.validUntil, p.cutoff, p.snapshotId, sender);
    }

    function _approval(bytes32 digest, uint256 key) private view returns (ComplianceSource.RootApproval[] memory a) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        a = new ComplianceSource.RootApproval[](1);
        a[0] = ComplianceSource.RootApproval(issuer, abi.encodePacked(r, s, v));
    }

    function _publish(Params memory p, ComplianceSource.RootApproval[] memory a) private {
        vm.prank(publisher);
        source.publishEpochForIssuers(p.epoch, p.root, p.listVersion, p.validUntil, p.cutoff, p.snapshotId, a);
    }

    function _relay(Vm.Log[] memory recorded, uint64 height) private {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](recorded.length);
        for (uint256 i; i < recorded.length; ++i) {
            logs[i] = fx.log(recorded[i].emitter, recorded[i].topics, recorded[i].data);
        }
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

    function _policy(address trusted) private returns (uint256) {
        return registry.registerPolicy(Policy(1 << 16, 2, 0, 1, 410, trusted, true, false));
    }

    function test_PublisherCannotForgeAnotherIssuerEvenIfPublisherIsAnIssuer() public {
        source.setIssuer(publisher, true);
        vm.recordLogs();
        vm.prank(publisher);
        source.publishEpoch(1, root, 9, NOW + 1 days, NOW, SNAPSHOT);
        _relay(vm.getRecordedLogs(), 1);
        uint256 trusted = _policy(issuer);
        uint256 wildcard = _policy(address(0));
        assertTrue(asc.epochIssuerApproved(1, publisher));
        assertFalse(asc.epochIssuerApproved(1, issuer));
        assertFalse(registry.verifyWithRoster(alice, trusted, mark, proof));
        assertFalse(
            registry.verifyWithRoster(alice, wildcard, mark, proof), "wildcard is not an unsigned-issuer bypass"
        );
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        registry.cacheRosterWitness(alice, mark, proof);
        Params memory p = _params();
        p.epoch = 2;
        ComplianceSource.RootApproval[] memory a = _approval(_digest(source, p, publisher), KEY_A);
        vm.recordLogs();
        _publish(p, a);
        _relay(vm.getRecordedLogs(), 2);
        assertTrue(asc.epochIssuerApproved(2, issuer));
        assertTrue(registry.verifyWithRoster(alice, trusted, mark, proof));
        registry.cacheRosterWitness(alice, mark, proof);
        assertTrue(registry.isVerified(alice, trusted));
    }

    function test_UnsignedTrustedIssuerLeafFailsDespiteFreshRootAndValidInclusion() public {
        // Isolate the T-07 counterexample from freshness and Merkle-format failures: the
        // publisher approves this exact root as itself, while the valid leaf names `issuer`.
        source.setIssuer(publisher, true);
        vm.recordLogs();
        vm.prank(publisher);
        source.publishEpoch(1, root, 9, NOW + 1 days, NOW, SNAPSHOT);
        _relay(vm.getRecordedLogs(), 1);

        bytes32 leaf = RosterProof.leafOf(
            RosterProof.subjectKey("eip155", alice),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        assertTrue(asc.isRosterFresh(), "counterexample requires a fresh current root");
        assertEq(asc.epochRoots(1), root);
        assertTrue(RosterProof.verifyInclusion(root, leaf, proof), "counterexample requires a valid leaf proof");
        assertTrue(asc.epochIssuerApproved(1, publisher));
        assertFalse(asc.epochIssuerApproved(1, issuer));

        assertFalse(registry.verifyWithRoster(alice, _policy(issuer), mark, proof));
        assertFalse(registry.verifyWithRoster(alice, _policy(address(0)), mark, proof));
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        registry.cacheRosterWitness(alice, mark, proof);
    }

    function test_ApprovalBindsEveryFieldPublisherSourceAndChain() public {
        Params memory original = _params();
        original.validUntil = NOW + 23 hours;
        ComplianceSource.RootApproval[] memory a = _approval(_digest(source, original, publisher), KEY_A);
        for (uint256 i; i < 6; ++i) {
            Params memory changed = _params();
            changed.validUntil = original.validUntil;
            if (i == 0) changed.epoch++;
            else if (i == 1) changed.root = bytes32(uint256(66));
            else if (i == 2) changed.listVersion++;
            else if (i == 3) changed.validUntil--;
            else if (i == 4) changed.cutoff--;
            else changed.snapshotId = bytes32(uint256(88));
            vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
            _publish(changed, a);
        }
        a = _approval(_digest(source, original, address(0xBAD)), KEY_A);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(original, a);
        ComplianceSource other = new ComplianceSource(address(this));
        a = _approval(_digest(other, original, publisher), KEY_A);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(original, a);
        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        a = _approval(_digest(source, original, publisher), KEY_A);
        vm.chainId(chain);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(original, a);
        assertEq(source.lastEpoch(), 0);
    }

    function test_RoleRemovalWrongSignerDuplicatesAndReplayFail() public {
        Params memory p = _params();
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.NotIssuer.selector, publisher));
        vm.prank(publisher);
        source.publishEpoch(1, root, 9, NOW + 1 days, NOW, SNAPSHOT);
        ComplianceSource.RootApproval[] memory a = _approval(_digest(source, p, publisher), 456);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, a);
        a = _approval(_digest(source, p, publisher), KEY_A);
        source.setIssuer(issuer, false);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, a);
        source.setIssuer(issuer, true);
        ComplianceSource.RootApproval[] memory duplicate = new ComplianceSource.RootApproval[](2);
        duplicate[0] = a[0];
        duplicate[1] = a[0];
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, duplicate);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, new ComplianceSource.RootApproval[](0));
        _publish(p, a);
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.EpochNotMonotonic.selector, uint32(1), uint32(1)));
        _publish(p, a);
    }

    function test_ContractIssuerApprovalIsCheckedAtSourcePublicationNotRequeriedOnHub() public {
        RootWallet wallet = new RootWallet();
        source.setIssuer(address(wallet), true);
        Params memory p = _params();
        wallet.set(_digest(source, p, publisher), true);
        ComplianceSource.RootApproval[] memory a = new ComplianceSource.RootApproval[](1);
        a[0] = ComplianceSource.RootApproval(address(wallet), hex"01");
        wallet.set(bytes32(0), false);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, a);
        wallet.set(_digest(source, p, publisher), true);
        vm.recordLogs();
        _publish(p, a);
        Vm.Log[] memory receipt = vm.getRecordedLogs();
        wallet.set(bytes32(0), false);
        source.setIssuer(address(wallet), false);
        _relay(receipt, 1);
        assertTrue(asc.epochIssuerApproved(1, address(wallet)), "historical authorization is not retroactively erased");
        p.epoch = 2;
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, a);
    }

    function test_MultipleIssuersMustBeSortedAndApprovalsDoNotCarryToNextEpoch() public {
        address second = vm.addr(456);
        source.setIssuer(second, true);
        Params memory p = _params();
        bytes32 digest = _digest(source, p, publisher);
        ComplianceSource.RootApproval[] memory a = new ComplianceSource.RootApproval[](2);
        a[0] = _approval(digest, KEY_A)[0];
        a[1] = _approval(digest, 456)[0];
        a[1].issuer = second;
        if (a[0].issuer < a[1].issuer) (a[0], a[1]) = (a[1], a[0]);
        vm.expectRevert(ComplianceSource.InvalidRootApprovals.selector);
        _publish(p, a);
        (a[0], a[1]) = (a[1], a[0]);
        vm.recordLogs();
        _publish(p, a);
        _relay(vm.getRecordedLogs(), 1);
        assertTrue(asc.epochIssuerApproved(1, issuer));
        assertTrue(asc.epochIssuerApproved(1, second));
        uint256 policy = _policy(issuer);
        assertTrue(registry.verifyWithRoster(alice, policy, mark, proof));
        p.epoch = 2;
        a = _approval(_digest(source, p, publisher), 456);
        a[0].issuer = second;
        vm.recordLogs();
        _publish(p, a);
        _relay(vm.getRecordedLogs(), 2);
        assertTrue(asc.epochIssuerApproved(2, second));
        assertFalse(asc.epochIssuerApproved(2, issuer));
        assertFalse(
            registry.verifyWithRoster(alice, policy, mark, proof), "previous approval cannot authorize next root"
        );
    }

    function relayReceipt(Vm.Log[] memory receipt, uint64 height) external {
        _relay(receipt, height);
    }

    function test_ApprovalMustMatchTheEpochAndTrustedSourceInTheSameReceipt() public {
        Params memory p = _params();
        ComplianceSource.RootApproval[] memory a = _approval(_digest(source, p, publisher), KEY_A);
        vm.recordLogs();
        _publish(p, a);
        Vm.Log[] memory receipt = vm.getRecordedLogs();
        assertEq(receipt.length, 2);
        Vm.Log[] memory missing = new Vm.Log[](1);
        missing[0] = receipt[1];
        vm.expectRevert(ProofmarkASC.InvalidEpochAuthorization.selector);
        this.relayReceipt(missing, 1);
        missing[0] = receipt[0];
        vm.expectRevert(ProofmarkASC.NoMatchingEvent.selector);
        this.relayReceipt(missing, 2);
        for (uint256 i; i < 4; ++i) {
            Vm.Log[] memory bad = new Vm.Log[](2);
            for (uint256 j; j < 2; ++j) {
                bad[j].emitter = receipt[j].emitter;
                bad[j].data = receipt[j].data;
                bad[j].topics = new bytes32[](receipt[j].topics.length);
                for (uint256 k; k < bad[j].topics.length; ++k) {
                    bad[j].topics[k] = receipt[j].topics[k];
                }
            }
            if (i == 0) bad[0].emitter = address(0xBAD);
            else if (i == 1) bad[0].topics[2] = bytes32(uint256(88));
            else if (i == 2) bad[0].topics[3] = bytes32(uint256(1) << 160);
            else bad[0].data = hex"00";
            vm.expectRevert(ProofmarkASC.InvalidEpochAuthorization.selector);
            this.relayReceipt(bad, uint64(3 + i));
        }
        assertFalse(asc.epochIssuerApproved(1, issuer));
        _relay(receipt, 10);
        assertTrue(asc.epochIssuerApproved(1, issuer));
    }
}

contract RootWallet {
    bytes32 digest;
    bool enabled;

    function set(bytes32 d, bool e) external {
        digest = d;
        enabled = e;
    }

    function isValidSignature(bytes32 d, bytes calldata) external view returns (bytes4) {
        return enabled && d == digest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
