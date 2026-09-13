// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {KycPolicyGroth16Verifier} from "../src/zk/KycPolicyGroth16Verifier.sol";
import {ZkKycPolicyGate} from "../src/zk/ZkKycPolicyGate.sol";

contract ZkKycPolicyGateTest is Test {
    address internal constant HOLDER = address(0xA11CE);
    uint256 internal constant ROOT = 12793416525695990375282917133940433003954959674339531076250732997494611668637;
    bytes32 internal constant ACTION_DOMAIN = keccak256("proofmark.subscribe");
    uint64 internal constant EPOCH = 7;
    uint64 internal constant PROOF_DEADLINE = 2_000_000_000;
    uint64 internal constant ROOT_VALID_UNTIL = 2_100_000_000;

    KycPolicyGroth16Verifier internal verifier;
    ZkKycPolicyGate internal gate;

    function setUp() public {
        vm.warp(1_900_000_000);
        verifier = new KycPolicyGroth16Verifier();
        gate = new ZkKycPolicyGate(address(verifier), address(this), 20_260_910, 410, 392, 13_949, ACTION_DOMAIN);
        gate.anchorRoot(ROOT, EPOCH, ROOT_VALID_UNTIL);
    }

    function test_RealGroth16ProofExecutesInSolidityAndConsumesNullifier() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();

        assertTrue(verifier.verifyProof(a, b, c, signals));
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
        assertTrue(gate.nullifierUsed(signals[0]));
    }

    function test_RejectsTamperedCryptographicProof() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        // Negating C's y-coordinate keeps it on-curve but invalidates the proof.
        c[1] = 21888242871839275222246405745257275088696311157297823662689037894645226208583 - c[1];

        vm.expectRevert(ZkKycPolicyGate.InvalidProof.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
    }

    function test_RejectsCrossWalletSubmission() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();

        vm.expectRevert(ZkKycPolicyGate.HolderMismatch.selector);
        vm.prank(address(0xB0B));
        gate.verifyAndConsume(a, b, c, signals);
    }

    function test_RejectsDifferentGateEvenForSameActionDomain() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        ZkKycPolicyGate otherGate =
            new ZkKycPolicyGate(address(verifier), address(this), 20_260_910, 410, 392, 13_949, ACTION_DOMAIN);
        otherGate.anchorRoot(ROOT, EPOCH, ROOT_VALID_UNTIL);

        vm.expectRevert(ZkKycPolicyGate.ApplicationMismatch.selector);
        vm.prank(HOLDER);
        otherGate.verifyAndConsume(a, b, c, signals);
    }

    function test_ProofCryptographicallyRejectsPublicApplicationTamper() public view {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        signals[7] += 1;

        assertFalse(verifier.verifyProof(a, b, c, signals));
    }

    function test_RejectsProofOnAnotherChainId() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        vm.chainId(block.chainid + 1);

        vm.expectRevert(ZkKycPolicyGate.ApplicationMismatch.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
    }

    function test_RejectsReplayOfConsumedContextNullifier() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();

        vm.startPrank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
        vm.expectRevert(ZkKycPolicyGate.NullifierAlreadyUsed.selector);
        gate.verifyAndConsume(a, b, c, signals);
        vm.stopPrank();
    }

    function test_RejectsExplicitlyRevokedRoot() public {
        gate.revokeRoot(ROOT);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();

        vm.expectRevert(ZkKycPolicyGate.RootRevoked.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, _signals());
    }

    function test_RejectsStaleRoot() public {
        vm.warp(ROOT_VALID_UNTIL + 1);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();

        vm.expectRevert(ZkKycPolicyGate.RootStale.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, _signals());
    }

    function test_RejectsExpiredProofWhileRootIsStillFresh() public {
        vm.warp(PROOF_DEADLINE + 1);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();

        vm.expectRevert(ZkKycPolicyGate.ProofExpired.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, _signals());
    }

    function test_RejectsDeadlineBeyondAuthenticatedRootLifetime() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        signals[9] = ROOT_VALID_UNTIL + 1;

        vm.expectRevert(ZkKycPolicyGate.DeadlineBeyondRootLifetime.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
    }

    function test_RejectsPolicySubstitution() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();
        uint256[10] memory signals = _signals();
        signals[2] += 1;

        vm.expectRevert(ZkKycPolicyGate.PolicyMismatch.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, signals);
    }

    function test_RejectsProofFromSupersededEpoch() public {
        gate.anchorRoot(ROOT + 1, EPOCH + 1, ROOT_VALID_UNTIL);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proof();

        vm.expectRevert(ZkKycPolicyGate.EpochMismatch.selector);
        vm.prank(HOLDER);
        gate.verifyAndConsume(a, b, c, _signals());
    }

    function test_OnlyAuthenticatedBoundaryMayAnchorOrRevokeRoots() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(ZkKycPolicyGate.UnauthorizedRootAuthority.selector);
        gate.anchorRoot(ROOT + 1, EPOCH + 1, ROOT_VALID_UNTIL);
        vm.expectRevert(ZkKycPolicyGate.UnauthorizedRootAuthority.selector);
        gate.revokeRoot(ROOT);
        vm.stopPrank();
    }

    function test_ConstructorRejectsNonContractVerifier() public {
        vm.expectRevert(ZkKycPolicyGate.InvalidVerifier.selector);
        new ZkKycPolicyGate(address(0x1234), address(this), 20_260_910, 410, 392, 13_949, ACTION_DOMAIN);
    }

    function _proof() internal pure returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) {
        a = [
            uint256(0x16631bc14518c5f9e0dfce574e663bcf748524407dae03ad9dcbc1a229631ce0),
            uint256(0x1cb1b0282f4846c04d36141202bc84fc8b62e12f4c55471e5d43d37b5e6bda46)
        ];
        b = [
            [
                uint256(0x2583044455024938bd12e754368bae490bd787245eb1e186837c8d3530df525b),
                uint256(0x0ec66ee1b8fb66b4c29e371f8ccd8d31dd97b2730f645f3df417871498b12ff8)
            ],
            [
                uint256(0x0d291b90a27e8695413ac167c930bd9247c8e8a7e272e5f7df96f191efd2fe62),
                uint256(0x1cf7382eaea8b7f941f466f5db8a7f4e6eef155b339a00e005e1d8cab1a00ff6)
            ]
        ];
        c = [
            uint256(0x1a559a9d00520d074378e134ac21e445f91f566d2ee818c37b59941598e83134),
            uint256(0x090fe199841f8cdd4748b30477842cfa1885be0da411700eb4d70083170445a1)
        ];
    }

    function _signals() internal pure returns (uint256[10] memory signals) {
        signals = [
            uint256(3852774765118190665090046619510162823183954496283533734999687225374205521594),
            ROOT,
            uint256(20_260_910),
            uint256(410),
            uint256(392),
            uint256(13_949),
            uint256(uint160(HOLDER)),
            uint256(3250162062533471447538495730628722666881011379663305981082613662888375706148),
            uint256(EPOCH),
            uint256(PROOF_DEADLINE)
        ];
    }
}
