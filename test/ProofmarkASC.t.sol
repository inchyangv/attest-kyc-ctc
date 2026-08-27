// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, Mark, MarkStatus, Methods} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver, MockBlockProverFailing} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

/// @notice 로컬 모의 하네스 — 어테스트 8분 대기 없이 ASC 방어 로직 전량을 검증한다.
/// @dev docs/05-asc-integration-review.md 의 발견 사항들을 **실제로 증명**하는 것이 목적.
contract ProofmarkASCTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    uint64 constant SEPOLIA_KEY = 1;   // 실측 확인: chainKey 1 = Sepolia
    uint64 constant MAINNET_KEY = 3;   // 실측 확인: chainKey 3 = Ethereum mainnet

    ProofmarkASC     asc;
    ComplianceSource src;
    ReceiptFixture   fx;

    address owner   = address(0xA11CE);
    address issuer  = address(0x1554E4);
    address alice   = address(0xA11);
    address bob     = address(0xB0B);
    address evilSrc = address(0xBAD);

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);

        fx  = new ReceiptFixture();
        src = new ComplianceSource(owner);

        vm.startPrank(owner);
        src.setIssuer(issuer, true);
        src.setEpochPublisher(issuer, true);
        asc = new ProofmarkASC(owner);
        asc.configureSource(SEPOLIA_KEY, address(src));
        vm.stopPrank();
    }

    // ───────────────────────── 헬퍼 ─────────────────────────

    function _attrs(uint32 methods_, uint40 expiry_) internal pure returns (bytes32) {
        return MarkAttrs.pack(1, 3, 410, 410, methods_, 1_700_000_000, expiry_, 1);
    }

    function _issuedLog(address emitter, address subject, bytes32 attrs)
        internal view returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = attrs;
        t[3] = bytes32(uint256(uint160(issuer)));
        return fx.log(emitter, t, abi.encode(bytes32(uint256(0xC1)), bytes32(uint256(0xE1))));
    }

    function _revokedLog(address subject) internal view returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkRevoked(address,uint16,uint32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = bytes32(uint256(2));  // RESCREEN_HIT
        t[3] = bytes32(uint256(1));  // epoch
        return fx.log(address(src), t, bytes(""));
    }

    function _one(EvmV1Decoder.LogEntryTuple memory l)
        internal pure returns (EvmV1Decoder.LogEntryTuple[] memory a)
    {
        a = new EvmV1Decoder.LogEntryTuple[](1);
        a[0] = l;
    }

    /// @dev merkleRoot 를 salt 로 써서 서로 다른 queryId 를 만든다.
    function _exec(uint8 action, uint64 chainKey, uint64 height, bytes memory encTx, uint256 salt) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);
        asc.execute(action, chainKey, height, encTx, bytes32(salt), sib, bytes32(0), roots);
    }

    // ═══════════════ 1. 시그니처 상수 — 오타 방지 ═══════════════

    /// @dev 하드코딩한 상수가 실제 keccak 과 일치하는지. 오타 1건 = 온체인 8분 낭비.
    function test_EventSignatureConstantsAreCorrect() public pure {
        assertEq(keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)"),
                 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3);
        assertEq(keccak256("MarkRevoked(address,uint16,uint32)"),
                 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09);
        assertEq(keccak256("SanctionDenied(address,uint32,uint32)"),
                 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae);
        assertEq(keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40)"),
                 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3);
    }

    // ═══════════════ 2. MarkAttrs 팩킹 왕복 ═══════════════

    function testFuzz_AttrsRoundtrip(
        uint8 kind_, uint8 assurance_, uint16 regime_, uint16 juris_,
        uint32 methods_, uint40 issuedAt_, uint40 expiry_, uint32 epoch_
    ) public pure {
        bytes32 a = MarkAttrs.pack(kind_, assurance_, regime_, juris_, methods_, issuedAt_, expiry_, epoch_);
        assertEq(MarkAttrs.kind(a),         kind_);
        assertEq(MarkAttrs.assurance(a),    assurance_);
        assertEq(MarkAttrs.regime(a),       regime_);
        assertEq(MarkAttrs.jurisdiction(a), juris_);
        assertEq(MarkAttrs.methods(a),      methods_);
        assertEq(MarkAttrs.issuedAt(a),     issuedAt_);
        assertEq(MarkAttrs.expiry(a),       expiry_);
        assertEq(MarkAttrs.epoch(a),        epoch_);
    }

    // ═══════════════ 3. 정상 경로 ═══════════════

    function test_IssueMaterializesMark() public {
        bytes32 a = _attrs(Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT, 2_000_000_000);
        bytes memory encTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 1);

        Mark memory m = asc.getMark(alice);
        assertEq(m.status, uint8(MarkStatus.Active));
        assertEq(m.methods, Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT);
        assertEq(m.jurisdiction, 410);
        assertEq(m.issuer, issuer);
        assertEq(asc.lastAppliedHeight(alice), 100);
    }

    // ═══════════════ 4. 🔴 발견 1 — chainKey 고정 ═══════════════

    /// @dev 이 테스트가 포크의 존재 이유다. 원본 ASCBase 로는 이 방어가 **불가능**하다.
    function test_RejectsProofFromWrongChain() public {
        bytes32 a = _attrs(Methods.ID_DOC_AUTHENTICITY, 2_000_000_000);
        bytes memory encTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        // 메인넷(chainKey 3)에서 온 증명 — 로그의 emitter 주소는 정상이다.
        vm.expectRevert(abi.encodeWithSelector(ProofmarkASC.UnexpectedChainKey.selector, MAINNET_KEY, SEPOLIA_KEY));
        _exec(uint8(Action.MarkIssued), MAINNET_KEY, 100, encTx, 2);

        assertEq(asc.getMark(alice).status, uint8(MarkStatus.None));
    }

    // ═══════════════ 5. 발견 C4 — 발행자 고정 ═══════════════

    function test_RejectsUntrustedEmitter() public {
        bytes32 a = _attrs(Methods.ID_DOC_AUTHENTICITY, 2_000_000_000);
        // 공격자가 자기 컨트랙트에서 동일한 이벤트를 발행 — 증명 자체는 유효하다.
        bytes memory encTx = fx.tx2(_one(_issuedLog(evilSrc, alice, a)));

        vm.expectRevert(abi.encodeWithSelector(ProofmarkASC.UntrustedEmitter.selector, evilSrc, address(src)));
        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 3);
    }

    // ═══════════════ 6. 영수증 상태 검증 ═══════════════

    function test_RejectsFailedSourceTx() public {
        bytes32 a = _attrs(Methods.ID_DOC_AUTHENTICITY, 2_000_000_000);
        bytes memory encTx = fx.tx2Failed(_one(_issuedLog(address(src), alice, a)));

        vm.expectRevert(ProofmarkASC.SourceTxFailed.selector);
        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 4);
    }

    // ═══════════════ 7. 🔴 발견 2 — 순서 역전으로 부활 방지 ═══════════════

    /// @dev 핵심 시나리오: 폐기(block 200)를 먼저 반영한 뒤,
    ///      오래된 발급(block 100)을 제출해 마크를 되살리려는 시도.
    ///      queryId 가 다르므로 재생 방지에 걸리지 않는다 — 순서 커서만이 막는다.
    function test_StaleIssueCannotResurrectRevokedMark() public {
        bytes32 a = _attrs(Methods.ID_DOC_AUTHENTICITY, 2_000_000_000);
        bytes memory issueTx  = fx.tx2(_one(_issuedLog(address(src), alice, a)));
        bytes memory revokeTx = fx.tx2(_one(_revokedLog(alice)));

        // 1) 폐기가 먼저 반영된다 (block 200)
        _exec(uint8(Action.MarkRevoked), SEPOLIA_KEY, 200, revokeTx, 10);
        assertTrue(asc.tombstone(alice));
        assertEq(asc.getMark(alice).status, uint8(MarkStatus.Revoked));

        // 2) 공격자가 오래된 발급 증명(block 100)을 제출 — 정당한 증명이다
        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, issueTx, 11);

        // 3) 부활하지 않는다
        assertEq(asc.getMark(alice).status, uint8(MarkStatus.Revoked), "stale proof resurrected the mark");
        assertTrue(asc.tombstone(alice), "tombstone cleared");
        assertEq(asc.lastAppliedHeight(alice), 200);
    }

    // ═══════════════ 8. 발견 3 — 한 tx 다중 로그 배치 ═══════════════

    /// @dev verifyBatch 없이 배치를 얻는다: 한 tx 에 N개 로그 → execute() 1회로 N건 반영.
    function test_BatchIssueProcessesAllLogs() public {
        bytes32 a = _attrs(Methods.BANK_ACCOUNT, 2_000_000_000);

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _issuedLog(address(src), alice, a);
        logs[1] = _issuedLog(address(src), bob,   a);
        logs[2] = _issuedLog(address(src), address(0xC0FFEE), a);

        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 300, fx.tx2(logs), 20);

        assertEq(asc.getMark(alice).status,             uint8(MarkStatus.Active));
        assertEq(asc.getMark(bob).status,               uint8(MarkStatus.Active));
        assertEq(asc.getMark(address(0xC0FFEE)).status, uint8(MarkStatus.Active));
    }

    // ═══════════════ 9. 재생 방지 ═══════════════

    function test_ReplayProtection() public {
        bytes32 a = _attrs(Methods.BANK_ACCOUNT, 2_000_000_000);
        bytes memory encTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 30);
        // 동일 (chainKey, height, merkleRoot) → 동일 queryId
        vm.expectRevert("Query already processed");
        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 30);
    }

    // ═══════════════ 10. 증명 검증 실패 ═══════════════

    function test_RejectsInvalidProof() public {
        vm.etch(PRECOMPILE, address(new MockBlockProverFailing()).code);

        bytes32 a = _attrs(Methods.BANK_ACCOUNT, 2_000_000_000);
        bytes memory encTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        vm.expectRevert("Proof of inclusion verification failed");
        _exec(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, 40);
    }

    // ═══════════════ 11. 액션/이벤트 불일치는 안전하게 실패 ═══════════════

    function test_ActionMismatchFailsSafely() public {
        bytes32 a = _attrs(Methods.BANK_ACCOUNT, 2_000_000_000);
        bytes memory issueTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        // MarkIssued 로그만 있는 tx 에 MarkRevoked 액션을 지정
        vm.expectRevert(ProofmarkASC.NoMatchingEvent.selector);
        _exec(uint8(Action.MarkRevoked), SEPOLIA_KEY, 100, issueTx, 50);
    }

    // ═══════════════ 12. 소스 미설정 시 전면 거부 ═══════════════

    function test_RejectsBeforeSourceConfigured() public {
        ProofmarkASC fresh = new ProofmarkASC(owner);
        bytes32 a = _attrs(Methods.BANK_ACCOUNT, 2_000_000_000);
        bytes memory encTx = fx.tx2(_one(_issuedLog(address(src), alice, a)));

        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);

        vm.expectRevert(ProofmarkASC.SourceNotConfigured.selector);
        fresh.execute(uint8(Action.MarkIssued), SEPOLIA_KEY, 100, encTx, bytes32(uint256(60)), sib, bytes32(0), roots);
    }

    // ═══════════════ 13. 소스 컨트랙트 권한 ═══════════════

    function test_SourceOnlyIssuerCanIssue() public {
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.NotIssuer.selector, address(this)));
        src.issue(alice, bytes32(0), bytes32(0), bytes32(0));
    }

    function test_SourceEpochMustBeMonotonic() public {
        vm.startPrank(issuer);
        src.publishEpoch(1, bytes32(uint256(0xAA)), 100, uint40(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(ComplianceSource.EpochNotMonotonic.selector, uint32(1), uint32(1)));
        src.publishEpoch(1, bytes32(uint256(0xBB)), 100, uint40(block.timestamp + 1 days));
        vm.stopPrank();
    }
}
