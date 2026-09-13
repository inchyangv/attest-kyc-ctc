// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Local transport fixture only, not an ASC or a substitute for native proof verification.
contract RelayReceiptFixture {
    mapping(bytes32 => bool) public processedQueries;

    function execute(bytes32 queryId, bool fail) external {
        require(!fail, "synthetic revert");
        require(!processedQueries[queryId], "already processed");
        processedQueries[queryId] = true;
    }
}
