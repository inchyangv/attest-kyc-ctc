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

/// @notice 에폭 명부에 실리는 마크의 원본 필드. 루트 대조에 필요한 만큼만.
struct RosterMark {
    bytes32 attrs;
    bytes32 claimsRoot;
    bytes32 evidenceHash;
    address issuer;
}

/// @title ProofmarkRegistry
/// @notice dApp 이 부르는 **유일한 표면**. `isVerified(subject, policyId)` 한 줄이면 된다.
/// @dev docs/03-product-plan.md §6.4·§6.5
///
/// 정책 등록은 **퍼미션리스**다 — 각 dApp 이 자기 관할·위험도에 맞는 정책을 직접 등록한다.
/// 우리는 "한국 KYC = EU KYC" 같은 등가성을 주장하지 않는다. 확인 행위(methods)를 게시할 뿐이고,
/// 통과 판정은 소비자가 자기 정책으로 한다.
contract ProofmarkRegistry {
    IProofmarkASC public immutable ASC;

    mapping(uint256 => Policy)  public policies;
    mapping(uint256 => address) public policyOwner;
    uint256 public nextPolicyId = 1;

    event PolicyRegistered(uint256 indexed policyId, address indexed owner);
    event PolicyUpdated(uint256 indexed policyId);
    event PolicyOwnerTransferred(uint256 indexed policyId, address indexed newOwner);

    error UnknownPolicy(uint256 policyId);
    error NotPolicyOwner(uint256 policyId, address caller);
    error NotImplementedYet();

    constructor(address asc) {
        require(asc != address(0), "zero asc");
        ASC = IProofmarkASC(asc);
    }

    // ─────────────────────── 정책 등록 (퍼미션리스) ───────────────────────

    function registerPolicy(Policy calldata p) external returns (uint256 policyId) {
        policyId = nextPolicyId++;
        Policy memory stored = p;
        stored.exists = true;
        policies[policyId]   = stored;
        policyOwner[policyId] = msg.sender;
        emit PolicyRegistered(policyId, msg.sender);
    }

    function updatePolicy(uint256 policyId, Policy calldata p) external {
        if (!policies[policyId].exists) revert UnknownPolicy(policyId);
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
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

    // ─────────────────────── 판정 ───────────────────────

    /// @notice 캐시 모드 — ASC 에 물질화된 상태를 읽는다. 스토리지 읽기뿐이라 싸다.
    /// @dev fail-closed: 모르면 통과가 아니라 거절이다.
    function isVerified(address subject, uint256 policyId) public view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false;                       // 미등록 정책은 통과시키지 않는다

        if (ASC.tombstone(subject)) return false;          // ① deny > allow — 항상 이긴다

        Mark memory m = ASC.getMark(subject);
        if (m.status != uint8(MarkStatus.Active)) return false;

        // ② 확인 행위 — 요구 비트가 전부 있어야 한다
        if ((m.methods & p.requireAll) != p.requireAll) return false;

        // ③ 발급사 자체 등급
        if (m.assurance < p.minAssurance) return false;

        // ④ 마크 자체의 만료
        if (m.expiry <= block.timestamp) return false;

        // ⑤ 소비자가 요구하는 신선도 상한
        if (p.maxAge != 0) {
            if (block.timestamp < m.issuedAt) return false;              // 미래 발급은 거절
            if (block.timestamp - m.issuedAt > p.maxAge) return false;
        }

        // ⑥ 출처별 신선도
        return _fresh(m, p);
    }

    /// @notice 출처에 따라 신선도 기준이 다르다.
    /// @dev Direct(개별 증명)는 에폭에 속하지 않으므로 `epoch == latestEpoch` 를 강제하면
    ///      **모든 Mode A 마크가 탈락한다.** 대신 정책이 Roster 를 요구하는지로 가른다.
    ///
    ///      Direct — "L1 블록 N 에서 발급됐다"는 증명된 과거 사실. 우리가 게시를 멈춰도 낡지 않는다.
    ///               단, 이후 폐기가 크로스체인으로 제출되지 않았으면 알 수 없다.
    ///      Roster — 에폭 시점 유효 집합 전체. 빠진 자가 폐기된 자다. 대신 에폭 주기만큼 늦다.
    function _fresh(Mark memory m, Policy memory p) internal view returns (bool) {
        if (m.origin == uint8(MarkOrigin.Roster)) {
            if (m.epoch != ASC.latestEpoch()) return false;              // 낡은 캐시는 참이 아니다
            uint40 validUntil = ASC.epochValidUntil();
            if (validUntil == 0 || block.timestamp >= validUntil) return false; // 명부 만료 → 전원 미검증
            return true;
        }
        // Direct
        return !p.requireRoster;
    }

    /// @notice 여러 주체를 한 번에 (프론트엔드 편의)
    function areVerified(address[] calldata subjects, uint256 policyId)
        external view returns (bool[] memory out)
    {
        out = new bool[](subjects.length);
        for (uint256 i = 0; i < subjects.length; ++i) out[i] = isVerified(subjects[i], policyId);
    }

    /// @notice 제재 여부 단독 조회
    function isDenied(address subject) external view returns (bool) {
        return ASC.tombstone(subject) && ASC.getMark(subject).status == uint8(MarkStatus.Denied);
    }

    // ─────────────────────── P1 ───────────────────────

    // ─────────────────────── 증명 모드 (Mode B) ───────────────────────

    /// @dev CAIP-10 형태의 네임스페이스. 비EVM 확장 여지를 남긴다.
    string public constant NAMESPACE = "eip155";

    /**
     * @notice 증명 모드 — 상태 쓰기 없이 **에폭 명부 루트에 대해** 직접 검증한다.
     *
     * 캐시 모드(`isVerified`)와의 차이:
     *   캐시  — ASC 에 물질화된 상태를 읽는다. 싸지만 개별 증명(Direct) 출처다.
     *   증명  — 에폭 시점 **유효 집합 전체**에 대한 포함 증명이다. 명부에서 빠지면 곧 폐기다.
     *
     * 명부 포함 자체가 신선도의 근거이므로, 이 경로의 출처는 정의상 Roster 다.
     * → `policy.requireRoster` 를 요구하는 고위험 dApp 이 실제로 쓸 수 있는 유일한 경로.
     */
    function verifyWithRoster(
        address subject,
        uint256 policyId,
        RosterMark calldata mark,
        RosterProof.Inclusion calldata inclusion
    ) external view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false;

        // ① 툼스톤은 명부보다 우선한다 — 긴급 폐기가 에폭 주기를 기다리지 않게 한다
        if (ASC.tombstone(subject)) return false;

        // ② 명부 자체의 신선도. 만료되면 전원 미검증 — "모르면 통과" 는 없다
        uint40 validUntil = ASC.epochValidUntil();
        if (validUntil == 0 || block.timestamp >= validUntil) return false;

        // ③ 현재 에폭 루트에 이 마크가 실려 있는가
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;

        bytes32 leaf = RosterProof.leafOf(
            RosterProof.subjectKey(NAMESPACE, subject),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        if (!RosterProof.verifyInclusion(root, leaf, inclusion)) return false;

        // ④ 마크 속성에 정책을 적용한다 (attrs 는 팩킹되어 있다)
        return _policyHolds(mark.attrs, p);
    }

    /**
     * @notice 명부에 **없다**는 것을 증명한다 — 폐기·미발급의 적극적 증거.
     * @dev 포함 증명은 쉽지만 비포함은 자료구조가 결정한다. 정렬 키 트리 + 인접 증명.
     */
    function proveNotInRoster(address subject, RosterProof.NonInclusion calldata proof)
        external view returns (bool)
    {
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;
        return RosterProof.verifyNonInclusion(root, RosterProof.subjectKey(NAMESPACE, subject), proof);
    }

    /// @dev `attrs` 팩킹에서 직접 정책을 판정한다 (MarkAttrs.sol 과 같은 레이아웃).
    function _policyHolds(bytes32 attrs, Policy memory p) private view returns (bool) {
        uint256 v = uint256(attrs);
        uint8  assurance = uint8(v >> 240);
        uint32 methods   = uint32(v >> 176);
        uint40 issuedAt  = uint40(v >> 136);
        uint40 expiry    = uint40(v >>  96);

        if ((methods & p.requireAll) != p.requireAll) return false;
        if (assurance < p.minAssurance) return false;
        if (expiry <= block.timestamp) return false;
        if (p.maxAge != 0) {
            if (block.timestamp < issuedAt) return false;
            if (block.timestamp - issuedAt > p.maxAge) return false;
        }
        return true;   // 명부 출처이므로 requireRoster 는 자동 충족
    }
}
