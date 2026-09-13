// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library SchemaVectors {
    bytes32 internal constant VALID = 0x01030002019a00010024006553f100006b49d200000000000000000000000000;

    function field(bytes32 a, uint256 shift, uint256 bits, uint256 value) internal pure returns (bytes32) {
        return bytes32((uint256(a) & ~(((uint256(1) << bits) - 1) << shift)) | (value << shift));
    }

    function invalid() internal pure returns (bytes32[] memory a) {
        a = new bytes32[](16);
        a[0] = bytes32(uint256(VALID) | 1);
        a[1] = bytes32(uint256(VALID) | (uint256(1) << 63));
        a[2] = field(VALID, 248, 8, 0);
        a[3] = field(VALID, 248, 8, 3);
        a[4] = field(VALID, 248, 8, 255);
        a[5] = field(VALID, 240, 8, 0);
        a[6] = field(VALID, 240, 8, 6);
        a[7] = field(VALID, 224, 16, 0);
        a[8] = field(VALID, 224, 16, 3);
        a[9] = field(VALID, 224, 16, 410);
        a[10] = field(VALID, 208, 16, 0);
        a[11] = field(VALID, 208, 16, 1000);
        a[12] = field(VALID, 176, 32, 1 << 11);
        a[13] = field(VALID, 176, 32, 1 << 31);
        a[14] = field(VALID, 136, 40, 0);
        a[15] = field(VALID, 96, 40, 1_700_000_000);
    }
}
