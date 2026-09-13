// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Structural bounds on a publisher assertion, not proof of roster/list completeness.
library EpochBounds {
    uint256 internal constant MAX_AGE = 1 days;
    uint256 internal constant MAX_PUBLICATION_LAG = 1 hours;

    function valid(bytes32 root, uint40 cutoff, uint40 publishedAt, uint40 validUntil, bytes32 snapshotId)
        internal
        pure
        returns (bool)
    {
        return root != bytes32(0) && snapshotId != bytes32(0) && cutoff != 0 && cutoff <= publishedAt
            && uint256(publishedAt) - cutoff <= MAX_PUBLICATION_LAG && validUntil > publishedAt
            && uint256(validUntil) - cutoff <= MAX_AGE;
    }
}
