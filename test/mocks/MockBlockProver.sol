// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier} from "../../src/lib/VerifierInterface.sol";

/// @notice BlockProver 프리컴파일(0x…0FD2) 모의 구현. `vm.etch` 로 주입한다.
/// @dev 상태를 쓰지 않는다(pure) — etch 시 대상 스토리지가 비어 있어도 안전하다.
///      docs/03-product-plan.md 의 P0 "로컬 모의 BlockProver 하네스".
///      어테스트 8분 대기 없이 ASC 전 로직을 검증하는 것이 목적이다.
contract MockBlockProver {
    /// @dev 항상 검증 성공. 우리가 테스트하려는 건 증명 산술이 아니라 **ASC 의 방어 로직**이다.
    function verifyAndEmit(
        uint64, uint64, bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }

    /// @dev merkleRoot 에서 txIndex 를 유도한다 → 서로 다른 root 는 서로 다른 queryId 를 만든다.
    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata p) external pure returns (uint64) {
        return uint64(uint256(p.root) & 0xffffffff);
    }
}

/// @notice 증명 검증이 실패하는 경우
contract MockBlockProverFailing {
    function verifyAndEmit(
        uint64, uint64, bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return false;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata p) external pure returns (uint64) {
        return uint64(uint256(p.root) & 0xffffffff);
    }
}
