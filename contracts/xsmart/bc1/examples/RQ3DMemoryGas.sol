// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice RQ3d memory-impedance benchmark target.
 *
 * The contract models three costs for lowering linear-memory-style VM state to
 * an EVM execution clone:
 * - decodeOnly: parse a canonical byte payload into 32-byte words.
 * - executeOnly: scan words and perform deterministic arithmetic/hash work.
 * - importAndExecute: scan words and persist them into trie-backed EVM storage.
 *
 * The last path approximates the expensive case where WASM/Fabric memory-like
 * state must be represented as individual EVM storage slots.
 */
contract RQ3DMemoryGas {
    mapping(uint256 => bytes32) private memorySlots;
    uint256 public lastByteLength;
    uint256 public lastWordCount;
    bytes32 public checksum;

    error EmptyPayload();
    error PayloadTooLarge();

    uint256 public constant MaxPayloadBytes = 131072;

    function decodeOnly(bytes calldata payload) external returns (bytes32) {
        _validate(payload.length);
        bytes32 acc = _scan(payload, 1, false);
        checksum = acc;
        lastByteLength = payload.length;
        lastWordCount = _wordCount(payload.length);
        return acc;
    }

    function executeOnly(bytes calldata payload, uint256 rounds) external returns (bytes32) {
        _validate(payload.length);
        require(rounds > 0 && rounds <= 8, "rounds");
        bytes32 acc;
        for (uint256 r = 0; r < rounds; r++) {
            acc = keccak256(abi.encodePacked(acc, _scan(payload, r + 1, false), r));
        }
        checksum = acc;
        lastByteLength = payload.length;
        lastWordCount = _wordCount(payload.length);
        return acc;
    }

    function importAndExecute(bytes calldata payload, uint256 rounds) external returns (bytes32) {
        _validate(payload.length);
        require(rounds > 0 && rounds <= 8, "rounds");
        bytes32 acc;
        uint256 words = _wordCount(payload.length);
        for (uint256 r = 0; r < rounds; r++) {
            for (uint256 i = 0; i < words; i++) {
                bytes32 word = _loadWord(payload, i);
                bytes32 mixed = keccak256(abi.encodePacked(acc, word, i, r));
                memorySlots[i] = mixed;
                acc = mixed;
            }
        }
        checksum = acc;
        lastByteLength = payload.length;
        lastWordCount = words;
        return acc;
    }

    function readWord(uint256 index) external view returns (bytes32) {
        return memorySlots[index];
    }

    function _validate(uint256 byteLength) private pure {
        if (byteLength == 0) revert EmptyPayload();
        if (byteLength > MaxPayloadBytes) revert PayloadTooLarge();
    }

    function _scan(bytes calldata payload, uint256 salt, bool includeStoreShape) private pure returns (bytes32 acc) {
        uint256 words = _wordCount(payload.length);
        for (uint256 i = 0; i < words; i++) {
            bytes32 word = _loadWord(payload, i);
            if (includeStoreShape) {
                acc = keccak256(abi.encodePacked(acc, word, i, salt, payload.length));
            } else {
                acc = keccak256(abi.encodePacked(acc, word, i, salt));
            }
        }
    }

    function _loadWord(bytes calldata payload, uint256 wordIndex) private pure returns (bytes32 word) {
        uint256 offset = wordIndex * 32;
        assembly {
            word := calldataload(add(payload.offset, offset))
        }
    }

    function _wordCount(uint256 byteLength) private pure returns (uint256) {
        return (byteLength + 31) / 32;
    }
}
