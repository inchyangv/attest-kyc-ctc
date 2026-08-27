// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "./lib/VerifierInterface.sol";

/// @title ASCBaseX
/// @notice Attestcoin `ASCBase` 의 포크. 증명 검증·queryId·재생 방지 로직은 원본을 그대로 따르되,
///         핸들러에 `chainKey` 와 `blockHeight` 를 **추가로 전달**한다.
///
/// @dev 포크 사유 — docs/05-asc-integration-review.md §1·§2
///
///  원본: _processAndEmitEvent(action, queryId, encodedTransaction)
///  포크: _processAndEmitEvent(action, chainKey, blockHeight, queryId, encodedTransaction)
///
///  ① chainKey 미전달 → 소스 체인을 고정할 수 없다. CC3 Testnet 은 chainKey 1(Sepolia)과
///     3(Ethereum 메인넷)을 동시에 지원하므로, log.address_ 검증만으로는 다른 체인의
///     동일 주소 컨트랙트가 발행한 위조 이벤트를 막지 못한다 (CREATE2 결정적 배포 시 현실적 위험).
///  ② blockHeight 미전달 → 순서 보장 불가. 증명 제출은 permissionless 이고 순서 강제가 없어
///     오래된 MarkIssued 를 나중에 제출해 폐기된 마크를 되살릴 수 있다.
///
///  검증 로직 자체(verifyAndEmit·_computeQueryId·processedQueries)는 **원본을 신뢰하고 손대지 않는다.**
abstract contract ASCBaseX {
    /// @notice BlockProver 프리컴파일 (0x…0FD2)
    INativeQueryVerifier public immutable VERIFIER;

    /// @notice 재생 방지 — queryId = keccak256(chainKey, blockHeight, txIndex)
    mapping(bytes32 => bool) public processedQueries;

    error InvalidAction(uint8 action);

    constructor() {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
    }

    /// @notice 파생 컨트랙트가 구현하는 유일한 확장 지점.
    /// @param action        호출자가 지정한 액션 코드 (증명에서 유도되지 않음 — 불일치 시 안전하게 revert)
    /// @param chainKey      증명이 검증된 소스 체인 (★ 원본에는 없음)
    /// @param blockHeight   소스 체인 블록 높이 (★ 원본에는 없음)
    /// @param queryId       (chainKey, blockHeight, txIndex) 해시
    /// @param encodedTransaction RLP 인코딩된 소스 트랜잭션 + 영수증
    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 queryId,
        bytes memory encodedTransaction
    ) internal virtual;

    /// @notice 증명을 검증하고 액션을 실행한다. **permissionless** — 누구나 호출할 수 있다.
    /// @dev 발급사가 게을러도 제3자가 상태를 반영할 수 있게 하려는 의도적 설계.
    function execute(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (bool success) {
        bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);

        require(!processedQueries[queryId], "Query already processed");

        bool verified = _verifyProof(
            chainKey, blockHeight, encodedTransaction, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
        require(verified, "Proof of inclusion verification failed");

        processedQueries[queryId] = true;

        _processAndEmitEvent(action, chainKey, blockHeight, queryId, encodedTransaction);

        return true;
    }

    function _verifyProof(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) internal returns (bool verified) {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        verified = VERIFIER.verifyAndEmit(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);
    }

    /// @dev 원본 ASCBase 와 **바이트 단위로 동일한** 계산이어야 한다. 수정 금지.
    function _computeQueryId(
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) internal view returns (bytes32 queryId) {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

        uint256 txIndex = VERIFIER.calculateTxIndex(merkleProof);

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainKey)
            mstore(add(ptr, 32), shl(192, blockHeight))
            mstore(add(ptr, 40), txIndex)
            queryId := keccak256(ptr, 72)
        }
    }
}
