// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";

/// @notice `pipeline/roster.ts` 와 바이트 단위 일치를 고정한다.
/// @dev 벡터는 TypeScript 가 5건 명부로 생성했다. 한쪽만 고치면 이 테스트가 깨진다.
contract RosterProofTest is Test {
    bytes32 constant ROOT = 0x765ddbec0ab20e3913c344b3f1c3ecca87b6567b65f5946ae51f4c3a9905fc69;

    function test_SubjectKeyMatchesTypeScript() public pure {
        assertEq(
            RosterProof.subjectKey("eip155", address(3)),
            0x56e9d29e372019a030d4fac130c1c688f76c50149e9529718c02033e791d86e5
        );
    }

    function test_MarkHashMatchesTypeScript() public pure {
        assertEq(
            RosterProof.markHash(
                bytes32(uint256(3) << 200),
                keccak256("claims3"),
                keccak256("ev3"),
                0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
            ),
            0xda136b54716e639e957e205498fb6c5406b5c77a4a1e1d11a4dda9a221209be4
        );
    }

    function test_VerifyInclusion() public pure {
        bytes32[] memory sib = new bytes32[](3);
        sib[0] = 0xfbbc81fa8da94f9a85ed206876f2b2aaa33c3a53fe4157448aac65417a8927bd;
        sib[1] = 0x7832447164f5b0d2cdf288d9a8166035ef78df550ca265dd64b7f0d582470376;
        sib[2] = 0x7ff7e97cf93c59f4ac6c4ca6aab0d2a22317f63cda167f4f66e5e7bcf472c4a2;

        RosterProof.Inclusion memory p = RosterProof.Inclusion({index: 3, siblings: sib});
        bytes32 leaf = 0x403d0f0839541c259f599993a09de0177357022d45a6753c3372e16936cf0dc2;

        assertTrue(RosterProof.verifyInclusion(ROOT, leaf, p));
        assertFalse(RosterProof.verifyInclusion(ROOT, keccak256("fake"), p), unicode"위조 리프가 통과했다");
    }

    function _nonInclusion() private pure returns (RosterProof.NonInclusion memory) {
        bytes32[] memory ls = new bytes32[](3);
        ls[0] = 0x8658b057089e256e0473bf97d547f46f9885654629fd8f9710717591d8be0dde;
        ls[1] = 0x6157acf5aa61ae0b0ff57e9ef207bdf0e94397aef718c5ff4ea8af78a2d9aac1;
        ls[2] = 0x0747c16b891ec99a024175958b9f661640f5de2be03452e1f881cb2cfdf8f7e8;

        bytes32[] memory rs = new bytes32[](3);
        rs[0] = 0xbbd6e7dddd4326dd7c827841ab9733c6e3fcdf38a516374bd10feec8f674ea8a;
        rs[1] = 0x20ce4ea559ae0aaecbc11daacf1e8124dc7666cd8886757a074bd55d2f761486;
        rs[2] = 0x0747c16b891ec99a024175958b9f661640f5de2be03452e1f881cb2cfdf8f7e8;

        return RosterProof.NonInclusion({
            left:  RosterProof.Inclusion({index: 5, siblings: ls}),
            leftLeaf:  0x7c31545452aae68f24b57fecf886bf42371c6d66cf7c27f3c95a7ba503a82af3,
            leftKey:   0xa43c201135cfef37d7be83630438e9c6af9e5ba946c85c47447e0ee967b02772,
            right: RosterProof.Inclusion({index: 6, siblings: rs}),
            rightLeaf: 0xbbd6e7dddd4326dd7c827841ab9733c6e3fcdf38a516374bd10feec8f674ea8a,
            rightKey:  bytes32(type(uint256).max)
        });
    }

    /// @dev 명부에 없는 주체의 비포함이 검증된다 — 폐기 표현의 근거
    function test_VerifyNonInclusion() public pure {
        bytes32 targetKey = 0xf546978472b6cbaee6c96f8f5afc15c2ee71e09339a97cae2e243cda496b9b96;
        assertTrue(RosterProof.verifyNonInclusion(ROOT, targetKey, _nonInclusion()));
    }

    /// @dev 대상이 두 키 사이에 없으면 거부
    function test_RejectsTargetOutsideGap() public pure {
        bytes32 outside = 0x0000000000000000000000000000000000000000000000000000000000000001;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, outside, _nonInclusion()));
    }

    /// @dev ★ 두 리프가 인접하지 않으면 거부 — 없으면 중간을 건너뛴 위조가 통과한다
    function test_RejectsNonAdjacentLeaves() public pure {
        RosterProof.NonInclusion memory p = _nonInclusion();
        p.right.index = p.left.index + 2;   // 인접성을 깬다
        bytes32 targetKey = 0xf546978472b6cbaee6c96f8f5afc15c2ee71e09339a97cae2e243cda496b9b96;
        assertFalse(RosterProof.verifyNonInclusion(ROOT, targetKey, p), unicode"비인접 리프가 통과했다");
    }

    function test_SentinelConstantsMatchTypeScript() public pure {
        assertEq(RosterProof.MIN_KEY, bytes32(0));
        assertEq(RosterProof.MAX_KEY, bytes32(type(uint256).max));
    }
}
