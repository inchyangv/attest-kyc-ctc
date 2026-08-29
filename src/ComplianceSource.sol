// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ComplianceSource
/// @notice The origin of issuance, deployed on Ethereum Sepolia. Emits only purpose-built events meant to be read cross-chain.
/// @dev docs/04-event-schema.md §3·§6
///
/// Hard rule: one transaction emits one kind of ASC event.
/// ASCBase derives queryId from (chainKey, blockHeight, txIndex). It carries neither the action
/// nor the log index, so a source transaction gets exactly one execute(). Mixing event kinds in one
/// transaction lets an attacker land the cheap action first, consume the queryId, and permanently
/// seal the other events in that transaction. execute() is permissionless.
/// Do not add convenience functions that combine operations. Epoch publication is always its own tx.
contract ComplianceSource is Ownable2Step {
    // Events. See docs/04 section 3.

    /// @dev sig 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3
    event MarkIssued(
        address indexed subject,
        bytes32 indexed attrs,   // eight scalar fields packed by MarkAttrs
        address indexed issuer,
        bytes32 claimsRoot,
        bytes32 evidenceHash
    );

    /// @dev sig 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09
    event MarkRevoked(address indexed subject, uint16 indexed reasonCode, uint32 indexed epoch);

    /// @dev sig 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae
    event SanctionDenied(address indexed subject, uint32 indexed listVersion, uint32 indexed epoch);

    /// @dev sig 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3
    event RosterEpochPublished(uint32 indexed epoch, bytes32 indexed root, uint32 indexed listVersion, uint40 validUntil);

    // Operational events. Not read cross-chain; the ASC ignores them.
    event IssuerSet(address indexed account, bool allowed);
    event EpochPublisherSet(address indexed account, bool allowed);

    // State

    mapping(address => bool) public isIssuer;
    mapping(address => bool) public isEpochPublisher;

    /// @notice Last published epoch. The source enforces monotonicity as a first line of defence.
    uint32 public lastEpoch;

    error NotIssuer(address caller);
    error NotEpochPublisher(address caller);
    error LengthMismatch();
    error EpochNotMonotonic(uint32 given, uint32 last);
    error ZeroSubject();

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    modifier onlyEpochPublisher() {
        if (!isEpochPublisher[msg.sender]) revert NotEpochPublisher(msg.sender);
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    // Roles. Three separate keys: owner, issuer, epoch publisher.

    function setIssuer(address account, bool allowed) external onlyOwner {
        isIssuer[account] = allowed;
        emit IssuerSet(account, allowed);
    }

    function setEpochPublisher(address account, bool allowed) external onlyOwner {
        isEpochPublisher[account] = allowed;
        emit EpochPublisherSet(account, allowed);
    }

    // Issuance, action 0

    struct Issuance {
        address subject;
        bytes32 attrs;
        bytes32 claimsRoot;
        bytes32 evidenceHash;
    }

    function issue(address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        emit MarkIssued(subject, attrs, msg.sender, claimsRoot, evidenceHash);
    }

    /// @notice Emit N issuances in one transaction; the ASC applies all of them in a single execute().
    /// @dev N marks per cross-chain round trip of about eight minutes. This is batching without
    function issueBatch(Issuance[] calldata items) external onlyIssuer {
        uint256 n = items.length;
        for (uint256 i = 0; i < n; ++i) {
            if (items[i].subject == address(0)) revert ZeroSubject();
            emit MarkIssued(items[i].subject, items[i].attrs, msg.sender, items[i].claimsRoot, items[i].evidenceHash);
        }
    }

    // Revocation, action 1

    function revoke(address subject, uint16 reasonCode, uint32 epoch) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        emit MarkRevoked(subject, reasonCode, epoch);
    }

    /// @notice The event carries no data, which makes batch revocation cheap.
    function revokeBatch(address[] calldata subjects, uint16[] calldata reasonCodes, uint32 epoch)
        external
        onlyIssuer
    {
        uint256 n = subjects.length;
        if (n != reasonCodes.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; ++i) {
            if (subjects[i] == address(0)) revert ZeroSubject();
            emit MarkRevoked(subjects[i], reasonCodes[i], epoch);
        }
    }

    // Sanction, action 2

    function deny(address subject, uint32 listVersion, uint32 epoch) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        emit SanctionDenied(subject, listVersion, epoch);
    }

    function denyBatch(address[] calldata subjects, uint32 listVersion, uint32 epoch) external onlyIssuer {
        uint256 n = subjects.length;
        for (uint256 i = 0; i < n; ++i) {
            if (subjects[i] == address(0)) revert ZeroSubject();
            emit SanctionDenied(subjects[i], listVersion, epoch);
        }
    }

    // Epoch publication, action 3

    /// @notice Publishes a roster root. Always its own transaction; never mixed with other events.
    /// @dev Fixes L1 writes independent of user count. The real driver for batching is Ethereum L1
    ///      gas, not the Creditcoin write cost, which measured 0.0002 CTC and is negligible.
    function publishEpoch(uint32 epoch, bytes32 root, uint32 listVersion, uint40 validUntil)
        external
        onlyEpochPublisher
    {
        if (epoch <= lastEpoch) revert EpochNotMonotonic(epoch, lastEpoch);
        lastEpoch = epoch;
        emit RosterEpochPublished(epoch, root, listVersion, validUntil);
    }
}
