// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry, RosterMark} from "../src/ProofmarkRegistry.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, Policy, Methods, Mark, MarkStatus} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";
import {SchemaVectors} from "./SchemaVectors.sol";

contract ProofmarkRegistryTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    uint64 constant SEPOLIA_KEY = 1;

    /// KR VASP policy: document authenticity, bank account, sanctions screening
    uint32 constant KR_VASP = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
    /// EU RWA policy: liveness, sanctions, PEP
    uint32 constant EU_RWA = Methods.LIVENESS | Methods.SANCTIONS_SCREENED | Methods.PEP_SCREENED;

    ProofmarkASC asc;
    ProofmarkRegistry reg;
    ComplianceSource src;
    ReceiptFixture fx;

    address owner = address(0xA11CE);
    address issuer = address(0x1554E4);
    address alice = address(0xA11);
    address dapp = address(0xDA99);

    uint40 constant ISSUED_AT = 1_700_000_000;
    uint40 constant EXPIRY = 1_800_000_000;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        vm.warp(ISSUED_AT + 1 days);

        fx = new ReceiptFixture();
        src = new ComplianceSource(owner);

        vm.startPrank(owner);
        src.setIssuer(issuer, true);
        asc = new ProofmarkASC(owner);
        asc.configureSource(SEPOLIA_KEY, address(src));
        vm.stopPrank();

        reg = new ProofmarkRegistry(address(asc));
    }

    // Helpers

    function _issue(address subject, uint32 methods_, uint8 assurance_, uint64 height, uint256 salt) internal {
        bytes32 attrs = MarkAttrs.pack(1, assurance_, 1, 410, methods_, ISSUED_AT, EXPIRY, 0);
        _issueAttrs(subject, attrs, height, salt);
    }

    function _issueAttrs(address subject, bytes32 attrs, uint64 height, uint256 salt) internal {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = attrs;
        t[3] = bytes32(uint256(uint160(issuer)));

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, abi.encode(bytes32(uint256(1)), bytes32(uint256(2))));

        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);
        asc.execute(uint8(Action.MarkIssued), SEPOLIA_KEY, height, fx.tx2(logs), bytes32(salt), sib, bytes32(0), roots);
    }

    function _revoke(address subject, uint64 height, uint256 salt) internal {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkRevoked(address,uint16,uint32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = bytes32(uint256(2));
        t[3] = bytes32(uint256(1));

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, bytes(""));

        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);
        asc.execute(uint8(Action.MarkRevoked), SEPOLIA_KEY, height, fx.tx2(logs), bytes32(salt), sib, bytes32(0), roots);
    }

    function _policy(uint32 requireAll, uint8 minAssurance, uint40 maxAge, bool requireRoster)
        internal
        returns (uint256)
    {
        vm.prank(dapp);
        return reg.registerPolicy(
            Policy({
                requireAll: requireAll,
                minAssurance: minAssurance,
                maxAge: maxAge,
                requiredRegime: 1,
                requiredJurisdiction: 410,
                trustedIssuer: issuer,
                requireRoster: requireRoster,
                exists: false
            })
        );
    }

    // Happy path

    function test_PassesMatchingPolicy() public {
        _issue(alice, KR_VASP, 3, 100, 1);
        uint256 pid = _policy(KR_VASP, 2, 0, false);
        assertTrue(reg.isVerified(alice, pid));
    }

    // The point: freshness by provenance

    /// @dev Enforcing `epoch == latestEpoch` unconditionally would fail every mark materialised
    ///      through an individual proof, because a Direct mark belongs to no epoch.
    function test_DirectMarkPassesWhenRosterNotRequired() public {
        _issue(alice, KR_VASP, 3, 100, 10);
        uint256 pid = _policy(KR_VASP, 1, 0, false); // requireRoster = false
        assertTrue(reg.isVerified(alice, pid), "Direct mark must pass when roster not required");
    }

    /// @dev A high-risk dApp accepts roster-backed marks only. The policy states that Direct is weaker.
    function test_DirectMarkFailsWhenRosterRequired() public {
        _issue(alice, KR_VASP, 3, 100, 11);
        uint256 pid = _policy(KR_VASP, 1, 0, true); // requireRoster = true
        assertFalse(reg.isVerified(alice, pid), "Direct mark must NOT satisfy a roster-only policy");
    }

    // Rejection paths, fail closed

    function test_FailsOnMissingMethodBit() public {
        // document and bank checks ran, sanctions screening did not
        _issue(alice, Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT, 3, 100, 20);
        uint256 pid = _policy(KR_VASP, 1, 0, false);
        assertFalse(reg.isVerified(alice, pid));
    }

    /// @dev The same mark gets different answers under different policies. This is the portability claim.
    function test_SameMarkDifferentJurisdictionPolicies() public {
        _issue(alice, KR_VASP, 3, 100, 21); // issued through the Korean flow
        uint256 krPid = _policy(KR_VASP, 1, 0, false);
        uint256 euPid = _policy(EU_RWA, 1, 0, false); // EU asks for liveness and PEP

        assertTrue(reg.isVerified(alice, krPid), "KR policy should pass");
        assertFalse(reg.isVerified(alice, euPid), "EU policy should fail - no LIVENESS/PEP bits");
    }

    function test_FailsOnTombstone() public {
        _issue(alice, KR_VASP, 3, 100, 30);
        uint256 pid = _policy(KR_VASP, 1, 0, false);
        assertTrue(reg.isVerified(alice, pid));

        _revoke(alice, 200, 31);
        assertFalse(reg.isVerified(alice, pid), "tombstone must always win");
    }

    function test_FailsOnLowAssurance() public {
        _issue(alice, KR_VASP, 2, 100, 40);
        uint256 pid = _policy(KR_VASP, 4, 0, false);
        assertFalse(reg.isVerified(alice, pid));
    }

    function test_FailsOnExpiredMark() public {
        _issue(alice, KR_VASP, 3, 100, 50);
        uint256 pid = _policy(KR_VASP, 1, 0, false);
        vm.warp(uint256(EXPIRY) + 1);
        assertFalse(reg.isVerified(alice, pid));
    }

    function test_FailsOnMaxAge() public {
        _issue(alice, KR_VASP, 3, 100, 60);
        uint256 pid = _policy(KR_VASP, 1, 1 days, false);
        vm.warp(uint256(ISSUED_AT) + 30 days);
        assertFalse(reg.isVerified(alice, pid), "stale mark must fail maxAge");
    }

    function test_FailsOnUnknownPolicy() public {
        _issue(alice, KR_VASP, 3, 100, 70);
        assertFalse(reg.isVerified(alice, 9999), "unregistered policy must not pass");
    }

    function test_FailsOnUnissuedSubject() public {
        uint256 pid = _policy(0, 0, 0, false);
        assertFalse(reg.isVerified(address(0xDEAD), pid), "no mark must not pass");
    }

    // Policy ownership

    function test_OnlyPolicyOwnerCanUpdate() public {
        uint256 pid = _policy(KR_VASP, 1, 0, false);
        Policy memory p = Policy({
            requireAll: 0,
            minAssurance: 0,
            maxAge: 0,
            requiredRegime: 0,
            requiredJurisdiction: 0,
            trustedIssuer: address(0),
            requireRoster: false,
            exists: false
        });

        vm.expectRevert(abi.encodeWithSelector(ProofmarkRegistry.NotPolicyOwner.selector, pid, address(this)));
        reg.updatePolicy(pid, p);

        vm.prank(dapp);
        reg.updatePolicy(pid, p); // the owner may
    }

    function test_FrozenPolicyCannotBeUpdated() public {
        uint256 pid = _policy(KR_VASP, 1, 0, false);
        vm.prank(dapp);
        reg.freezePolicy(pid);

        Policy memory p = Policy({
            requireAll: 0,
            minAssurance: 0,
            maxAge: 0,
            requiredRegime: 0,
            requiredJurisdiction: 0,
            trustedIssuer: address(0),
            requireRoster: false,
            exists: false
        });
        vm.prank(dapp);
        vm.expectRevert(abi.encodeWithSelector(ProofmarkRegistry.FrozenPolicy.selector, pid));
        reg.updatePolicy(pid, p);
    }

    function test_FailsOnWrongRegimeJurisdictionOrIssuer() public {
        _issue(alice, KR_VASP, 3, 100, 71);

        vm.startPrank(dapp);
        uint256 wrongRegime = reg.registerPolicy(
            Policy({
                requireAll: KR_VASP,
                minAssurance: 1,
                maxAge: 0,
                requiredRegime: 2,
                requiredJurisdiction: 410,
                trustedIssuer: issuer,
                requireRoster: false,
                exists: false
            })
        );
        uint256 wrongJurisdiction = reg.registerPolicy(
            Policy({
                requireAll: KR_VASP,
                minAssurance: 1,
                maxAge: 0,
                requiredRegime: 1,
                requiredJurisdiction: 840,
                trustedIssuer: issuer,
                requireRoster: false,
                exists: false
            })
        );
        uint256 wrongIssuer = reg.registerPolicy(
            Policy({
                requireAll: KR_VASP,
                minAssurance: 1,
                maxAge: 0,
                requiredRegime: 1,
                requiredJurisdiction: 410,
                trustedIssuer: address(0xBAD),
                requireRoster: false,
                exists: false
            })
        );
        vm.stopPrank();

        assertFalse(reg.isVerified(alice, wrongRegime));
        assertFalse(reg.isVerified(alice, wrongJurisdiction));
        assertFalse(reg.isVerified(alice, wrongIssuer));
    }

    function _publishRoot(bytes32 root, uint40 validUntil) internal {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40,uint40,uint40,bytes32)");
        topics[1] = bytes32(uint256(1));
        topics[2] = root;
        topics[3] = bytes32(uint256(1));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = fx.log(
            address(src),
            topics,
            abi.encode(validUntil, uint40(block.timestamp), uint40(block.timestamp), bytes32(uint256(1)))
        );
        bytes32[] memory auth = new bytes32[](4);
        auth[0] = keccak256("RosterIssuerAuthorized(uint32,bytes32,address)");
        auth[1] = topics[1];
        auth[2] = root;
        auth[3] = bytes32(uint256(uint160(issuer)));
        logs[1] = fx.log(address(src), auth, bytes(""));
        asc.execute(
            uint8(Action.RosterEpoch),
            SEPOLIA_KEY,
            400,
            fx.tx2(logs),
            bytes32(uint256(400)),
            new INativeQueryVerifier.MerkleProofEntry[](0),
            bytes32(0),
            new bytes32[](0)
        );
    }

    function _node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), left, right));
    }

    function test_V2MembershipPassesPolicyAndRejectsFutureTimestamp() public {
        RosterMark memory mark = RosterMark({
            attrs: MarkAttrs.pack(1, 3, 1, 410, KR_VASP, ISSUED_AT, EXPIRY, 0),
            claimsRoot: bytes32(uint256(1)),
            evidenceHash: bytes32(uint256(2)),
            issuer: issuer
        });
        bytes32 lower = RosterProof.leafOf(bytes32(0), bytes32(0));
        bytes32 upper = RosterProof.leafOf(bytes32(type(uint256).max), bytes32(0));
        bytes32 member = RosterProof.leafOf(
            RosterProof.subjectKey("eip155", alice),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        _publishRoot(
            RosterProof.rootOf(_node(_node(lower, member), _node(upper, upper)), 3), uint40(block.timestamp + 1 days)
        );
        bytes32[] memory siblings = new bytes32[](2);
        siblings[0] = lower;
        siblings[1] = _node(upper, upper);
        RosterProof.Inclusion memory proof = RosterProof.Inclusion({index: 1, leafCount: 3, siblings: siblings});
        uint256 pid = _policy(KR_VASP, 2, 0, true);
        assertEq(reg.ROSTER_FORMAT_VERSION(), 2);
        assertTrue(reg.verifyWithRoster(alice, pid, mark, proof), "valid v2 membership must pass");
        vm.warp(ISSUED_AT - 1);
        assertFalse(reg.verifyWithRoster(alice, pid, mark, proof), "future issuance fails even without maxAge");
        vm.warp(EXPIRY);
        assertFalse(reg.verifyWithRoster(alice, pid, mark, proof), "expired epoch fails");
    }

    function test_V2AbsenceRequiresUnexpiredEpoch() public {
        bytes32 lower = RosterProof.leafOf(bytes32(0), bytes32(0));
        bytes32 upper = RosterProof.leafOf(bytes32(type(uint256).max), bytes32(0));
        uint40 validUntil = uint40(block.timestamp + 1 hours);
        _publishRoot(RosterProof.rootOf(_node(lower, upper), 2), validUntil);
        bytes32[] memory leftPath = new bytes32[](1);
        bytes32[] memory rightPath = new bytes32[](1);
        leftPath[0] = upper;
        rightPath[0] = lower;
        RosterProof.NonInclusion memory proof = RosterProof.NonInclusion({
            left: RosterProof.Inclusion({index: 0, leafCount: 2, siblings: leftPath}),
            leftKey: bytes32(0),
            leftMark: bytes32(0),
            right: RosterProof.Inclusion({index: 1, leafCount: 2, siblings: rightPath}),
            rightKey: bytes32(type(uint256).max),
            rightMark: bytes32(0)
        });
        assertTrue(reg.proveNotInRoster(alice, proof));
        uint256 publishedAt = block.timestamp;
        vm.warp(publishedAt - 1);
        assertFalse(reg.proveNotInRoster(alice, proof), "future epoch is not current absence");
        vm.warp(validUntil - 1);
        assertTrue(reg.proveNotInRoster(alice, proof));
        vm.warp(validUntil);
        assertFalse(reg.proveNotInRoster(alice, proof), "stale absence is not current evidence");
    }

    function test_RegistryRejectsExactPublishedLegacyAbsenceForgery() public {
        bytes32 legacyRoot = 0xfe6cf3e0fc518c85ec822fd119fa8291461ff5fc1e0a5d6dbe6be1e7e8f5364d;
        _publishRoot(legacyRoot, uint40(block.timestamp + 1 hours));

        bytes32[] memory leftPath = new bytes32[](2);
        leftPath[0] = 0xbb18114919f158d7c2b3f1895fe76e2e67dc753800ac843eda5479d4fdbfd75d;
        leftPath[1] = 0xa09637336041ba36b37e6a41cb44622df981df1b35506054ef79a3cf75f4f59a;
        bytes32[] memory rightPath = new bytes32[](1);
        rightPath[0] = 0xee435ed92c2d049d1ab2ab0c480df0eaa5f35376441b38f789754b706878ede0;
        RosterProof.NonInclusion memory forged = RosterProof.NonInclusion({
            left: RosterProof.Inclusion({index: 0, leafCount: 4, siblings: leftPath}),
            leftKey: bytes32(0),
            leftMark: bytes32(0),
            right: RosterProof.Inclusion({index: 1, leafCount: 4, siblings: rightPath}),
            rightKey: 0x9e1dc5ce841b03a33bab09d4a206c67a0afe3d7f0aab857a58ced05925237d45,
            rightMark: 0xbbd6e7dddd4326dd7c827841ab9733c6e3fcdf38a516374bd10feec8f674ea8a
        });

        assertFalse(
            reg.proveNotInRoster(0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2, forged),
            "a fresh Registry must reject the published epoch-1 forged absence proof"
        );
    }

    function test_DirectFutureTimestampFailsEvenWithoutMaxAge() public {
        _issue(alice, KR_VASP, 3, 100, 1);
        uint256 pid = _policy(KR_VASP, 2, 0, false);
        vm.warp(ISSUED_AT - 1);
        assertFalse(reg.isVerified(alice, pid));
    }

    /// @dev Appendix B's exact T-11 counterexample. Historical source receipts can carry a
    ///      structurally valid future timestamp, so every consumer policy must reject it.
    function test_T11ExactFutureIssuedAtRejectedWhenMaxAgeIsZero() public {
        _issueAttrs(alice, MarkAttrs.pack(1, 1, 1, 1, 0, 2000, 3000, 0), 999, 999);
        assertEq(asc.getMark(alice).status, uint8(MarkStatus.Active), "fixture must reach the consumer boundary");
        uint256 pid = reg.registerPolicy(Policy(0, 0, 0, 0, 0, issuer, false, false));

        vm.warp(1000);
        assertFalse(reg.isVerified(alice, pid), "now=1000 must reject issuedAt=2000 when maxAge=0");
    }

    // Mode B: no roster, no pass

    function test_PolicyKindIsExplicitImmutableAndAppliedToDirect() public {
        Policy memory p = Policy(0, 0, 0, 0, 0, address(0), false, false);
        uint256 individual = reg.registerPolicy(p);
        uint256 entity = reg.registerPolicyForKind(p, 2);
        assertEq(reg.POLICY_SCHEMA_VERSION(), 2);
        assertEq(reg.policyKind(individual), 1);
        assertEq(reg.policyKind(entity), 2);
        _issueAttrs(alice, SchemaVectors.VALID, 100, 1);
        assertTrue(reg.isVerified(alice, individual));
        assertFalse(reg.isVerified(alice, entity));
        _issueAttrs(alice, SchemaVectors.field(SchemaVectors.VALID, 248, 8, 2), 101, 1);
        assertFalse(reg.isVerified(alice, individual));
        assertTrue(reg.isVerified(alice, entity));
        reg.updatePolicy(entity, p);
        assertEq(reg.policyKind(entity), 2);
        reg.transferPolicyOwner(entity, dapp);
        assertEq(reg.policyKind(entity), 2);
    }

    function test_UnsupportedSchemaCannotPassEvenWildcardDirectPolicy() public {
        uint256 pid = reg.registerPolicy(Policy(0, 0, 0, 0, 0, address(0), false, false));
        bytes32[] memory bad = SchemaVectors.invalid();
        for (uint256 i; i < bad.length; i++) {
            _issueAttrs(alice, bad[i], uint64(100 + i), 1);
            assertFalse(reg.isVerified(alice, pid));
            assertTrue(asc.tombstone(alice));
        }
    }

    function _rosterFor(bytes32 attrs, uint256 pid) private returns (bool) {
        bytes32 lower = RosterProof.leafOf(bytes32(0), bytes32(0));
        bytes32 upper = RosterProof.leafOf(bytes32(type(uint256).max), bytes32(0));
        RosterMark memory mark = RosterMark(attrs, bytes32(0), bytes32(0), issuer);
        bytes32 member = RosterProof.leafOf(
            RosterProof.subjectKey("eip155", alice), RosterProof.markHash(attrs, bytes32(0), bytes32(0), issuer)
        );
        // Separate ASC fixture per vector avoids replacing an already-proved epoch in tests.
        _publishRoot(
            RosterProof.rootOf(_node(_node(lower, member), _node(upper, upper)), 3), uint40(block.timestamp + 1 days)
        );
        bytes32[] memory siblings = new bytes32[](2);
        siblings[0] = lower;
        siblings[1] = _node(upper, upper);
        return reg.verifyWithRoster(alice, pid, mark, RosterProof.Inclusion(1, 3, siblings));
    }

    function test_UnsupportedSchemaAndKindCannotPassValidRosterProof() public {
        bytes32[] memory bad = SchemaVectors.invalid();
        for (uint256 i; i < bad.length; i++) {
            setUp();
            uint256 pid = reg.registerPolicy(Policy(0, 0, 0, 0, 0, address(0), true, false));
            assertFalse(_rosterFor(bad[i], pid));
        }
        setUp();
        uint256 person = reg.registerPolicy(Policy(0, 0, 0, 0, 0, address(0), true, false));
        assertFalse(_rosterFor(SchemaVectors.field(SchemaVectors.VALID, 248, 8, 2), person));
        setUp();
        uint256 entity = reg.registerPolicyForKind(Policy(0, 0, 0, 0, 0, address(0), true, false), 2);
        assertTrue(_rosterFor(SchemaVectors.field(SchemaVectors.VALID, 248, 8, 2), entity));
    }

    function test_InvalidPolicyRegistrationAndUpdateAreAtomic() public {
        Policy memory p = Policy(0, 0, 0, 0, 0, address(0), false, false);
        uint256 pid = reg.registerPolicy(p);
        for (uint8 i; i < 4; i++) {
            Policy memory bad = Policy(0, 0, 0, 0, 0, address(0), false, false);
            if (i == 0) bad.requireAll = 1 << 11;
            if (i == 1) bad.minAssurance = 6;
            if (i == 2) bad.requiredRegime = 410;
            if (i == 3) bad.requiredJurisdiction = 1000;
            vm.expectRevert(ProofmarkRegistry.InvalidPolicy.selector);
            reg.registerPolicy(bad);
            vm.expectRevert(ProofmarkRegistry.InvalidPolicy.selector);
            reg.updatePolicy(pid, bad);
            assertEq(reg.nextPolicyId(), 2);
        }
        vm.expectRevert(ProofmarkRegistry.InvalidPolicy.selector);
        reg.registerPolicyForKind(p, 0);
        vm.expectRevert(ProofmarkRegistry.InvalidPolicy.selector);
        reg.registerPolicyForKind(p, 3);
        assertEq(reg.policyKind(pid), 1);
    }

    function test_RegistryRefusesLegacyOrUnknownAscSchema() public {
        SchemaVersionStub unknownAttrs = new SchemaVersionStub(1, 2);
        SchemaVersionStub legacyReceipts = new SchemaVersionStub(0, 1);
        vm.expectRevert("unsupported ASC schema");
        new ProofmarkRegistry(address(unknownAttrs));
        vm.expectRevert("unsupported ASC schema");
        new ProofmarkRegistry(address(legacyReceipts));
        vm.expectRevert();
        new ProofmarkRegistry(address(0x1234));
    }

    function test_UnknownProvenanceCannotFallThroughAsDirect() public {
        uint256 pid = reg.registerPolicy(Policy(0, 0, 0, 0, 0, address(0), false, false));
        _issueAttrs(alice, SchemaVectors.VALID, 100, 1);
        assertTrue(reg.isVerified(alice, pid));
        Mark memory mark = asc.getMark(alice);
        for (uint8 i; i < 3; i++) {
            mark.origin = i == 0 ? 0 : i == 1 ? 3 : 255;
            vm.mockCall(address(asc), abi.encodeWithSelector(asc.getMark.selector, alice), abi.encode(mark));
            assertFalse(reg.isVerified(alice, pid));
        }
        vm.clearMockedCalls();
    }

    /// @dev With no epoch root published, every roster path must return false.
    ///      Unknown is never a pass.
    function test_RosterPathFailsClosedWithoutEpoch() public {
        uint256 pid = _policy(KR_VASP, 1, 0, true); // requireRoster
        bytes32[] memory sib = new bytes32[](0);

        bool ok = reg.verifyWithRoster(
            alice,
            pid,
            RosterMark({attrs: bytes32(0), claimsRoot: bytes32(0), evidenceHash: bytes32(0), issuer: issuer}),
            RosterProof.Inclusion({index: 0, leafCount: 2, siblings: sib})
        );
        assertFalse(ok, "roster verification passed with no epoch root");
    }

    function test_ProveNotInRosterFailsClosedWithoutEpoch() public view {
        RosterProof.Inclusion memory e = RosterProof.Inclusion({index: 0, leafCount: 2, siblings: new bytes32[](0)});
        bool ok = reg.proveNotInRoster(
            alice,
            RosterProof.NonInclusion({
                left: e,
                leftKey: bytes32(0),
                leftMark: bytes32(0),
                right: e,
                rightKey: bytes32(0),
                rightMark: bytes32(0)
            })
        );
        assertFalse(ok, "non-inclusion passed with no epoch root");
    }
}

contract SchemaVersionStub {
    uint256 public ATTRS_SCHEMA_VERSION;
    uint256 public TRANSACTION_PROCESSING_VERSION;

    constructor(uint256 attrs, uint256 receipts) {
        ATTRS_SCHEMA_VERSION = attrs;
        TRANSACTION_PROCESSING_VERSION = receipts;
    }
}
