// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ASCBaseX} from "./ASCBaseX.sol";
import {MarkAttrs} from "./lib/MarkAttrs.sol";
import {Action, Mark, MarkStatus, MarkOrigin} from "./lib/ProofmarkTypes.sol";

/// @title ProofmarkASC
/// @notice The chain of record, deployed on Creditcoin CC3. Verifies marks issued on Ethereum
///         through the Attestcoin BlockProver and materialises them into state.
/// @dev docs/04-event-schema.md section 5, docs/05-asc-integration-review.md
///
/// Deployment requires linking the `EvmV1Decoder` library. See the note below.
//
//  forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
//    --libraries node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:<LIB_ADDR> \
//    src/ProofmarkASC.sol:ProofmarkASC --constructor-args <OWNER>
//
//  Use a LIB_ADDR you deployed yourself. The "Decoder Contract" listed for CC3 Testnet
//  (0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f) has a different runtime size from our build
//  (19,199 vs 26,524 hex chars), so we have not confirmed it is the same library. A bad link
//  fails quietly and costs an eight-minute attestation cycle to discover.
contract ProofmarkASC is Ownable2Step, ASCBaseX {
    using MarkAttrs for bytes32;

    // Event signatures, computed with cast keccak. See docs/04 section 8.
    bytes32 internal constant SIG_ISSUED  = 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3;
    bytes32 internal constant SIG_REVOKED = 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09;
    bytes32 internal constant SIG_DENIED  = 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae;
    bytes32 internal constant SIG_EPOCH   = 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3;

    // Source pinning, checks 1 and 4
    /// @notice The one source chain accepted. CC3 Testnet serves both 1 (Sepolia) and 3 (Ethereum).
    uint64  public expectedChainKey;
    /// @notice The only contract whose events this ASC will act on.
    address public sourceContract;

    // State
    mapping(address => Mark)   public marks;
    /// @notice Revocation and sanction tombstones. Outrank every epoch root: deny beats allow.
    mapping(address => bool)   public tombstone;
    /// @notice Ordering cursor, check 5. Needing blockHeight here is why ASCBaseX exists.
    mapping(address => uint64) public lastAppliedHeight;

    mapping(uint32 => bytes32) public epochRoots;
    uint32 public latestEpoch;
    uint40 public epochValidUntil;

    event SourceConfigured(uint64 chainKey, address sourceContract);
    event MarkMaterialized(address indexed subject, bytes32 attrs, uint64 blockHeight);
    event MarkTombstoned(address indexed subject, uint8 status, uint64 blockHeight);
    event EpochAccepted(uint32 indexed epoch, bytes32 root, uint40 validUntil);
    event StaleProofSkipped(address indexed subject, uint64 blockHeight, uint64 lastApplied);

    error SourceNotConfigured();
    error UnexpectedChainKey(uint64 got, uint64 want);
    error UntrustedEmitter(address got, address want);
    error SourceTxFailed();
    error NoMatchingEvent();
    error BadTopics();
    error EpochNotMonotonic(uint32 given, uint32 latest);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Pins the source chain and contract. No proof is accepted before this is set.
    function configureSource(uint64 chainKey_, address sourceContract_) external onlyOwner {
        require(sourceContract_ != address(0), "zero source");
        require(chainKey_ != 0, "zero chainKey");
        expectedChainKey = chainKey_;
        sourceContract   = sourceContract_;
        emit SourceConfigured(chainKey_, sourceContract_);
    }

    // ASCBaseX extension point

    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32, /* queryId */
        bytes memory encodedTx
    ) internal override {
        if (sourceContract == address(0)) revert SourceNotConfigured();
        // 1. pin the source chain. Without this an Ethereum mainnet proof passes. docs/05 section 1
        if (chainKey != expectedChainKey) revert UnexpectedChainKey(chainKey, expectedChainKey);

        if (action == uint8(Action.MarkIssued)) {
            _onIssued(blockHeight, _logs(encodedTx, SIG_ISSUED));
        } else if (action == uint8(Action.MarkRevoked)) {
            _onTombstone(blockHeight, _logs(encodedTx, SIG_REVOKED), uint8(MarkStatus.Revoked));
        } else if (action == uint8(Action.SanctionDenied)) {
            _onTombstone(blockHeight, _logs(encodedTx, SIG_DENIED), uint8(MarkStatus.Denied));
        } else if (action == uint8(Action.RosterEpoch)) {
            _onEpoch(_logs(encodedTx, SIG_EPOCH));
        } else {
            revert InvalidAction(action);
        }
    }

    /// @dev Receipt check (2) and signature filter, following ASCLoanManager._validateTransactionContents.
    function _logs(bytes memory encodedTx, bytes32 sig)
        private
        pure
        returns (EvmV1Decoder.LogEntry[] memory logs)
    {
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");

        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        if (r.receiptStatus != 1) revert SourceTxFailed(); // 2. reject failed source transactions

        logs = EvmV1Decoder.getLogsByEventSignature(r, sig);
        if (logs.length == 0) revert NoMatchingEvent();
    }

    /// @dev 4. emitter check. Without it anyone can prove a forged event and get it accepted.
    function _requireTrusted(EvmV1Decoder.LogEntry memory L, uint256 expectedTopics) private view {
        if (L.address_ != sourceContract) revert UntrustedEmitter(L.address_, sourceContract);
        if (L.topics.length != expectedTopics) revert BadTopics();
    }

    // Handlers

    /// @dev 3. walk every matching log, so one execute() applies N entries from a single tx. docs/05 section 3
    function _onIssued(uint64 blockHeight, EvmV1Decoder.LogEntry[] memory logs) private {
        uint256 n = logs.length;
        for (uint256 i = 0; i < n; ++i) {
            EvmV1Decoder.LogEntry memory L = logs[i];
            _requireTrusted(L, 4); // sig + subject + attrs + issuer

            address subject = address(uint160(uint256(L.topics[1])));
            bytes32 attrs   = L.topics[2];
            address issuer  = address(uint160(uint256(L.topics[3])));
            (bytes32 claimsRoot, bytes32 evidenceHash) = abi.decode(L.data, (bytes32, bytes32));

            // 5. ordering guard: an older issuance must not overwrite a newer revocation
            if (blockHeight <= lastAppliedHeight[subject]) {
                emit StaleProofSkipped(subject, blockHeight, lastAppliedHeight[subject]);
                continue;
            }
            lastAppliedHeight[subject] = blockHeight;

            marks[subject] = Mark({
                status:       uint8(MarkStatus.Active),
                // Direct, because this is the individual-proof path. Only Mode B sets Roster.
                origin:       uint8(MarkOrigin.Direct),
                kind:         attrs.kind(),
                assurance:    attrs.assurance(),
                regime:       attrs.regime(),
                jurisdiction: attrs.jurisdiction(),
                methods:      attrs.methods(),
                issuedAt:     attrs.issuedAt(),
                expiry:       attrs.expiry(),
                epoch:        attrs.epoch(),
                claimsRoot:   claimsRoot,
                evidenceHash: evidenceHash,
                issuer:       issuer
            });

            emit MarkMaterialized(subject, attrs, blockHeight);
        }
    }

    /// @dev Revocation and sanction share a shape (4 topics, no data), so one handler covers both.
    function _onTombstone(uint64 blockHeight, EvmV1Decoder.LogEntry[] memory logs, uint8 newStatus) private {
        uint256 n = logs.length;
        for (uint256 i = 0; i < n; ++i) {
            EvmV1Decoder.LogEntry memory L = logs[i];
            _requireTrusted(L, 4);

            address subject = address(uint160(uint256(L.topics[1])));

            if (blockHeight <= lastAppliedHeight[subject]) {
                emit StaleProofSkipped(subject, blockHeight, lastAppliedHeight[subject]);
                continue;
            }
            lastAppliedHeight[subject] = blockHeight;

            tombstone[subject]    = true;   // deny beats allow, and outlives any later mark
            marks[subject].status = newStatus;

            emit MarkTombstoned(subject, newStatus, blockHeight);
        }
    }

    /// @dev Exactly one epoch per transaction. Epochs must increase.
    function _onEpoch(EvmV1Decoder.LogEntry[] memory logs) private {
        EvmV1Decoder.LogEntry memory L = logs[0];
        _requireTrusted(L, 4); // sig + epoch + root + listVersion

        uint32  epoch      = uint32(uint256(L.topics[1]));
        bytes32 root       = L.topics[2];
        uint40  validUntil = uint40(abi.decode(L.data, (uint256)));

        if (epoch <= latestEpoch) revert EpochNotMonotonic(epoch, latestEpoch);

        epochRoots[epoch] = root;
        latestEpoch       = epoch;
        epochValidUntil   = validUntil;

        emit EpochAccepted(epoch, root, validUntil);
    }

    // Views

    function getMark(address subject) external view returns (Mark memory) {
        return marks[subject];
    }

    /// @notice Whether the roster itself is fresh. Once it expires nobody verifies. There is no
    ///         "unknown means allowed" here.
    function isRosterFresh() public view returns (bool) {
        return epochValidUntil != 0 && block.timestamp < epochValidUntil;
    }
}
