// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ComplianceSource} from "./ComplianceSource.sol";

/// @notice Stable source issuer address with separately recoverable operating keys.
/// @dev Candidate for NEW deployments. Suspension stops new source writes/signatures, NOT
/// historical hub credentials unless declareCompromise carries an approved source-block cutoff.
/// No legal identity or asset migration is implied.
contract RotatingIssuer is Ownable2Step, EIP712, IERC1271 {
    uint256 public constant ISSUER_KEY_VERSION = 1;
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("IssuerApproval(bytes32 sourceDigest,uint64 keyEpoch)");
    ComplianceSource public immutable SOURCE;
    address public operatingKey;
    address public pendingKey;
    uint64 public keyEpoch = 1;
    bool public suspended;
    mapping(address => bool) public usedKey;

    event KeyProposed(address indexed key, uint64 indexed previousEpoch);
    event KeyActivated(address indexed previousKey, address indexed key, uint64 indexed epoch);
    event IssuerSuspended(address indexed retiredKey, uint64 indexed epoch, bytes32 reasonHash);
    event IssuerCompromiseDeclared(
        address indexed retiredKey, uint64 indexed retiredEpoch, uint64 lastTrustedBlock, bytes32 reasonHash
    );
    error InvalidKey();
    error InactiveKey();
    error WrongKeyEpoch();
    error InvalidSource();
    error RenunciationDisabled();
    error MissingReason();

    constructor(address recoveryOwner, address initialKey, address source)
        Ownable(recoveryOwner)
        EIP712("ProofmarkIssuer", "1")
    {
        if (source.code.length == 0) revert InvalidSource();
        SOURCE = ComplianceSource(source);
        if (
            SOURCE.ATTRS_SCHEMA_VERSION() != 0 || SOURCE.EPOCH_SCHEMA_VERSION() != 2
                || SOURCE.ROSTER_AUTH_VERSION() != 1 || SOURCE.ISSUER_KEY_PROVENANCE_VERSION() != 1
        ) {
            revert InvalidSource();
        }
        if (initialKey == address(0) || initialKey == recoveryOwner) revert InvalidKey();
        operatingKey = initialKey;
        usedKey[initialKey] = true;
        emit KeyActivated(address(0), initialKey, 1);
    }

    modifier currentKey(uint64 expectedEpoch) {
        if (suspended || msg.sender != operatingKey) revert InactiveKey();
        if (expectedEpoch != keyEpoch) revert WrongKeyEpoch();
        _;
    }

    /// @dev Proposal does not disable the old key. Use suspend first for a suspected compromise.
    function proposeKey(address next) external onlyOwner {
        if (next == address(0) || usedKey[next] || next == owner() || next == pendingOwner()) revert InvalidKey();
        pendingKey = next;
        emit KeyProposed(next, keyEpoch);
    }

    function cancelKeyProposal() external onlyOwner {
        pendingKey = address(0);
        emit KeyProposed(address(0), keyEpoch);
    }

    function acceptKey(uint64 expectedEpoch) external {
        if (msg.sender != pendingKey || pendingKey == address(0)) revert InvalidKey();
        if (expectedEpoch != keyEpoch) revert WrongKeyEpoch();
        address previous = operatingKey;
        operatingKey = pendingKey;
        pendingKey = address(0);
        usedKey[operatingKey] = true;
        suspended = false;
        ++keyEpoch;
        emit KeyActivated(previous, operatingKey, keyEpoch);
    }

    /// @notice New source actions stop immediately; a fresh, never-used key must accept recovery.
    /// @dev reasonHash is an opaque incident reference, not PII or an adjudicated legal reason.
    function suspend(bytes32 reasonHash) external onlyOwner {
        _suspend(reasonHash);
    }

    /// @notice Atomically records a historical cutoff on the source and retires the current key.
    /// @dev lastTrustedBlock is a governance input backed by incident evidence, not inferred here.
    function declareCompromise(bytes32 reasonHash, uint64 lastTrustedBlock) external onlyOwner {
        address retired = operatingKey;
        uint64 retiredEpoch = keyEpoch;
        SOURCE.declareIssuerKeyCompromise(retiredEpoch, lastTrustedBlock, reasonHash);
        _suspend(reasonHash);
        emit IssuerCompromiseDeclared(retired, retiredEpoch, lastTrustedBlock, reasonHash);
    }

    function _suspend(bytes32 reasonHash) private {
        if (reasonHash == bytes32(0)) revert MissingReason();
        address retired = operatingKey;
        operatingKey = address(0);
        pendingKey = address(0);
        suspended = true;
        ++keyEpoch;
        emit IssuerSuspended(retired, keyEpoch, reasonHash);
    }

    function transferOwnership(address next) public override onlyOwner {
        if (next != address(0) && (usedKey[next] || next == pendingKey)) revert InvalidKey();
        super.transferOwnership(next);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenunciationDisabled();
    }

    /// @dev A previous recovery owner cannot leave a pending key activation for its successor.
    function _transferOwnership(address next) internal override {
        if (pendingKey != address(0)) {
            pendingKey = address(0);
            emit KeyProposed(address(0), keyEpoch);
        }
        super._transferOwnership(next);
    }

    function issueOnce(
        uint64 expectedEpoch,
        bytes32 requestId,
        address subject,
        bytes32 attrs,
        bytes32 claimsRoot,
        bytes32 evidenceHash
    ) external currentKey(expectedEpoch) {
        SOURCE.issueOnceWithKey(requestId, subject, attrs, claimsRoot, evidenceHash, expectedEpoch);
    }

    function revoke(uint64 expectedEpoch, address subject, uint16 reasonCode, uint32 epoch)
        external
        currentKey(expectedEpoch)
    {
        SOURCE.revoke(subject, reasonCode, epoch);
    }

    function deny(uint64 expectedEpoch, address subject, uint32 listVersion, uint32 epoch)
        external
        currentKey(expectedEpoch)
    {
        SOURCE.deny(subject, listVersion, epoch);
    }

    function approvalDigest(bytes32 sourceDigest, uint64 epoch) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, sourceDigest, epoch)));
    }

    /// @dev Signature wire format: uint64 big-endian epoch || 65-byte low-s ECDSA signature.
    /// Domain binds this contract and chain; sourceDigest binds source, publisher and exact root.
    function isValidSignature(bytes32 sourceDigest, bytes calldata signature) external view returns (bytes4) {
        if (suspended || signature.length != 73 || !SOURCE.isIssuer(address(this))) return 0xffffffff;
        uint64 epoch = uint64(bytes8(signature[:8]));
        if (epoch != keyEpoch) return 0xffffffff;
        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(approvalDigest(sourceDigest, epoch), signature[8:]);
        return error == ECDSA.RecoverError.NoError && recovered == operatingKey
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}
