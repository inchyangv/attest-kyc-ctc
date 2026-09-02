// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IProofmarkRegistry {
    function isVerified(address subject, uint256 policyId) external view returns (bool);
    function policyFrozen(uint256 policyId) external view returns (bool);
}

/// @title GatedRwaNote
/// @notice A demo RWA token, a credit note, transferable only between wallets that pass a policy.
/// @dev docs/03-product-plan.md section 5.1, layer L3. This contract is where removing Attestcoin
///      becomes visible: the gate stops working.
///
/// Tokenised assets carry a legal requirement to screen holders. This contract enforces that at
/// transfer time. What backs the decision is a mark issued on Ethereum, verified through Attestcoin
/// and materialised on Creditcoin, rather than a signing server we operate.
///
/// The policy is fixed in the constructor because which policy gates the token is a property of the
/// token. Deploy one instance under a KR policy and another under an EU policy and the same mark
/// gets two different answers.
contract GatedRwaNote is ERC20, Ownable2Step {
    IProofmarkRegistry public immutable REGISTRY;

    /// @notice The compliance policy this token requires. Immutable.
    uint256 public immutable POLICY_ID;

    bool private complianceBypass;

    error SenderNotVerified(address from, uint256 policyId);
    error RecipientNotVerified(address to, uint256 policyId);
    error PolicyMustBeFrozen(uint256 policyId);

    constructor(string memory name_, string memory symbol_, address registry, uint256 policyId, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        require(registry != address(0), "zero registry");
        if (!IProofmarkRegistry(registry).policyFrozen(policyId)) revert PolicyMustBeFrozen(policyId);
        REGISTRY = IProofmarkRegistry(registry);
        POLICY_ID = policyId;
    }

    /// @notice Mint. The recipient must pass the policy; _update below enforces it.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Redeem and burn.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Compliance recovery from a holder who can no longer initiate a transfer. The
    ///         destination still has to pass policy; use forceBurn for redemption/seizure.
    function forceTransfer(address from, address to, uint256 amount) external onlyOwner {
        complianceBypass = true;
        _transfer(from, to, amount);
        complianceBypass = false;
    }

    /// @notice Forced redemption/seizure path for a blocked holder.
    function forceBurn(address from, uint256 amount) external onlyOwner {
        complianceBypass = true;
        _burn(from, amount);
        complianceBypass = false;
    }

    /// @dev OpenZeppelin 5.x routes mint (from == 0), burn (to == 0) and transfer through this hook.
    ///
    ///      Both sides are checked. Gate only the sender and a sanctioned wallet can still receive.
    ///
    ///      The zero address is exempt. Calling isVerified(address(0)) here would block every mint
    ///      and every burn.
    function _update(address from, address to, uint256 value) internal override {
        if (!complianceBypass && from != address(0) && !REGISTRY.isVerified(from, POLICY_ID)) {
            revert SenderNotVerified(from, POLICY_ID);
        }
        if (to != address(0) && !REGISTRY.isVerified(to, POLICY_ID)) {
            revert RecipientNotVerified(to, POLICY_ID);
        }
        super._update(from, to, value);
    }

    /// @notice Preflight check a frontend can use to disable the transfer button.
    function canTransfer(address from, address to) external view returns (bool) {
        return REGISTRY.isVerified(from, POLICY_ID) && REGISTRY.isVerified(to, POLICY_ID);
    }
}
