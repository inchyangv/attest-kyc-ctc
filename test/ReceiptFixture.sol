// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @notice Builder for synthetic `encodedTransaction` payloads.
/// @dev Layout, read off the EvmV1Decoder source:
///        encodedTransaction = abi.encode(uint8 txType, bytes[] chunks)
///        chunks.length == 3 (txType 0~2) / 4 (txType 3~4)
///        chunks[last] = abi.encode(uint8 status, uint64 gasUsed, LogEntryTuple[] logs, bytes bloom)
///        LogEntryTuple = (address address_, bytes32[] topics, bytes data)
contract ReceiptFixture {
    function log(address emitter, bytes32[] memory topics, bytes memory data)
        public
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
    }

    /// @notice A type-2 transaction carrying a successful receipt (status 1).
    function tx2(EvmV1Decoder.LogEntryTuple[] memory logs) public pure returns (bytes memory) {
        return _build(2, 1, logs);
    }

    /// @notice A failed receipt (status 0).
    function tx2Failed(EvmV1Decoder.LogEntryTuple[] memory logs) public pure returns (bytes memory) {
        return _build(2, 0, logs);
    }

    function _build(uint8 txType, uint8 status, EvmV1Decoder.LogEntryTuple[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory receiptChunk = abi.encode(status, uint64(123456), logs, bytes(""));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = bytes("");
        chunks[1] = bytes("");
        chunks[2] = receiptChunk;
        return abi.encode(txType, chunks);
    }
}
