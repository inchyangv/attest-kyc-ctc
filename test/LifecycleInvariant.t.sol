// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, Mark, MarkStatus} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

/// Fixed synthetic source history, randomized receipt arrival/replay/failure order.
/// No claim about the native verifier or multiple independent issuer namespaces.
contract LifecycleHandler is Test {
    ProofmarkASC public immutable asc;
    ReceiptFixture private immutable fx;
    address private constant SOURCE = address(0x501);
    address private constant ISSUER = address(0x155);
    uint256 private constant RECEIPTS = 48;
    bool[48] public delivered;
    uint256 public accepted;
    uint256 public replayed;
    uint256 public rejected;

    constructor(ProofmarkASC asc_) {
        asc = asc_;
        fx = new ReceiptFixture();
    }

    function subject(uint256 i) public pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    // A receipt has two trusted events, sometimes for the same subject, with a forged
    // foreign denial between them. Source order is receipt index then receipt-log index.
    function eventAt(uint256 receipt, uint256 pos) public pure returns (uint256 who, uint8 action) {
        who = pos == 0 || receipt % 2 == 0 ? receipt % 4 : (receipt + 1) % 4;
        action = uint8((receipt / 4 + pos) % 3);
    }

    function _log(uint256 receipt, uint256 pos, address emitter)
        private
        view
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        (uint256 who, uint8 action) = eventAt(receipt, pos);
        bytes32[] memory topics = new bytes32[](4);
        topics[1] = bytes32(uint256(uint160(subject(who))));
        bytes memory data;
        if (action == 0) {
            topics[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
            topics[2] = MarkAttrs.pack(1, 3, 2, 410, 1, 1_700_000_000, 2_000_000_000, 1);
            topics[3] = bytes32(uint256(uint160(ISSUER)));
            data = abi.encode(bytes32(receipt + 1), bytes32(pos + 1));
        } else {
            topics[0] = action == 1
                ? keccak256("MarkRevoked(address,uint16,uint32)")
                : keccak256("SanctionDenied(address,uint32,uint32)");
            topics[2] = bytes32(uint256(2));
            topics[3] = bytes32(uint256(1));
        }
        return fx.log(emitter, topics, data);
    }

    function _payload(uint256 receipt, bool malformed) private view returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _log(receipt, 0, SOURCE);
        bytes32[] memory foreign = new bytes32[](4);
        foreign[0] = keccak256("SanctionDenied(address,uint32,uint32)");
        foreign[1] = bytes32(uint256(uint160(subject(4))));
        logs[1] = fx.log(address(0xBAD), foreign, bytes(""));
        logs[2] = _log(receipt, 1, SOURCE);
        if (malformed) {
            // Correct source/signature but invalid topic shape AFTER a valid first log.
            bytes32[] memory bad = new bytes32[](1);
            bad[0] = logs[2].topics[0];
            logs[2].topics = bad;
        }
        return fx.tx2(logs);
    }

    function _execute(uint256 receipt, bool malformed, bool wrongChain, bool replay) private {
        (, uint8 action) = eventAt(receipt, receipt % 2);
        bytes memory payload = _payload(receipt, malformed);
        if (replay) {
            vm.expectRevert(bytes("Query already processed"));
        } else if (wrongChain) {
            vm.expectRevert(abi.encodeWithSelector(ProofmarkASC.UnexpectedChainKey.selector, uint64(3), uint64(1)));
        } else if (malformed) {
            vm.expectRevert(ProofmarkASC.BadTopics.selector);
        }
        asc.execute(
            action,
            wrongChain ? 3 : 1,
            uint64(100 + receipt / 4),
            payload,
            bytes32(receipt % 4 + 1),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function deliver(uint256 seed) external {
        uint256 receipt = seed % RECEIPTS;
        bool replay = delivered[receipt];
        if (replay) {
            replayed++;
        } else {
            delivered[receipt] = true;
            accepted++;
        }
        _execute(receipt, false, false, replay);
    }

    function rejectThenRepair(uint256 seed, bool wrongChain) external {
        uint256 receipt = seed % RECEIPTS;
        if (delivered[receipt]) return;
        bytes32 beforeState = _stateHash();
        _execute(receipt, !wrongChain, wrongChain, false);
        assertEq(_stateHash(), beforeState, "failed receipt partially applied");
        rejected++;
        // Same coordinates now succeed: failure must not consume the replay key.
        _execute(receipt, false, false, false);
        delivered[receipt] = true;
        accepted++;
    }

    function _stateHash() private view returns (bytes32 digest) {
        for (uint256 i; i < 5; i++) {
            address who = subject(i);
            digest = keccak256(
                abi.encode(
                    digest,
                    asc.getMark(who),
                    asc.tombstone(who),
                    asc.permanentDenial(who),
                    asc.lastAppliedHeight(who),
                    asc.lastAppliedTxIndex(who),
                    asc.lastAppliedLogIndex(who)
                )
            );
        }
    }

    function assertReference() external view {
        // Reconstruct expectations from the accepted SET in SOURCE ORDER, not arrival order.
        // Denial is cumulative; ordinary status and cursor come from the greatest coordinate.
        for (uint256 who; who < 5; who++) {
            bool denied;
            uint8 latestStatus;
            uint256 latestReceipt;
            uint256 latestPos;
            bool seen;
            for (uint256 r; r < RECEIPTS; r++) {
                if (delivered[r]) {
                    for (uint256 p; p < 2; p++) {
                        (uint256 person, uint8 action) = eventAt(r, p);
                        if (person != who) continue;
                        seen = true;
                        latestReceipt = r;
                        latestPos = p;
                        if (action == 2) denied = true;
                        latestStatus = action + 1;
                    }
                }
            }
            address wallet = subject(who);
            Mark memory mark = asc.getMark(wallet);
            uint8 expectedStatus = denied ? 3 : latestStatus;
            assertEq(mark.status, expectedStatus, "accepted-set status mismatch");
            assertEq(asc.permanentDenial(wallet), denied, "denial lost or invented");
            assertEq(asc.tombstone(wallet), expectedStatus > 1, "tombstone mismatch");
            assertEq(asc.lastAppliedHeight(wallet), seen ? 100 + latestReceipt / 4 : 0, "height regressed");
            assertEq(asc.lastAppliedTxIndex(wallet), seen ? latestReceipt % 4 + 1 : 0, "tx index mismatch");
            assertEq(asc.lastAppliedLogIndex(wallet), seen ? latestPos * 2 : 0, "log index mismatch");
            if (expectedStatus == 1) {
                assertEq(mark.issuer, ISSUER);
                assertEq(mark.origin, 1);
                assertEq(mark.claimsRoot, bytes32(latestReceipt + 1));
                assertEq(mark.evidenceHash, bytes32(latestPos + 1));
            }
        }
    }
}

contract LifecycleInvariantTest is StdInvariant, Test {
    LifecycleHandler private handler;

    function setUp() public {
        vm.warp(1_700_086_400);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        ProofmarkASC asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(0x501));
        handler = new LifecycleHandler(asc);
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = LifecycleHandler.deliver.selector;
        selectors[1] = LifecycleHandler.rejectThenRepair.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector(address(handler), selectors));
        // Non-vacuous baseline: issue, revoke, deny, replay, failed receipt then repair.
        handler.deliver(0);
        handler.deliver(8);
        handler.deliver(0);
        handler.rejectThenRepair(4, false);
        assertEq(handler.accepted(), 3);
        assertEq(handler.replayed(), 1);
        assertEq(handler.rejected(), 1);
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_AcceptedReceiptsDetermineLifecycle() public view {
        handler.assertReference();
    }
}

/// Randomized receipt contents as well as delivery order. The first attempt at a source
/// coordinate seals its synthetic contents, so later attempts exercise exact-coordinate replay.
contract ArbitraryLifecycleHandler is Test {
    struct GeneratedEvent {
        uint8 who;
        uint8 action;
        bool validIssuance;
        address issuer;
        bytes32 claimsRoot;
        bytes32 evidenceHash;
    }

    ProofmarkASC public immutable asc;
    ReceiptFixture private immutable fx;
    address private constant SOURCE = address(0x601);
    uint256 private constant RECEIPTS = 32;
    bool[32] public configured;
    bool[32] public delivered;
    GeneratedEvent[64] private generated;
    uint256 public accepted;
    uint256 public replayed;
    uint256 public rejected;

    constructor(ProofmarkASC asc_) {
        asc = asc_;
        fx = new ReceiptFixture();
    }

    function subject(uint256 i) public pure returns (address) {
        return address(uint160(0x3000 + i));
    }

    function _configure(uint256 receipt, uint256 contentSeed) private {
        if (configured[receipt]) return;
        configured[receipt] = true;
        for (uint256 pos; pos < 2; ++pos) {
            uint256 entropy = uint256(keccak256(abi.encode(receipt, contentSeed, pos)));
            uint8 variant = uint8(entropy % 4);
            generated[receipt * 2 + pos] = GeneratedEvent({
                who: uint8((entropy >> 8) % 4),
                action: variant == 3 ? uint8(Action.SanctionDenialCorrection) : variant,
                validIssuance: ((entropy >> 16) % 4) != 0,
                issuer: address(uint160(0x4000 + ((entropy >> 24) % 3))),
                claimsRoot: keccak256(abi.encode("claims", receipt, pos, contentSeed)),
                evidenceHash: keccak256(abi.encode("evidence", receipt, pos, contentSeed))
            });
        }
    }

    function _attrs(uint256 receipt, uint256 pos, bool valid) private pure returns (bytes32 attrs) {
        attrs = MarkAttrs.pack(
            uint8(1 + ((receipt + pos) % 2)),
            uint8(1 + ((receipt * 3 + pos) % 5)),
            uint16(1 + ((receipt + pos) % 2)),
            uint16(1 + ((receipt * 17 + pos) % 999)),
            uint32(1),
            uint40(1_700_000_000 + receipt * 10 + pos),
            uint40(1_800_000_000 + receipt * 10 + pos),
            uint32(receipt + 1)
        );
        if (!valid) attrs |= bytes32(uint256(1)); // schema-0 reserved bit
    }

    function _log(uint256 receipt, uint256 pos, address emitter)
        private
        view
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        GeneratedEvent storage e = generated[receipt * 2 + pos];
        bytes32[] memory topics = new bytes32[](4);
        topics[1] = bytes32(uint256(uint160(subject(e.who))));
        bytes memory data;
        if (e.action == uint8(Action.MarkIssued)) {
            topics[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
            topics[2] = _attrs(receipt, pos, e.validIssuance);
            topics[3] = bytes32(uint256(uint160(e.issuer)));
            data = abi.encode(e.claimsRoot, e.evidenceHash);
        } else if (e.action == uint8(Action.MarkRevoked)) {
            topics[0] = keccak256("MarkRevoked(address,uint16,uint32)");
            topics[2] = bytes32(uint256(2));
            topics[3] = bytes32(uint256(receipt + 1));
        } else if (e.action == uint8(Action.SanctionDenied)) {
            topics[0] = keccak256("SanctionDenied(address,uint32,uint32)");
            topics[2] = bytes32(uint256(receipt + 1));
            topics[3] = bytes32(uint256(1));
        } else {
            topics[0] = keccak256("SanctionDenialCorrected(address,uint64,uint256,bytes32,address,address)");
            topics[2] = bytes32(uint256(receipt + 1));
            topics[3] = bytes32(receipt * 2 + pos + 1);
            data = abi.encode(keccak256(abi.encode("case", receipt, pos)), address(0xCA11), address(0xA9900));
        }
        return fx.log(emitter, topics, data);
    }

    function _payload(uint256 receipt, bool malformed) private view returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _log(receipt, 0, SOURCE);
        bytes32[] memory foreign = new bytes32[](4);
        foreign[0] = keccak256("SanctionDenied(address,uint32,uint32)");
        foreign[1] = bytes32(uint256(uint160(subject(4))));
        logs[1] = fx.log(address(0xBAD), foreign, bytes(""));
        logs[2] = _log(receipt, 1, SOURCE);
        if (malformed) {
            bytes32[] memory bad = new bytes32[](1);
            bad[0] = logs[2].topics[0];
            logs[2].topics = bad;
        }
        return fx.tx2(logs);
    }

    function _execute(uint256 receipt, bool malformed, bool wrongChain, bool replay) private {
        bytes memory payload = _payload(receipt, malformed);
        if (replay) {
            vm.expectRevert(bytes("Query already processed"));
        } else if (wrongChain) {
            vm.expectRevert(abi.encodeWithSelector(ProofmarkASC.UnexpectedChainKey.selector, uint64(3), uint64(1)));
        } else if (malformed) {
            vm.expectRevert(ProofmarkASC.BadTopics.selector);
        }
        asc.execute(
            generated[receipt * 2].action,
            wrongChain ? 3 : 1,
            uint64(100 + receipt / 4),
            payload,
            bytes32(receipt % 4 + 1),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function deliver(uint256 receiptSeed, uint256 contentSeed) external {
        uint256 receipt = receiptSeed % RECEIPTS;
        _configure(receipt, contentSeed);
        bool replay = delivered[receipt];
        if (replay) {
            replayed++;
        } else {
            delivered[receipt] = true;
            accepted++;
        }
        _execute(receipt, false, false, replay);
    }

    function rejectThenRepair(uint256 receiptSeed, uint256 contentSeed, bool wrongChain) external {
        uint256 receipt = receiptSeed % RECEIPTS;
        if (delivered[receipt]) return;
        _configure(receipt, contentSeed);
        bytes32 beforeState = _stateHash();
        _execute(receipt, !wrongChain, wrongChain, false);
        assertEq(_stateHash(), beforeState, "failed generated receipt partially applied");
        rejected++;
        _execute(receipt, false, false, false);
        delivered[receipt] = true;
        accepted++;
    }

    function _stateHash() private view returns (bytes32 digest) {
        for (uint256 i; i < 5; ++i) {
            address who = subject(i);
            digest = keccak256(
                abi.encode(
                    digest,
                    asc.getMark(who),
                    asc.tombstone(who),
                    asc.permanentDenial(who),
                    asc.lastAppliedHeight(who),
                    asc.lastAppliedTxIndex(who),
                    asc.lastAppliedLogIndex(who),
                    asc.lastDenialDecisionHeight(who),
                    asc.lastDenialDecisionTxIndex(who),
                    asc.lastDenialDecisionLogIndex(who)
                )
            );
        }
    }

    function assertReference() external view {
        for (uint256 who; who < 5; ++who) {
            _assertSubject(who);
        }
    }

    function _assertSubject(uint256 who) private view {
        uint8 status;
        bool denied;
        bool seen;
        bool decisionSeen;
        uint256 latestReceipt;
        uint256 latestPos;
        uint256 decisionReceipt;
        uint256 decisionPos;
        uint256 activeReceipt;
        uint256 activePos;
        for (uint256 receipt; receipt < RECEIPTS; ++receipt) {
            if (!delivered[receipt]) continue;
            for (uint256 pos; pos < 2; ++pos) {
                GeneratedEvent storage e = generated[receipt * 2 + pos];
                if (e.who != who) continue;
                seen = true;
                latestReceipt = receipt;
                latestPos = pos;
                if (e.action == uint8(Action.MarkIssued)) {
                    if (e.validIssuance) {
                        activeReceipt = receipt;
                        activePos = pos;
                        status = denied ? uint8(MarkStatus.Denied) : uint8(MarkStatus.Active);
                    } else if (!denied) {
                        status = uint8(MarkStatus.Suspended);
                    }
                } else if (e.action == uint8(Action.MarkRevoked)) {
                    status = denied ? uint8(MarkStatus.Denied) : uint8(MarkStatus.Revoked);
                } else if (e.action == uint8(Action.SanctionDenied)) {
                    decisionSeen = true;
                    decisionReceipt = receipt;
                    decisionPos = pos;
                    denied = true;
                    status = uint8(MarkStatus.Denied);
                } else {
                    decisionSeen = true;
                    decisionReceipt = receipt;
                    decisionPos = pos;
                    denied = false;
                    status = uint8(MarkStatus.Suspended);
                }
            }
        }
        address wallet = subject(who);
        Mark memory mark = asc.getMark(wallet);
        assertEq(mark.status, status, "generated source-order status mismatch");
        assertEq(asc.permanentDenial(wallet), denied, "generated decision mismatch");
        assertEq(asc.tombstone(wallet), status > uint8(MarkStatus.Active), "generated tombstone mismatch");
        assertEq(asc.lastAppliedHeight(wallet), seen ? 100 + latestReceipt / 4 : 0, "generated height mismatch");
        assertEq(asc.lastAppliedTxIndex(wallet), seen ? latestReceipt % 4 + 1 : 0, "generated tx mismatch");
        assertEq(asc.lastAppliedLogIndex(wallet), seen ? latestPos * 2 : 0, "generated log mismatch");
        assertEq(
            asc.lastDenialDecisionHeight(wallet),
            decisionSeen ? 100 + decisionReceipt / 4 : 0,
            "generated decision height mismatch"
        );
        assertEq(
            asc.lastDenialDecisionTxIndex(wallet),
            decisionSeen ? decisionReceipt % 4 + 1 : 0,
            "generated decision tx mismatch"
        );
        assertEq(
            asc.lastDenialDecisionLogIndex(wallet),
            decisionSeen ? decisionPos * 2 : 0,
            "generated decision log mismatch"
        );
        if (status == uint8(MarkStatus.Active)) {
            GeneratedEvent storage active = generated[activeReceipt * 2 + activePos];
            assertEq(mark.issuer, active.issuer, "generated issuer mismatch");
            assertEq(mark.claimsRoot, active.claimsRoot, "generated claims mismatch");
            assertEq(mark.evidenceHash, active.evidenceHash, "generated evidence mismatch");
            assertEq(mark.origin, 1, "generated origin mismatch");
        }
        if (who == 4) {
            assertFalse(seen, "foreign subject entered trusted model");
            assertEq(mark.status, uint8(MarkStatus.None), "foreign event created mark");
        }
    }
}

contract ArbitraryLifecycleInvariantTest is StdInvariant, Test {
    ArbitraryLifecycleHandler private handler;

    function setUp() public {
        vm.warp(1_700_086_400);
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        ProofmarkASC asc = new ProofmarkASC(address(this));
        asc.configureSource(1, address(0x601));
        handler = new ArbitraryLifecycleHandler(asc);
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = ArbitraryLifecycleHandler.deliver.selector;
        selectors[1] = ArbitraryLifecycleHandler.rejectThenRepair.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector(address(handler), selectors));
        handler.deliver(0, 1);
        handler.rejectThenRepair(1, 2, false);
        assertEq(handler.accepted(), 2);
        assertEq(handler.rejected(), 1);
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_GeneratedReceiptsMatchSourceOrderedLifecycle() public view {
        handler.assertReference();
    }
}

/// Deterministic counterexample found while expanding the lifecycle model for T-14.
/// A correction arriving after a source-later revocation must reveal Revoked, not collapse
/// every non-issuance ordinary transition into Suspended.
contract LifecycleOrderingRegressionTest is Test {
    ProofmarkASC private asc;
    ReceiptFixture private fx;
    address private constant SOURCE = address(0x501);
    address private constant SUBJECT = address(0x1001);

    function setUp() public {
        vm.etch(address(0xFD2), address(new MockBlockProver()).code);
        asc = new ProofmarkASC(address(this));
        asc.configureSource(1, SOURCE);
        fx = new ReceiptFixture();
    }

    function _relay(uint8 action, uint64 height, uint64 txIndex, EvmV1Decoder.LogEntryTuple memory entry) private {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = entry;
        asc.execute(
            action,
            1,
            height,
            fx.tx2(logs),
            bytes32(uint256(txIndex)),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function _denial() private view returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("SanctionDenied(address,uint32,uint32)");
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        topics[2] = bytes32(uint256(1));
        topics[3] = bytes32(uint256(1));
        return fx.log(SOURCE, topics, bytes(""));
    }

    function _revocation() private view returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("MarkRevoked(address,uint16,uint32)");
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        topics[2] = bytes32(uint256(2));
        topics[3] = bytes32(uint256(1));
        return fx.log(SOURCE, topics, bytes(""));
    }

    function _correction() private view returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("SanctionDenialCorrected(address,uint64,uint256,bytes32,address,address)");
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        topics[2] = bytes32(uint256(1));
        topics[3] = bytes32(uint256(1));
        return fx.log(SOURCE, topics, abi.encode(keccak256("case"), address(0x155), address(0xA9900)));
    }

    function test_CorrectionDeliveredAfterLaterRevocationPreservesSourceOrderedStatus() public {
        _relay(uint8(Action.SanctionDenied), 100, 1, _denial());
        _relay(uint8(Action.MarkRevoked), 300, 3, _revocation());
        _relay(uint8(Action.SanctionDenialCorrection), 200, 2, _correction());

        assertFalse(asc.permanentDenial(SUBJECT));
        assertTrue(asc.tombstone(SUBJECT));
        assertEq(asc.getMark(SUBJECT).status, uint8(MarkStatus.Revoked));
        assertEq(asc.lastAppliedHeight(SUBJECT), 300);
    }
}
