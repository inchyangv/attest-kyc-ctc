// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ASCBaseX} from "./ASCBaseX.sol";
import {MarkAttrs} from "./lib/MarkAttrs.sol";
import {Action, Mark, MarkStatus, MarkOrigin} from "./lib/ProofmarkTypes.sol";

/// @title ProofmarkASC
/// @notice Creditcoin(CC3)에 배포되는 **기록의 정본**. 이더리움에서 발급된 마크를
///         Attestcoin BlockProver 로 검증해 상태로 물질화한다.
/// @dev docs/04-event-schema.md §5 · docs/05-asc-integration-review.md
///
/// ⚠️ 배포 시 `EvmV1Decoder` 라이브러리 링킹 필수 — 아래 일반 주석 참조.
//
//  forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
//    --libraries node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:<LIB_ADDR> \
//    src/ProofmarkASC.sol:ProofmarkASC --constructor-args <OWNER>
//
//  LIB_ADDR 은 우리가 직접 배포한 주소를 쓴다. 문서에 있는 CC3 Testnet "Decoder Contract"
//  (0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f) 는 우리 컴파일 산출물과 바이트코드 크기가
//  다르므로(19,199 vs 26,524 hex chars) 동일 라이브러리인지 미확인이다. 링크 불일치는
//  조용히 실패하고 8분 사이클을 태우므로, 검증 전에는 직접 배포한다.
contract ProofmarkASC is Ownable2Step, ASCBaseX {
    using MarkAttrs for bytes32;

    // ── 이벤트 시그니처 (cast keccak 실산출, docs/04 §8) ──
    bytes32 internal constant SIG_ISSUED  = 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3;
    bytes32 internal constant SIG_REVOKED = 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09;
    bytes32 internal constant SIG_DENIED  = 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae;
    bytes32 internal constant SIG_EPOCH   = 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3;

    // ── 소스 고정 (검증 ①④) ──
    /// @notice 허용되는 소스 체인. CC3 Testnet 은 1(Sepolia)·3(Ethereum) 을 동시 지원하므로 필수.
    uint64  public expectedChainKey;
    /// @notice 이벤트를 발행할 수 있는 유일한 소스 컨트랙트.
    address public sourceContract;

    // ── 상태 ──
    mapping(address => Mark)   public marks;
    /// @notice 폐기·제재 툼스톤. 어떤 에폭 루트보다 우선한다 (deny > allow).
    mapping(address => bool)   public tombstone;
    /// @notice 순서 역전 방어 커서 (검증 ⑤). blockHeight 가 필요해 ASCBaseX 를 포크했다.
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

    /// @notice 소스 체인과 소스 컨트랙트를 고정한다. 이 설정 전에는 어떤 증명도 받지 않는다.
    function configureSource(uint64 chainKey_, address sourceContract_) external onlyOwner {
        require(sourceContract_ != address(0), "zero source");
        require(chainKey_ != 0, "zero chainKey");
        expectedChainKey = chainKey_;
        sourceContract   = sourceContract_;
        emit SourceConfigured(chainKey_, sourceContract_);
    }

    // ─────────────────────── ASCBaseX 확장 지점 ───────────────────────

    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes32, /* queryId */
        bytes memory encodedTx
    ) internal override {
        if (sourceContract == address(0)) revert SourceNotConfigured();
        // ① 소스 체인 고정 — 이게 없으면 Ethereum 메인넷 증명이 통과한다 (docs/05 §1)
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

    /// @dev 영수증 검증(②) + 시그니처 필터. ASCLoanManager._validateTransactionContents 패턴.
    function _logs(bytes memory encodedTx, bytes32 sig)
        private
        pure
        returns (EvmV1Decoder.LogEntry[] memory logs)
    {
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");

        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        if (r.receiptStatus != 1) revert SourceTxFailed(); // ② 실패한 tx 배제

        logs = EvmV1Decoder.getLogsByEventSignature(r, sig);
        if (logs.length == 0) revert NoMatchingEvent();
    }

    /// @dev ④ 발행자 검증 — 빠지면 누구나 위조 이벤트를 증명해 통과시킬 수 있다.
    function _requireTrusted(EvmV1Decoder.LogEntry memory L, uint256 expectedTopics) private view {
        if (L.address_ != sourceContract) revert UntrustedEmitter(L.address_, sourceContract);
        if (L.topics.length != expectedTopics) revert BadTopics();
    }

    // ─────────────────────── 핸들러 ───────────────────────

    /// @dev ③ 전체 로그 순회 — 한 tx 의 N건을 execute() 1회로 반영 (docs/05 §3)
    function _onIssued(uint64 blockHeight, EvmV1Decoder.LogEntry[] memory logs) private {
        uint256 n = logs.length;
        for (uint256 i = 0; i < n; ++i) {
            EvmV1Decoder.LogEntry memory L = logs[i];
            _requireTrusted(L, 4); // sig + subject + attrs + issuer

            address subject = address(uint160(uint256(L.topics[1])));
            bytes32 attrs   = L.topics[2];
            address issuer  = address(uint160(uint256(L.topics[3])));
            (bytes32 claimsRoot, bytes32 evidenceHash) = abi.decode(L.data, (bytes32, bytes32));

            // ⑤ 순서 역전 방어 — 오래된 발급이 최신 폐기를 덮어쓰지 못하게
            if (blockHeight <= lastAppliedHeight[subject]) {
                emit StaleProofSkipped(subject, blockHeight, lastAppliedHeight[subject]);
                continue;
            }
            lastAppliedHeight[subject] = blockHeight;

            marks[subject] = Mark({
                status:       uint8(MarkStatus.Active),
                // 개별 증명 경로이므로 Direct. Mode B(명부) 반영 시에만 Roster 가 된다.
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

    /// @dev 폐기와 제재는 같은 형태(topics 4, data 0)라 한 핸들러로 처리한다.
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

            tombstone[subject]    = true;   // deny > allow — 이후 어떤 마크도 이긴다
            marks[subject].status = newStatus;

            emit MarkTombstoned(subject, newStatus, blockHeight);
        }
    }

    /// @dev 에폭은 한 tx 에 정확히 1건. 단조 증가를 강제한다.
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

    // ─────────────────────── 조회 ───────────────────────

    function getMark(address subject) external view returns (Mark memory) {
        return marks[subject];
    }

    /// @notice 명부 자체가 신선한가. 만료되면 전원 미검증 — "모르면 통과" 는 없다.
    function isRosterFresh() public view returns (bool) {
        return epochValidUntil != 0 && block.timestamp < epochValidUntil;
    }
}
