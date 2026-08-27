// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry} from "../src/ProofmarkRegistry.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {GatedRwaNote} from "../src/GatedRwaNote.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, Policy, Methods} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

/// @notice 데모 시나리오 검증 — docs/03-product-plan.md §10 데모 대본이 실제로 도는지.
contract GatedRwaNoteTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    uint64  constant SEPOLIA_KEY = 1;

    uint32 constant KR_VASP = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
    uint32 constant EU_RWA  = Methods.LIVENESS | Methods.SANCTIONS_SCREENED | Methods.PEP_SCREENED;

    ProofmarkASC      asc;
    ProofmarkRegistry reg;
    ComplianceSource  src;
    ReceiptFixture    fx;
    GatedRwaNote      krNote;

    address owner  = address(0xA11CE);
    address issuer = address(0x1554E4);
    address alice  = address(0xA11);
    address bob    = address(0xB0B);
    address mallory = address(0xBAD1);

    uint256 krPolicy;
    uint40 constant ISSUED_AT = 1_700_000_000;
    uint40 constant EXPIRY    = 1_800_000_000;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        vm.warp(ISSUED_AT + 1 days);

        fx  = new ReceiptFixture();
        src = new ComplianceSource(owner);

        vm.startPrank(owner);
        src.setIssuer(issuer, true);
        asc = new ProofmarkASC(owner);
        asc.configureSource(SEPOLIA_KEY, address(src));
        vm.stopPrank();

        reg = new ProofmarkRegistry(address(asc));
        krPolicy = reg.registerPolicy(Policy({
            requireAll: KR_VASP, minAssurance: 2, maxAge: 0, requireRoster: false, exists: false
        }));

        krNote = new GatedRwaNote("KR Credit Note", "KRCN", address(reg), krPolicy, owner);
    }

    // ─── 헬퍼 ───

    function _issue(address subject, uint32 methods_, uint64 height, uint256 salt) internal {
        bytes32 attrs = MarkAttrs.pack(1, 3, 410, 410, methods_, ISSUED_AT, EXPIRY, 0);
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = attrs;
        t[3] = bytes32(uint256(uint160(issuer)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, abi.encode(bytes32(uint256(1)), bytes32(uint256(2))));
        _exec(uint8(Action.MarkIssued), height, fx.tx2(logs), salt);
    }

    function _revoke(address subject, uint64 height, uint256 salt) internal {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkRevoked(address,uint16,uint32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = bytes32(uint256(2));
        t[3] = bytes32(uint256(1));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, bytes(""));
        _exec(uint8(Action.MarkRevoked), height, fx.tx2(logs), salt);
    }

    function _exec(uint8 action, uint64 height, bytes memory encTx, uint256 salt) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);
        asc.execute(action, SEPOLIA_KEY, height, encTx, bytes32(salt), sib, bytes32(0), roots);
    }

    // ═══════════════ 데모 대본 6·8번 — 수명주기 전체 ═══════════════

    /// @dev 미인증 revert → 발급 후 성공 → 폐기 후 재차단.
    ///      기획안 §9.1 P0 의 `GatedRwaNote` DoD 그대로다.
    function test_DemoLifecycle_BlockedThenAllowedThenBlockedAgain() public {
        // ① 미인증 상태에서는 발행조차 안 된다
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, krPolicy));
        krNote.mint(alice, 1000);

        // ② 발급 후에는 발행된다
        _issue(alice, KR_VASP, 100, 1);
        _issue(bob,   KR_VASP, 101, 2);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        assertEq(krNote.balanceOf(alice), 1000);

        // ③ 인증된 지갑끼리는 이전된다
        vm.prank(alice);
        krNote.transfer(bob, 400);
        assertEq(krNote.balanceOf(bob), 400);

        // ④ 폐기되면 같은 이전이 막힌다
        _revoke(alice, 200, 3);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.SenderNotVerified.selector, alice, krPolicy));
        krNote.transfer(bob, 100);

        assertEq(krNote.balanceOf(alice), 600, "balance must be untouched");
    }

    // ═══════════════ 양방향 검사 ═══════════════

    /// @dev 수신자만 미인증인 경우. 한쪽만 검사하면 제재 지갑이 *받는* 걸 막지 못한다.
    function test_BlocksTransferToUnverifiedRecipient() public {
        _issue(alice, KR_VASP, 100, 10);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    /// @dev 제재 등재된 수신자에게 보내는 것도 막힌다.
    function test_BlocksTransferToSanctionedRecipient() public {
        _issue(alice,   KR_VASP, 100, 20);
        _issue(mallory, KR_VASP, 101, 21);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        // mallory 가 제재 명단에 등재된다
        _revoke(mallory, 200, 22);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    // ═══════════════ 0주소 예외 — 발행/소각이 막히면 안 된다 ═══════════════

    function test_BurnWorksForVerifiedHolder() public {
        _issue(alice, KR_VASP, 100, 30);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        krNote.burn(400);   // to == address(0) — isVerified(0) 를 부르면 안 된다
        assertEq(krNote.balanceOf(alice), 600);
        assertEq(krNote.totalSupply(), 600);
    }

    // ═══════════════ 데모 대본 7번 — 정책이 다른 두 토큰 ═══════════════

    /// @dev 같은 마크가 KR 노트에서는 통과하고 EU 노트에서는 거절된다.
    ///      "국제화 설계"가 서술이 아니라 실행되는 코드임을 보여주는 장면.
    function test_SameMarkPassesKrNoteButFailsEuNote() public {
        uint256 euPolicy = reg.registerPolicy(Policy({
            requireAll: EU_RWA, minAssurance: 2, maxAge: 0, requireRoster: false, exists: false
        }));
        GatedRwaNote euNote = new GatedRwaNote("EU RWA Note", "EURN", address(reg), euPolicy, owner);

        // 한국 절차로 발급 — LIVENESS·PEP 비트는 없다
        _issue(alice, KR_VASP, 100, 40);

        vm.prank(owner);
        krNote.mint(alice, 1000);                 // KR 노트: 통과
        assertEq(krNote.balanceOf(alice), 1000);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, euPolicy));
        euNote.mint(alice, 1000);                 // EU 노트: 거절
    }

    // ═══════════════ 프론트엔드 보조 ═══════════════

    function test_CanTransferPreview() public {
        _issue(alice, KR_VASP, 100, 50);
        assertFalse(krNote.canTransfer(alice, bob), "bob not verified yet");
        _issue(bob, KR_VASP, 101, 51);
        assertTrue(krNote.canTransfer(alice, bob));
    }

    // ═══════════════ 정책은 불변 ═══════════════

    function test_PolicyIdIsImmutable() public view {
        assertEq(krNote.POLICY_ID(), krPolicy);
        assertEq(address(krNote.REGISTRY()), address(reg));
    }
}
