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

/// @notice Checks the demo script in docs/03-product-plan.md section 10 actually runs.
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

    // Helpers

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

    // Demo scenes 6 and 8: the full lifecycle

    /// @dev Unverified reverts, issuance succeeds, revocation blocks again.
    ///      Exactly the `GatedRwaNote` definition of done from section 9.1.
    function test_DemoLifecycle_BlockedThenAllowedThenBlockedAgain() public {
        // 1. an unverified recipient cannot even be minted to
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, krPolicy));
        krNote.mint(alice, 1000);

        // 2. once issued, minting works
        _issue(alice, KR_VASP, 100, 1);
        _issue(bob,   KR_VASP, 101, 2);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        assertEq(krNote.balanceOf(alice), 1000);

        // 3. verified wallets can transfer to each other
        vm.prank(alice);
        krNote.transfer(bob, 400);
        assertEq(krNote.balanceOf(bob), 400);

        // 4. after revocation the same transfer is blocked
        _revoke(alice, 200, 3);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.SenderNotVerified.selector, alice, krPolicy));
        krNote.transfer(bob, 100);

        assertEq(krNote.balanceOf(alice), 600, "balance must be untouched");
    }

    // Both sides are checked

    /// @dev Only the recipient is unverified. Gate one side and a sanctioned wallet can still receive.
    function test_BlocksTransferToUnverifiedRecipient() public {
        _issue(alice, KR_VASP, 100, 10);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    /// @dev Sending to a sanctioned recipient is blocked too.
    function test_BlocksTransferToSanctionedRecipient() public {
        _issue(alice,   KR_VASP, 100, 20);
        _issue(mallory, KR_VASP, 101, 21);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        // mallory lands on a sanctions list
        _revoke(mallory, 200, 22);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    // Zero address exemption: mint and burn must not be blocked

    function test_BurnWorksForVerifiedHolder() public {
        _issue(alice, KR_VASP, 100, 30);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        krNote.burn(400);   // to == address(0); isVerified(0) must not be called
        assertEq(krNote.balanceOf(alice), 600);
        assertEq(krNote.totalSupply(), 600);
    }

    // Demo scene 7: two tokens, two policies

    /// @dev The same mark passes on the KR note and is rejected on the EU note.
    ///      The portability claim is executable here, not just described.
    function test_SameMarkPassesKrNoteButFailsEuNote() public {
        uint256 euPolicy = reg.registerPolicy(Policy({
            requireAll: EU_RWA, minAssurance: 2, maxAge: 0, requireRoster: false, exists: false
        }));
        GatedRwaNote euNote = new GatedRwaNote("EU RWA Note", "EURN", address(reg), euPolicy, owner);

        // issued through the Korean flow
        _issue(alice, KR_VASP, 100, 40);

        vm.prank(owner);
        krNote.mint(alice, 1000);                 // KR note: passes
        assertEq(krNote.balanceOf(alice), 1000);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, euPolicy));
        euNote.mint(alice, 1000);                 // EU note: rejected
    }

    // Frontend helper

    function test_CanTransferPreview() public {
        _issue(alice, KR_VASP, 100, 50);
        assertFalse(krNote.canTransfer(alice, bob), "bob not verified yet");
        _issue(bob, KR_VASP, 101, 51);
        assertTrue(krNote.canTransfer(alice, bob));
    }

    // The policy is immutable

    function test_PolicyIdIsImmutable() public view {
        assertEq(krNote.POLICY_ID(), krPolicy);
        assertEq(address(krNote.REGISTRY()), address(reg));
    }
}
