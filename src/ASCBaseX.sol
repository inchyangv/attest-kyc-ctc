// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "./lib/VerifierInterface.sol";

/// @title ASCBaseX
/// @notice A fork of Attestcoin's `ASCBase`. Proof verification, queryId derivation and replay
///         protection follow the original exactly; the handler additionally receives `chainKey`
///         and `blockHeight`.
///
/// @dev Why the fork. See docs/05-asc-integration-review.md sections 1 and 2.
///
///  original: _processAndEmitEvent(action, queryId, encodedTransaction)
///  fork:     _processAndEmitEvent(action, chainKey, blockHeight, queryId, encodedTransaction)
///
///  Without chainKey the handler cannot pin the source chain. CC3 Testnet supports chainKey 1
///  (Sepolia) and 3 (Ethereum mainnet) at the same time, so checking log.address_ alone still
///  accepts a forged event from a same-address contract on the other chain. CREATE2 deployment
///  makes that address collision cheap to arrange.
///
///  Without blockHeight the handler cannot order anything. Proof submission is permissionless
///  and unordered, so an old MarkIssued submitted after a MarkRevoked resurrects a dead mark.
///
///  The verification path itself (verifyAndEmit, _computeQueryId, processedQueries) is left
///  untouched.
abstract contract ASCBaseX {
    /// @notice BlockProver precompile at 0x...0FD2
    INativeQueryVerifier public immutable VERIFIER;

    /// @notice Replay guard. queryId = keccak256(chainKey, blockHeight, txIndex)
    mapping(bytes32 => bool) public processedQueries;

    error InvalidAction(uint8 action);

    constructor() {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
    }

    /// @notice The only extension point a derived contract implements.
    /// @param action        Action code supplied by the caller, not derived from the proof.
    ///                      A mismatch must revert rather than fall through.
    /// @param chainKey      Source chain the proof verified against. Not present in the original.
    /// @param blockHeight   Source chain block height. Not present in the original.
    /// @param queryId       keccak256(chainKey, blockHeight, txIndex)
    /// @param encodedTransaction ABI-encoded source transaction and receipt
    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 queryId,
        bytes memory encodedTransaction
    ) internal virtual;

    /// @notice Verifies a proof and runs the action. Permissionless by design: anyone may call it.
    /// @dev A third party can push state forward when the issuer does not.
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

    /// @dev Must stay byte-identical to the original ASCBase. Do not change.
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
