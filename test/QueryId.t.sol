// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ASCBaseX} from "../src/ASCBaseX.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";

/// @dev Test-only harness that exposes `_computeQueryId`.
contract QueryIdHarness is ASCBaseX {
    function _processAndEmitEvent(uint8, uint64, uint64, uint64, bytes memory) internal pure override {}

    function computeQueryId(
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (bytes32) {
        return _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
    }
}

/// @notice Pins the queryId byte layout.
/// @dev The worker computes the same value off chain and calls `processedQueries(queryId)` before
///      submitting, so it never burns gas on an already-processed query. That requires an exact match.
///      The assembly came straight from the original ASCBase; this test checks our reading of it.
contract QueryIdTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    QueryIdHarness h;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        h = new QueryIdHarness();
    }

    /// @dev Assembly layout, 72 bytes total:
    ///        [0  .. 32)  uint256(chainKey)
    ///         [32 .. 40)  uint64  blockHeight  (big-endian, 8 bytes)
    ///        [40 .. 72)  uint256(txIndex)
    function testFuzz_QueryIdLayoutMatchesPacked(uint64 chainKey, uint64 blockHeight, bytes32 root) public view {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);

        // MockBlockProver returns the low 32 bits of root as txIndex
        uint256 txIndex = uint256(root) & 0xffffffff;

        bytes32 expected = keccak256(abi.encodePacked(uint256(chainKey), blockHeight, txIndex));

        assertEq(h.computeQueryId(chainKey, blockHeight, root, sib), expected);
    }

    /// @dev Fixed vector. The TypeScript worker is checked against this value.
    function test_QueryIdKnownVector() public view {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32 root = bytes32(uint256(0x0000000000000000000000000000000000000000000000000000000000000007));

        bytes32 got = h.computeQueryId(1, 11597452, root, sib);
        bytes32 want = keccak256(abi.encodePacked(uint256(1), uint64(11597452), uint256(7)));

        assertEq(got, want);
        // the worker unit test hardcodes this value and compares
        assertEq(got, 0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159);
    }
}
