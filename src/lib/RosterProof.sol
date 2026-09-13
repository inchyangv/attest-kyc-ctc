// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title RosterProof
/// @notice Membership and non-membership proofs against an epoch roster, a sorted-key Merkle tree.
/// @dev Must stay byte-identical to `pipeline/roster.ts`.
///      `test/RosterProof.t.sol` checks it against vectors the TypeScript side produced.
///
/// Positional Merkle, not OpenZeppelin's sorted-pair hashing. Sorted pairs discard position,
/// so you cannot prove two leaves are adjacent, and without adjacency there is no non-membership.
library RosterProof {
    /// @dev Sentinels at both ends. Every non-membership becomes one adjacency proof, so there is
    ///      no separate case for "is this the last leaf" to get wrong.
    bytes32 internal constant MIN_KEY = bytes32(0);
    bytes32 internal constant MAX_KEY = bytes32(type(uint256).max);

    uint256 internal constant FORMAT_VERSION = 2;

    struct Inclusion {
        uint256 index;
        uint256 leafCount; // Includes both sentinels; committed into the published root.
        bytes32[] siblings;
    }

    /// @notice Non-membership: the gap between two adjacent leaves
    struct NonInclusion {
        Inclusion left;
        bytes32 leftKey;
        bytes32 leftMark;
        Inclusion right;
        bytes32 rightKey;
        bytes32 rightMark;
    }

    function subjectKey(string memory namespace, address subject) internal pure returns (bytes32) {
        return keccak256(abi.encode(namespace, subject));
    }

    function markHash(bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash, address issuer)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(attrs, claimsRoot, evidenceHash, issuer));
    }

    function leafOf(bytes32 key, bytes32 mark) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), key, mark));
    }

    /// @dev Positional. Left and right are not sorted.
    function _node(bytes32 l, bytes32 r) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    /// @notice The published commitment binds tree shape as well as leaf contents.
    function rootOf(bytes32 treeRoot, uint256 leafCount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x02), leafCount, treeRoot));
    }

    function verifyInclusion(bytes32 root, bytes32 leaf, Inclusion memory p) internal pure returns (bool) {
        if (p.leafCount < 2 || p.index >= p.leafCount || p.siblings.length > 256) return false;
        bytes32 acc = leaf;
        uint256 idx = p.index;
        uint256 width = p.leafCount;
        for (uint256 i = 0; i < p.siblings.length; i++) {
            if (width <= 1) return false; // Too many levels.
            // Odd tails are duplicated by the builder; no invented padding leaf is allowed.
            if ((idx ^ 1) >= width && p.siblings[i] != acc) return false;
            acc = idx % 2 == 0 ? _node(acc, p.siblings[i]) : _node(p.siblings[i], acc);
            idx >>= 1;
            width = width / 2 + width % 2;
        }
        return width == 1 && idx == 0 && rootOf(acc, p.leafCount) == root;
    }

    /// @notice Verifies the subject is absent from the roster.
    function verifyNonInclusion(bytes32 root, bytes32 targetKey, NonInclusion memory p) internal pure returns (bool) {
        // 1. the subject falls between the two keys
        if (!(p.leftKey < targetKey && targetKey < p.rightKey)) return false;
        // 2. the leaves are consecutive. Without this a forged gap that skips entries passes.
        if (p.left.index == type(uint256).max || p.right.index != p.left.index + 1) return false;
        if (p.left.leafCount != p.right.leafCount || p.left.siblings.length != p.right.siblings.length) return false;
        // 3. bind each claimed ordering key to the leaf proved in the tree. Accepting a caller-
        //    supplied leaf independently of its key lets an attacker relabel adjacent real leaves
        //    around a target that is actually present.
        bytes32 leftLeaf = leafOf(p.leftKey, p.leftMark);
        bytes32 rightLeaf = leafOf(p.rightKey, p.rightMark);
        return verifyInclusion(root, leftLeaf, p.left) && verifyInclusion(root, rightLeaf, p.right);
    }
}
