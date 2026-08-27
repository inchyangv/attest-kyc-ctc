// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";

/// @notice TypeScript 파이프라인의 `packAttrs` 와 바이트 단위 일치를 고정한다.
/// @dev 어긋나면 온체인 마크의 모든 필드가 밀려 들어간다 — 조용히 깨지는 종류의 버그.
///      pipeline/pipeline.test.ts 가 같은 벡터를 하드코딩해 대조한다.
contract AttrsVectorTest is Test {
    function test_KnownVectorMatchesTypeScript() public pure {
        bytes32 got = MarkAttrs.pack(
            1,              // kind
            3,              // assurance
            2,              // regime (KR_FSC_NONFACE_SANDBOX)
            410,            // jurisdiction (KR)
            0x10024,        // methods
            1_700_000_000,  // issuedAt
            1_800_000_000,  // expiry
            0               // epoch
        );
        assertEq(got, VECTOR);
    }

    bytes32 constant VECTOR = 0x01030002019a00010024006553f100006b49d200000000000000000000000000;
}
