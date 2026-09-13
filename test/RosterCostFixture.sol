// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RosterProof} from "../src/lib/RosterProof.sol";

/// @dev Local proof-algorithm measurement only. Not a Registry, source or native verifier.
contract RosterCostFixture {
    mapping(address => bytes32) public witnesses;

    function inclusion(bytes32 root, bytes32 leaf, RosterProof.Inclusion calldata proof) external pure returns (bool) {
        return RosterProof.verifyInclusion(root, leaf, proof);
    }

    function absence(bytes32 root, bytes32 key, RosterProof.NonInclusion calldata proof) external pure returns (bool) {
        return RosterProof.verifyNonInclusion(root, key, proof);
    }

    /// @dev Storage-cost boundary for a proof-sized witness. This is intentionally not presented
    /// as ProofmarkRegistry gas: Registry policy/ASC/native-verifier calls are outside the fixture.
    function cache(address subject, bytes32 root, bytes32 leaf, RosterProof.Inclusion calldata proof) external {
        require(RosterProof.verifyInclusion(root, leaf, proof), "invalid proof");
        witnesses[subject] = keccak256(abi.encode(root, leaf, proof.index));
    }
}
