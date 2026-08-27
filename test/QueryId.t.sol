// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ASCBaseX} from "../src/ASCBaseX.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";

/// @dev `_computeQueryId` 를 외부에 노출하는 테스트 전용 하네스
contract QueryIdHarness is ASCBaseX {
    function _processAndEmitEvent(uint8, uint64, uint64, bytes32, bytes memory) internal pure override {}

    function computeQueryId(
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (bytes32) {
        return _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
    }
}

/// @notice queryId 바이트 레이아웃을 고정한다.
/// @dev 워커가 오프체인에서 같은 값을 계산해 `processedQueries(queryId)` 를 미리 조회하고
///      이미 처리된 쿼리에 가스를 태우지 않게 하려면, 레이아웃이 정확히 일치해야 한다.
///      원본 ASCBase 의 assembly 를 그대로 옮겼으므로 이 테스트가 그 해석을 검증한다.
contract QueryIdTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    QueryIdHarness h;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        h = new QueryIdHarness();
    }

    /// @dev assembly 레이아웃 (총 72바이트):
    ///        [0  .. 32)  uint256(chainKey)
    ///        [32 .. 40)  uint64  blockHeight  (big-endian 8바이트)
    ///        [40 .. 72)  uint256(txIndex)
    function testFuzz_QueryIdLayoutMatchesPacked(uint64 chainKey, uint64 blockHeight, bytes32 root) public view {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);

        // MockBlockProver 는 root 하위 32비트를 txIndex 로 돌려준다
        uint256 txIndex = uint256(root) & 0xffffffff;

        bytes32 expected = keccak256(
            abi.encodePacked(uint256(chainKey), blockHeight, txIndex)
        );

        assertEq(h.computeQueryId(chainKey, blockHeight, root, sib), expected);
    }

    /// @dev 고정 벡터 — 워커(TypeScript)가 같은 값을 내는지 대조하는 기준점.
    function test_QueryIdKnownVector() public view {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32 root = bytes32(uint256(0x0000000000000000000000000000000000000000000000000000000000000007));

        bytes32 got = h.computeQueryId(1, 11597452, root, sib);
        bytes32 want = keccak256(abi.encodePacked(uint256(1), uint64(11597452), uint256(7)));

        assertEq(got, want);
        // 워커 유닛테스트가 이 값을 하드코딩해 대조한다
        assertEq(got, 0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159);
    }
}
