// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The complete interface most Creditcoin applications need from Proofmark.
interface IProofmarkRegistryConsumer {
    function isVerified(address subject, uint256 policyId) external view returns (bool);
    function policyFrozen(uint256 policyId) external view returns (bool);
}

/// @notice Copyable example: bind one application action to one immutable Proofmark policy.
/// @dev Production consumers should reject mutable policies at construction, as the deployed
///      GatedRwaNote does. The application owns the policy decision; Proofmark supplies the mark.
contract ProofmarkConsumerExample {
    IProofmarkRegistryConsumer public immutable REGISTRY;
    uint256 public immutable POLICY_ID;

    event ActionPerformed(address indexed subject);

    error PolicyMustBeFrozen(uint256 policyId);
    error SubjectNotVerified(address subject, uint256 policyId);

    constructor(address registry, uint256 policyId) {
        require(registry != address(0), "zero registry");
        if (!IProofmarkRegistryConsumer(registry).policyFrozen(policyId)) {
            revert PolicyMustBeFrozen(policyId);
        }
        REGISTRY = IProofmarkRegistryConsumer(registry);
        POLICY_ID = policyId;
    }

    function canPerform(address subject) external view returns (bool) {
        return REGISTRY.isVerified(subject, POLICY_ID);
    }

    function perform() external {
        if (!REGISTRY.isVerified(msg.sender, POLICY_ID)) {
            revert SubjectNotVerified(msg.sender, POLICY_ID);
        }
        emit ActionPerformed(msg.sender);
    }
}
