// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";

/// @notice Pins byte-level agreement with `pipeline/roster.ts`.
/// @dev TypeScript generated the vectors from a five-entry roster. Fix one side and this breaks.
contract RosterProofTest is Test {
    bytes32 constant ROOT = 0xfd1fc0f9cc82c72c2771bc978ffdb61676508d3778f2499d27279be6f5c03297;

    function test_SubjectKeyMatchesTypeScript() public pure {
        assertEq(
            RosterProof.subjectKey("eip155", address(3)),
            0x56e9d29e372019a030d4fac130c1c688f76c50149e9529718c02033e791d86e5
        );
    }

    function test_MarkHashMatchesTypeScript() public pure {
        assertEq(
            RosterProof.markHash(
                bytes32(uint256(3) << 200),
                keccak256("claims3"),
                keccak256("ev3"),
                0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
            ),
            0xda136b54716e639e957e205498fb6c5406b5c77a4a1e1d11a4dda9a221209be4
        );
    }

    function test_VerifyInclusion() public pure {
        bytes32[] memory sib = new bytes32[](3);
        sib[0] = 0xaecb2e865064c20000b9ddc0621ebee5deb52b2482fd2f7ae2fbe3894d742b1d;
        sib[1] = 0xcab431567059010cfd298dbc39438843a528d4efd760c574240f68890400edac;
        sib[2] = 0x7fbc6b57150d781bd7d8498cba0b7f4fe2cdb2afc01c4765816f4ac470c394f4;

        RosterProof.Inclusion memory p = RosterProof.Inclusion({index: 3, leafCount: 7, siblings: sib});
        bytes32 leaf = 0x050d0d386055a3f8c2254fa608426547ff72c10cb4a77052c3a4d9ec250e608a;

        assertTrue(RosterProof.verifyInclusion(ROOT, leaf, p));
        assertFalse(RosterProof.verifyInclusion(ROOT, keccak256("fake"), p), "a forged leaf passed");
    }

    function _nonInclusion() private pure returns (RosterProof.NonInclusion memory) {
        bytes32[] memory ls = new bytes32[](3);
        ls[0] = 0x76da52501097479dcea5f0dd0a17f4329b9e2082cf31985ba096d6b824725894;
        ls[1] = 0x6bdebc48add0843090eff238c07744471faeca1d7c8569be7ed005f1f12b4244;
        ls[2] = 0xba30721859d681be0eb1e66f28d160a3309359e7842db4ade5c30ce42757a827;

        bytes32[] memory rs = new bytes32[](3);
        rs[0] = 0x9c1ee289e03d80d15a778d11d4159ca8444fbb86ddb1433b09a069e81c6179d8;
        rs[1] = 0xc58b31c0121c7e112c3f103c1a3bc8d5cb2bf91270e1e82e433a20f1885d0fc2;
        rs[2] = 0xba30721859d681be0eb1e66f28d160a3309359e7842db4ade5c30ce42757a827;

        return RosterProof.NonInclusion({
            left: RosterProof.Inclusion({index: 5, leafCount: 7, siblings: ls}),
            leftKey: 0xa43c201135cfef37d7be83630438e9c6af9e5ba946c85c47447e0ee967b02772,
            leftMark: 0x78935246536b71d758f03be218147b414eed21cd155c64a3c7034ac585b70f91,
            right: RosterProof.Inclusion({index: 6, leafCount: 7, siblings: rs}),
            rightKey: bytes32(type(uint256).max),
            rightMark: bytes32(0)
        });
    }

    /// @dev Non-membership verifies for a subject absent from the roster, which is how revocation is expressed
    function test_VerifyNonInclusion() public pure {
        bytes32 targetKey = 0xf546978472b6cbaee6c96f8f5afc15c2ee71e09339a97cae2e243cda496b9b96;
        assertTrue(RosterProof.verifyNonInclusion(ROOT, targetKey, _nonInclusion()));
    }

    /// @dev Reject when the target does not fall between the two keys
    function test_RejectsTargetOutsideGap() public pure {
        bytes32 outside = 0x0000000000000000000000000000000000000000000000000000000000000001;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, outside, _nonInclusion()));
    }

    /// @dev Reject when the leaves are not adjacent. Without this a forged gap that skips entries passes.
    function test_RejectsNonAdjacentLeaves() public pure {
        RosterProof.NonInclusion memory p = _nonInclusion();
        p.right.index = p.left.index + 2; // break adjacency
        bytes32 targetKey = 0xf546978472b6cbaee6c96f8f5afc15c2ee71e09339a97cae2e243cda496b9b96;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, targetKey, p), "non-adjacent leaves passed");
    }

    /// @dev Regression for the key/leaf binding flaw: a valid leaf cannot be relabelled with a
    ///      different ordering key to manufacture a gap around a subject that is present.
    function test_RejectsRelabelledBoundaryKey() public pure {
        RosterProof.NonInclusion memory p = _nonInclusion();
        p.leftKey = bytes32(0); // still bounds the target, but no longer hashes to the proved leaf
        bytes32 targetKey = 0xf546978472b6cbaee6c96f8f5afc15c2ee71e09339a97cae2e243cda496b9b96;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, targetKey, p), "relabelled leaf passed");
    }

    function test_SentinelConstantsMatchTypeScript() public pure {
        assertEq(RosterProof.MIN_KEY, bytes32(0));
        assertEq(RosterProof.MAX_KEY, bytes32(type(uint256).max));
    }

    function test_RejectsDepthSizeAndIndexForgery() public pure {
        RosterProof.NonInclusion memory p = _nonInclusion();
        bytes32 leaf = RosterProof.leafOf(p.leftKey, p.leftMark);
        p.left.index += 8; // Same path bits, but outside the seven-leaf tree.
        assertFalse(RosterProof.verifyInclusion(ROOT, leaf, p.left));
        p = _nonInclusion();
        p.left.leafCount = 8; // Same depth, different committed size.
        assertFalse(RosterProof.verifyInclusion(ROOT, leaf, p.left));
        p = _nonInclusion();
        p.left.siblings = new bytes32[](0);
        assertFalse(RosterProof.verifyInclusion(ROOT, leaf, p.left));
        p.left.index = 0;
        p.left.leafCount = 1;
        assertFalse(RosterProof.verifyInclusion(RosterProof.rootOf(leaf, 1), leaf, p.left));
    }

    function test_RejectsReviewExploitAgainstLegacyRoot() public pure {
        bytes32[] memory ls = new bytes32[](2);
        ls[0] = 0xbb18114919f158d7c2b3f1895fe76e2e67dc753800ac843eda5479d4fdbfd75d;
        ls[1] = 0xa09637336041ba36b37e6a41cb44622df981df1b35506054ef79a3cf75f4f59a;
        bytes32[] memory rs = new bytes32[](1);
        rs[0] = 0xee435ed92c2d049d1ab2ab0c480df0eaa5f35376441b38f789754b706878ede0;
        RosterProof.NonInclusion memory p = RosterProof.NonInclusion({
            left: RosterProof.Inclusion(0, 4, ls),
            leftKey: bytes32(0),
            leftMark: bytes32(0),
            right: RosterProof.Inclusion(1, 4, rs),
            rightKey: 0x9e1dc5ce841b03a33bab09d4a206c67a0afe3d7f0aab857a58ced05925237d45,
            rightMark: 0xbbd6e7dddd4326dd7c827841ab9733c6e3fcdf38a516374bd10feec8f674ea8a
        });
        assertFalse(
            RosterProof.verifyNonInclusion(
                0xfe6cf3e0fc518c85ec822fd119fa8291461ff5fc1e0a5d6dbe6be1e7e8f5364d,
                RosterProof.subjectKey("eip155", 0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2),
                p
            )
        );
    }

    function test_LeafCannotBeAnInternalNode() public pure {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 internalNode = keccak256(abi.encodePacked(bytes1(0x01), a, b));
        assertNotEq(RosterProof.leafOf(a, b), internalNode);
    }

    function test_RejectsMalformedOddTailAndOverflowWithoutRevert() public pure {
        RosterProof.NonInclusion memory p = _nonInclusion();
        p.right.siblings[0] = bytes32(0);
        assertFalse(RosterProof.verifyInclusion(ROOT, RosterProof.leafOf(p.rightKey, p.rightMark), p.right));
        p = _nonInclusion();
        p.left.index = type(uint256).max;
        p.right.index = 0;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, bytes32(type(uint256).max - 1), p));
    }
}
