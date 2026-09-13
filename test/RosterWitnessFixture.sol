// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RosterProof} from "../src/lib/RosterProof.sol";
import {RosterMark} from "../src/ProofmarkRegistry.sol";

/// @dev Synthetic sorted complete roster and inclusion vectors, not a source completeness oracle.
library RosterWitnessFixture {
    function build(address[] memory subjects, RosterMark[] memory marks)
        internal
        pure
        returns (bytes32 root, RosterProof.Inclusion[] memory proofs)
    {
        uint256 n = subjects.length;
        uint256 count = n + 2;
        bytes32[] memory leaves = new bytes32[](count);
        uint256[] memory positions = new uint256[](n);
        bytes32[] memory keys = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            keys[i] = RosterProof.subjectKey("eip155", subjects[i]);
        }
        for (uint256 i; i < n; ++i) {
            uint256 rank = 1;
            for (uint256 j; j < n; ++j) {
                if (keys[j] < keys[i]) ++rank;
            }
            positions[i] = rank;
            RosterMark memory m = marks[i];
            leaves[rank] =
                RosterProof.leafOf(keys[i], RosterProof.markHash(m.attrs, m.claimsRoot, m.evidenceHash, m.issuer));
        }
        leaves[0] = RosterProof.leafOf(bytes32(0), bytes32(0));
        leaves[count - 1] = RosterProof.leafOf(bytes32(type(uint256).max), bytes32(0));
        uint256 depth;
        for (uint256 remaining = count; remaining > 1; remaining = (remaining + 1) / 2) {
            ++depth;
        }
        proofs = new RosterProof.Inclusion[](n);
        for (uint256 i; i < n; ++i) {
            proofs[i] = RosterProof.Inclusion(positions[i], count, new bytes32[](depth));
        }
        uint256 width = count;
        for (uint256 level; width > 1; ++level) {
            for (uint256 i; i < n; ++i) {
                uint256 sibling = positions[i] ^ 1;
                proofs[i].siblings[level] = leaves[sibling < width ? sibling : positions[i]];
                positions[i] >>= 1;
            }
            for (uint256 j; j < width; j += 2) {
                leaves[j / 2] = keccak256(abi.encodePacked(bytes1(0x01), leaves[j], leaves[j + 1 < width ? j + 1 : j]));
            }
            width = (width + 1) / 2;
        }
        return (RosterProof.rootOf(leaves[0], count), proofs);
    }
}
