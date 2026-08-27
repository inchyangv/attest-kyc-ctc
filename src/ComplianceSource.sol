// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ComplianceSource
/// @notice 이더리움(Sepolia)에 배포되는 **발급의 원본**. 크로스체인으로 읽히는 전용 이벤트만 발행한다.
/// @dev docs/04-event-schema.md §3·§6
///
/// ⚠️ 하드 룰 — **한 트랜잭션은 한 종류의 ASC 이벤트만 emit 한다.**
///    ASCBase 의 queryId 는 (chainKey, blockHeight, txIndex) 로 계산되어 액션·로그인덱스를
///    포함하지 않는다. 따라서 소스 tx 1건당 execute() 는 1회뿐이다. 한 tx 에 서로 다른 종류를
///    섞으면 공격자가 싼 액션을 먼저 성공시켜 queryId 를 소비하고, 같은 tx 의 다른 이벤트를
///    **영구 봉인**할 수 있다 (execute 는 permissionless).
///    → 복합 연산용 편의 함수를 만들지 말 것. 에폭 게시는 항상 독립 tx.
contract ComplianceSource is Ownable2Step {
    // ─────────────────────────── 이벤트 (docs/04 §3) ───────────────────────────

    /// @dev sig 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3
    event MarkIssued(
        address indexed subject,
        bytes32 indexed attrs,        // MarkAttrs 팩킹 스칼라 8필드
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

    // 운영 이벤트 (크로스체인 대상 아님 — ASC 가 읽지 않는다)
    event IssuerSet(address indexed account, bool allowed);
    event EpochPublisherSet(address indexed account, bool allowed);

    // ─────────────────────────── 상태 ───────────────────────────

    mapping(address => bool) public isIssuer;
    mapping(address => bool) public isEpochPublisher;

    /// @notice 마지막으로 게시된 에폭. 단조 증가를 소스에서 1차 강제한다.
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

    // ─────────────────────────── 권한 (키 3분리: owner / issuer / epoch) ───────────────────────────

    function setIssuer(address account, bool allowed) external onlyOwner {
        isIssuer[account] = allowed;
        emit IssuerSet(account, allowed);
    }

    function setEpochPublisher(address account, bool allowed) external onlyOwner {
        isEpochPublisher[account] = allowed;
        emit EpochPublisherSet(account, allowed);
    }

    // ─────────────────────────── 발급 (액션 0) ───────────────────────────

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

    /// @notice 한 tx 에 N개 발급 → ASC 가 execute() 1회로 전부 반영한다.
    /// @dev 크로스체인 왕복(≈8분) 1회로 N건. verifyBatch 없이 얻는 배치 (docs/05 §3)
    function issueBatch(Issuance[] calldata items) external onlyIssuer {
        uint256 n = items.length;
        for (uint256 i = 0; i < n; ++i) {
            if (items[i].subject == address(0)) revert ZeroSubject();
            emit MarkIssued(items[i].subject, items[i].attrs, msg.sender, items[i].claimsRoot, items[i].evidenceHash);
        }
    }

    // ─────────────────────────── 폐기 (액션 1) ───────────────────────────

    function revoke(address subject, uint16 reasonCode, uint32 epoch) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        emit MarkRevoked(subject, reasonCode, epoch);
    }

    /// @notice data 가 0바이트라 배치 폐기가 매우 싸다.
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

    // ─────────────────────────── 제재 (액션 2) ───────────────────────────

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

    // ─────────────────────────── 에폭 게시 (액션 3) ───────────────────────────

    /// @notice 명부 루트 게시. **항상 독립 tx** — 다른 이벤트와 섞지 않는다 (하드 룰).
    /// @dev L1 쓰기를 사용자 수와 무관하게 고정시키는 경로. 배치의 진짜 근거는
    ///      Creditcoin 쓰기 비용(0.0002 CTC, 무시 가능)이 아니라 **이더리움 L1 발급 가스**다.
    function publishEpoch(uint32 epoch, bytes32 root, uint32 listVersion, uint40 validUntil)
        external
        onlyEpochPublisher
    {
        if (epoch <= lastEpoch) revert EpochNotMonotonic(epoch, lastEpoch);
        lastEpoch = epoch;
        emit RosterEpochPublished(epoch, root, listVersion, validUntil);
    }
}
