// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ComplianceSource} from "../src/ComplianceSource.sol";

/// @dev T-10 integration fixture. This is a real allow-listed contract issuer on the isolated
///      source EVM, exercising the same cross-call composition boundary as a smart account.
contract T10ComposingIssuer {
    function issueTwice(ComplianceSource source, address subject, bytes32 firstAttrs, bytes32 secondAttrs) external {
        ComplianceSource.Issuance[] memory items = new ComplianceSource.Issuance[](2);
        items[0] = ComplianceSource.Issuance(subject, firstAttrs, bytes32(uint256(1)), bytes32(uint256(11)));
        items[1] = ComplianceSource.Issuance(subject, secondAttrs, bytes32(uint256(2)), bytes32(uint256(22)));
        source.issueBatch(items);
    }

    function issueThenRevoke(ComplianceSource source, address subject, bytes32 attrs) external {
        source.issue(subject, attrs, bytes32(uint256(3)), bytes32(uint256(33)));
        source.revoke(subject, 2, 1);
    }

    function publishTwice(
        ComplianceSource source,
        uint40 sourceCutoff,
        uint40 validUntil,
        bytes32 firstRoot,
        bytes32 secondRoot
    ) external {
        source.publishEpoch(1, firstRoot, 1, validUntil, sourceCutoff, bytes32(uint256(101)));
        source.publishEpoch(2, secondRoot, 1, validUntil, sourceCutoff, bytes32(uint256(102)));
    }
}
