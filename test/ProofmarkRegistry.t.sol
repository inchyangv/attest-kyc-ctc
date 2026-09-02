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
import {Action, Policy, Methods} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

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
        bytes32 attrs = MarkAttrs.pack(1, assurance_, 410, 410, methods_, ISSUED_AT, EXPIRY, 0);
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
                requiredRegime: 410,
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
                requiredRegime: 410,
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
                requiredRegime: 410,
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

    // Mode B: no roster, no pass

    /// @dev With no epoch root published, every roster path must return false.
    ///      Unknown is never a pass.
    function test_RosterPathFailsClosedWithoutEpoch() public {
        uint256 pid = _policy(KR_VASP, 1, 0, true); // requireRoster
        bytes32[] memory sib = new bytes32[](0);

        bool ok = reg.verifyWithRoster(
            alice,
            pid,
            RosterMark({attrs: bytes32(0), claimsRoot: bytes32(0), evidenceHash: bytes32(0), issuer: issuer}),
            RosterProof.Inclusion({index: 0, siblings: sib})
        );
        assertFalse(ok, "roster verification passed with no epoch root");
    }

    function test_ProveNotInRosterFailsClosedWithoutEpoch() public view {
        RosterProof.Inclusion memory e = RosterProof.Inclusion({index: 0, siblings: new bytes32[](0)});
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
