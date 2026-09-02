// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Mark, Policy, MarkStatus, MarkOrigin} from "./lib/ProofmarkTypes.sol";
import {RosterProof} from "./lib/RosterProof.sol";

interface IProofmarkASC {
    function getMark(address subject) external view returns (Mark memory);
    function tombstone(address subject) external view returns (bool);
    function latestEpoch() external view returns (uint32);
    function epochValidUntil() external view returns (uint40);
    function epochRoots(uint32 epoch) external view returns (bytes32);
}

/// @notice Raw mark fields as carried in the epoch roster. Only what root comparison needs.
struct RosterMark {
    bytes32 attrs;
    bytes32 claimsRoot;
    bytes32 evidenceHash;
    address issuer;
}

/// @title ProofmarkRegistry
/// @notice The only surface a dApp calls. One line: `isVerified(subject, policyId)`.
/// @dev docs/03-product-plan.md §6.4·§6.5
///
/// Policy registration is permissionless. Each dApp registers what its own jurisdiction and risk
/// appetite require. We make no equivalence claim between Korean and EU KYC. We publish the checks
/// that were performed; the consumer decides whether they satisfy its policy.
contract ProofmarkRegistry {
    IProofmarkASC public immutable ASC;

    mapping(uint256 => Policy) public policies;
    mapping(uint256 => address) public policyOwner;
    mapping(uint256 => bool) public policyFrozen;
    uint256 public nextPolicyId = 1;

    event PolicyRegistered(uint256 indexed policyId, address indexed owner);
    event PolicyUpdated(uint256 indexed policyId);
    event PolicyOwnerTransferred(uint256 indexed policyId, address indexed newOwner);
    event PolicyFrozen(uint256 indexed policyId);

    error UnknownPolicy(uint256 policyId);
    error NotPolicyOwner(uint256 policyId, address caller);
    error FrozenPolicy(uint256 policyId);
    error NotImplementedYet();

    constructor(address asc) {
        require(asc != address(0), "zero asc");
        ASC = IProofmarkASC(asc);
    }

    // Policy registration, permissionless

    function registerPolicy(Policy calldata p) external returns (uint256 policyId) {
        policyId = nextPolicyId++;
        Policy memory stored = p;
        stored.exists = true;
        policies[policyId] = stored;
        policyOwner[policyId] = msg.sender;
        emit PolicyRegistered(policyId, msg.sender);
    }

    function updatePolicy(uint256 policyId, Policy calldata p) external {
        if (!policies[policyId].exists) revert UnknownPolicy(policyId);
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        if (policyFrozen[policyId]) revert FrozenPolicy(policyId);
        Policy memory stored = p;
        stored.exists = true;
        policies[policyId] = stored;
        emit PolicyUpdated(policyId);
    }

    function transferPolicyOwner(uint256 policyId, address newOwner) external {
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        require(newOwner != address(0), "zero owner");
        policyOwner[policyId] = newOwner;
        emit PolicyOwnerTransferred(policyId, newOwner);
    }

    /// @notice Permanently freezes a policy. A gated asset can then bind to immutable policy
    ///         content, not merely an immutable numeric id.
    function freezePolicy(uint256 policyId) external {
        if (!policies[policyId].exists) revert UnknownPolicy(policyId);
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        policyFrozen[policyId] = true;
        emit PolicyFrozen(policyId);
    }

    // Decision

    /// @notice Cache mode. Reads state the ASC already materialised. A storage read, so it is cheap.
    /// @dev Fail closed. Unknown is a rejection, not a pass.
    function isVerified(address subject, uint256 policyId) public view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false; // an unregistered policy never passes

        if (ASC.tombstone(subject)) return false; // 1. deny beats allow, always

        Mark memory m = ASC.getMark(subject);
        if (m.status != uint8(MarkStatus.Active)) return false;

        // 2. required check bits must all be present
        if ((m.methods & p.requireAll) != p.requireAll) return false;

        // 3. issuer's own assurance grade
        if (m.assurance < p.minAssurance) return false;

        // 4. policy context. A sandbox or foreign-regime mark cannot satisfy a production policy
        //    merely because its method bits happen to match.
        if (p.requiredRegime != 0 && m.regime != p.requiredRegime) return false;
        if (p.requiredJurisdiction != 0 && m.jurisdiction != p.requiredJurisdiction) return false;
        if (p.trustedIssuer != address(0) && m.issuer != p.trustedIssuer) return false;

        // 5. the mark's own expiry
        if (m.expiry <= block.timestamp) return false;

        // 6. freshness ceiling the consumer asked for
        if (p.maxAge != 0) {
            if (block.timestamp < m.issuedAt) return false; // reject a mark issued in the future
            if (block.timestamp - m.issuedAt > p.maxAge) return false;
        }

        // 7. freshness by provenance
        return _fresh(m, p);
    }

    /// @notice Freshness depends on where the mark came from.
    /// @dev A Direct mark belongs to no epoch, so enforcing `epoch == latestEpoch` would fail every
    ///      Mode A mark. The policy decides instead, through requireRoster.
    ///
    ///      Direct: proof the mark was issued at L1 block N. It does not go stale when we stop
    ///              publishing, but it also cannot see a revocation that was never submitted.
    ///      Roster: the full valid set at an epoch. Whoever is missing has been revoked. Costs one
    function _fresh(Mark memory m, Policy memory p) internal view returns (bool) {
        if (m.origin == uint8(MarkOrigin.Roster)) {
            if (m.epoch != ASC.latestEpoch()) return false; // a stale cache is not a truth
            uint40 validUntil = ASC.epochValidUntil();
            if (validUntil == 0 || block.timestamp >= validUntil) return false; // roster expired, so nobody verifies
            return true;
        }
        // Direct
        return !p.requireRoster;
    }

    /// @notice Several subjects at once, for frontend convenience.
    function areVerified(address[] calldata subjects, uint256 policyId) external view returns (bool[] memory out) {
        out = new bool[](subjects.length);
        for (uint256 i = 0; i < subjects.length; ++i) {
            out[i] = isVerified(subjects[i], policyId);
        }
    }

    /// @notice Sanction status on its own.
    function isDenied(address subject) external view returns (bool) {
        return ASC.tombstone(subject) && ASC.getMark(subject).status == uint8(MarkStatus.Denied);
    }

    // ─────────────────────── P1 ───────────────────────

    // Proof mode, Mode B

    /// @dev CAIP-10 style namespace, leaving room for non-EVM subjects.
    string public constant NAMESPACE = "eip155";

    /**
     * @notice Proof mode. Verifies directly against an epoch roster root, writing no state.
     *
     * How it differs from cache mode (`isVerified`):
     *   cache: reads state the ASC materialised. Cheap, but the provenance is an individual proof.
     *   proof: membership in the full valid set at that epoch. Falling out of the roster is revocation.
     *
     * Roster membership is itself the freshness argument, so this path is Roster by definition.
     * It is the only path a high-risk dApp requiring `policy.requireRoster` can actually use.
     */
    function verifyWithRoster(
        address subject,
        uint256 policyId,
        RosterMark calldata mark,
        RosterProof.Inclusion calldata inclusion
    ) external view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false;

        // 1. tombstones outrank the roster, so an urgent revocation need not wait for the next epoch
        if (ASC.tombstone(subject)) return false;

        // 2. roster freshness. Once expired nobody verifies; unknown is never a pass.
        uint40 validUntil = ASC.epochValidUntil();
        if (validUntil == 0 || block.timestamp >= validUntil) return false;

        // 3. is this mark carried in the current epoch root
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;

        bytes32 leaf = RosterProof.leafOf(
            RosterProof.subjectKey(NAMESPACE, subject),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        if (!RosterProof.verifyInclusion(root, leaf, inclusion)) return false;

        // 4. apply the policy to the mark attributes, which arrive packed
        return _policyHolds(mark.attrs, mark.issuer, p);
    }

    /**
     * @notice Proves absence from the roster: positive evidence of revocation or never-issued.
     * @dev Membership is easy; non-membership is decided by the data structure. Sorted-key tree
     */
    function proveNotInRoster(address subject, RosterProof.NonInclusion calldata proof) external view returns (bool) {
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;
        return RosterProof.verifyNonInclusion(root, RosterProof.subjectKey(NAMESPACE, subject), proof);
    }

    /// @dev Applies the policy straight from packed `attrs`, same layout as MarkAttrs.sol.
    function _policyHolds(bytes32 attrs, address issuer, Policy memory p) private view returns (bool) {
        uint256 v = uint256(attrs);
        uint8 assurance = uint8(v >> 240);
        uint16 regime = uint16(v >> 224);
        uint16 jurisdiction = uint16(v >> 208);
        uint32 methods = uint32(v >> 176);
        uint40 issuedAt = uint40(v >> 136);
        uint40 expiry = uint40(v >> 96);

        if ((methods & p.requireAll) != p.requireAll) return false;
        if (assurance < p.minAssurance) return false;
        if (p.requiredRegime != 0 && regime != p.requiredRegime) return false;
        if (p.requiredJurisdiction != 0 && jurisdiction != p.requiredJurisdiction) return false;
        if (p.trustedIssuer != address(0) && issuer != p.trustedIssuer) return false;
        if (expiry <= block.timestamp) return false;
        if (p.maxAge != 0) {
            if (block.timestamp < issuedAt) return false;
            if (block.timestamp - issuedAt > p.maxAge) return false;
        }
        return true; // roster provenance, so requireRoster is satisfied by construction
    }
}
