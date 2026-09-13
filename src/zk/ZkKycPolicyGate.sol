// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IKycPolicyGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[10] calldata publicSignals
    ) external view returns (bool);
}

/// @notice Experimental gate for the kyc_policy.circom Groth16 statement.
/// @dev Root publication is deliberately an explicit authenticated boundary.
///      The authority in the local fixture stands in for a future independently
///      authenticated provider -> active-set root pipeline. It is not an
///      Attestcoin propagation integration.
contract ZkKycPolicyGate {
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 public constant NULLIFIER_INDEX = 0;
    uint256 public constant ROOT_INDEX = 1;
    uint256 public constant POLICY_ID_INDEX = 2;
    uint256 public constant COUNTRY_A_INDEX = 3;
    uint256 public constant COUNTRY_B_INDEX = 4;
    uint256 public constant MAX_BIRTH_DAY_INDEX = 5;
    uint256 public constant HOLDER_INDEX = 6;
    uint256 public constant APPLICATION_ID_INDEX = 7;
    uint256 public constant EPOCH_INDEX = 8;
    uint256 public constant DEADLINE_INDEX = 9;

    struct RootRecord {
        uint64 epoch;
        uint64 validUntil;
        bool anchored;
        bool revoked;
    }

    IKycPolicyGroth16Verifier public immutable verifier;
    address public immutable sourceRootAuthority;
    uint64 public immutable policyId;
    uint16 public immutable allowedCountryA;
    uint16 public immutable allowedCountryB;
    uint32 public immutable maxBirthDay;
    bytes32 public immutable actionDomain;

    uint64 public currentEpoch;
    mapping(uint256 root => RootRecord) public roots;
    mapping(uint256 nullifier => bool) public nullifierUsed;

    error InvalidVerifier();
    error InvalidSourceRootAuthority();
    error UnauthorizedRootAuthority();
    error InvalidRoot();
    error InvalidRootLifetime();
    error EpochNotIncreasing();
    error RootNotAnchored();
    error RootRevoked();
    error RootStale();
    error EpochMismatch();
    error PolicyMismatch();
    error HolderMismatch();
    error ApplicationMismatch();
    error ProofExpired();
    error DeadlineBeyondRootLifetime();
    error NullifierAlreadyUsed();
    error InvalidProof();

    event RootAnchored(uint256 indexed root, uint64 indexed epoch, uint64 validUntil);
    event RootRevokedEvent(uint256 indexed root, uint64 indexed epoch);
    event ProofConsumed(uint256 indexed nullifier, address indexed holder, uint256 indexed applicationId, uint64 epoch);

    constructor(
        address verifier_,
        address sourceRootAuthority_,
        uint64 policyId_,
        uint16 allowedCountryA_,
        uint16 allowedCountryB_,
        uint32 maxBirthDay_,
        bytes32 actionDomain_
    ) {
        if (verifier_.code.length == 0) revert InvalidVerifier();
        if (sourceRootAuthority_ == address(0)) revert InvalidSourceRootAuthority();
        verifier = IKycPolicyGroth16Verifier(verifier_);
        sourceRootAuthority = sourceRootAuthority_;
        policyId = policyId_;
        allowedCountryA = allowedCountryA_;
        allowedCountryB = allowedCountryB_;
        maxBirthDay = maxBirthDay_;
        actionDomain = actionDomain_;
    }

    /// @notice Authenticate an active, unrevoked credential-set commitment.
    function anchorRoot(uint256 root, uint64 epoch, uint64 validUntil) external {
        if (msg.sender != sourceRootAuthority) revert UnauthorizedRootAuthority();
        if (root == 0 || root >= SNARK_SCALAR_FIELD) revert InvalidRoot();
        if (epoch <= currentEpoch) revert EpochNotIncreasing();
        if (validUntil <= block.timestamp) revert InvalidRootLifetime();

        roots[root] = RootRecord({epoch: epoch, validUntil: validUntil, anchored: true, revoked: false});
        currentEpoch = epoch;
        emit RootAnchored(root, epoch, validUntil);
    }

    function revokeRoot(uint256 root) external {
        if (msg.sender != sourceRootAuthority) revert UnauthorizedRootAuthority();
        RootRecord storage record = roots[root];
        if (!record.anchored) revert RootNotAnchored();
        record.revoked = true;
        emit RootRevokedEvent(root, record.epoch);
    }

    /// @notice Circuit field binding this chain, this gate, and its concrete action.
    function expectedApplicationId() public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), actionDomain))) % SNARK_SCALAR_FIELD;
    }

    /// @notice Verify eligibility and consume this context-specific presentation.
    function verifyAndConsume(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[10] calldata publicSignals
    ) external {
        uint256 root = publicSignals[ROOT_INDEX];
        RootRecord memory record = roots[root];
        if (!record.anchored) revert RootNotAnchored();
        if (record.revoked) revert RootRevoked();
        if (block.timestamp > record.validUntil) revert RootStale();
        if (publicSignals[EPOCH_INDEX] != currentEpoch || record.epoch != currentEpoch) revert EpochMismatch();

        if (
            publicSignals[POLICY_ID_INDEX] != policyId || publicSignals[COUNTRY_A_INDEX] != allowedCountryA
                || publicSignals[COUNTRY_B_INDEX] != allowedCountryB
                || publicSignals[MAX_BIRTH_DAY_INDEX] != maxBirthDay
        ) revert PolicyMismatch();
        if (publicSignals[HOLDER_INDEX] != uint160(msg.sender)) revert HolderMismatch();
        uint256 applicationId = expectedApplicationId();
        if (publicSignals[APPLICATION_ID_INDEX] != applicationId) revert ApplicationMismatch();

        uint256 deadline = publicSignals[DEADLINE_INDEX];
        if (deadline < block.timestamp) revert ProofExpired();
        if (deadline > record.validUntil) revert DeadlineBeyondRootLifetime();

        uint256 nullifier = publicSignals[NULLIFIER_INDEX];
        if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed();
        if (!verifier.verifyProof(a, b, c, publicSignals)) revert InvalidProof();

        nullifierUsed[nullifier] = true;
        emit ProofConsumed(nullifier, msg.sender, applicationId, record.epoch);
    }
}
