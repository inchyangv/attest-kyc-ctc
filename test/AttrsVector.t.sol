// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";

/// @notice Pins byte-level agreement with `packAttrs` in the TypeScript pipeline.
/// @dev A drift here shifts every field of the on-chain mark. It fails quietly.
///      pipeline/pipeline.test.ts hardcodes the same vector and checks against it.
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
