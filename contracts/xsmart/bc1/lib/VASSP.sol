// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title VASSP
 * @notice Prototype VASSP encoder/decoder for XSmartContract.
 *         This version supports the exact pair shape used by step 6:
 *         an RLP list of RLP-encoded `[slotId, abiValue]` pairs, where
 *         `slotId` is always 32 bytes and `abiValue` is an arbitrary byte blob.
 *
 *         It deliberately does not implement general-purpose RLP decoding for
 *         arbitrary nested user inputs; only the shapes needed by XSmart are accepted.
 */
library VASSP {
    struct Pair {
        bytes32 slotId;
        bytes abiValue;
    }

    error InvalidRlp(string reason);
    error ApplyFailed(address target, bytes32 slotId);
    error LengthMismatch();

    /**
     * @notice Canonical cross-VM slot identifier.
     * @dev Mirrors the blueprint rule:
     *      keccak256(encodePacked("VASSP", contractName, slotName, keys...)).
     */
    function slotIdFor(
        string memory contractName,
        string memory slotName,
        bytes[] memory keys
    ) internal pure returns (bytes32) {
        bytes memory packed = abi.encodePacked("VASSP", contractName, slotName);
        for (uint256 i = 0; i < keys.length; i++) {
            packed = bytes.concat(packed, keys[i]);
        }
        return keccak256(packed);
    }

    function encode(Pair[] memory pairs) internal pure returns (bytes memory) {
        bytes[] memory encodedPairs = new bytes[](pairs.length);
        for (uint256 i = 0; i < pairs.length; i++) {
            bytes[] memory tupleItems = new bytes[](2);
            tupleItems[0] = _encodeBytes(abi.encodePacked(pairs[i].slotId));
            tupleItems[1] = _encodeBytes(pairs[i].abiValue);
            encodedPairs[i] = _encodeList(tupleItems);
        }
        return _encodeList(encodedPairs);
    }

    function decode(bytes memory encoded) internal pure returns (Pair[] memory) {
        _Item memory root = _decodeItem(encoded, 0);
        if (!root.isList) revert InvalidRlp("root is not a list");
        if (root.totalLength != encoded.length) revert InvalidRlp("trailing bytes");

        uint256 count = _countListItems(encoded, root);
        Pair[] memory pairs = new Pair[](count);

        uint256 cursor = root.payloadOffset;
        for (uint256 i = 0; i < count; i++) {
            _Item memory pairItem = _decodeItem(encoded, cursor);
            if (!pairItem.isList) revert InvalidRlp("pair is not a list");

            uint256 innerCursor = pairItem.payloadOffset;
            _Item memory slotItem = _decodeItem(encoded, innerCursor);
            if (slotItem.isList) revert InvalidRlp("slotId must be bytes");
            if (slotItem.payloadLength != 32) revert InvalidRlp("slotId must be 32 bytes");

            innerCursor += slotItem.totalLength;
            _Item memory valueItem = _decodeItem(encoded, innerCursor);
            if (valueItem.isList) revert InvalidRlp("abiValue must be bytes");

            innerCursor += valueItem.totalLength;
            if (innerCursor != pairItem.payloadOffset + pairItem.payloadLength) {
                revert InvalidRlp("pair must contain exactly 2 items");
            }

            pairs[i] = Pair({
                slotId: _toBytes32(encoded, slotItem.payloadOffset),
                abiValue: _slice(encoded, valueItem.payloadOffset, valueItem.payloadLength)
            });

            cursor += pairItem.totalLength;
        }

        return pairs;
    }

    /**
     * @notice Decode and forward pairs to a translated contract.
     * @dev `storageMapRoot` is reserved for the later proof-aware version.
     */
    function decodeAndApply(
        address translated,
        bytes memory encoded,
        bytes32 /* storageMapRoot */
    ) internal {
        Pair[] memory pairs = decode(encoded);
        for (uint256 i = 0; i < pairs.length; i++) {
            (bool ok, ) = translated.call(
                abi.encodeWithSignature(
                    "__vassp_apply(bytes32,bytes)",
                    pairs[i].slotId,
                    pairs[i].abiValue
                )
            );
            if (!ok) revert ApplyFailed(translated, pairs[i].slotId);
        }
    }

    struct _Item {
        bool isList;
        uint256 payloadOffset;
        uint256 payloadLength;
        uint256 totalLength;
    }

    function _encodeBytes(bytes memory value) private pure returns (bytes memory) {
        uint256 len = value.length;

        if (len == 1 && uint8(value[0]) < 0x80) {
            return value;
        }

        if (len <= 55) {
            return bytes.concat(bytes1(uint8(0x80 + len)), value);
        }

        bytes memory lenBytes = _encodeLength(len);
        return bytes.concat(bytes1(uint8(0xb7 + lenBytes.length)), lenBytes, value);
    }

    function _encodeList(bytes[] memory items) private pure returns (bytes memory) {
        bytes memory payload;
        for (uint256 i = 0; i < items.length; i++) {
            payload = bytes.concat(payload, items[i]);
        }

        uint256 len = payload.length;
        if (len <= 55) {
            return bytes.concat(bytes1(uint8(0xc0 + len)), payload);
        }

        bytes memory lenBytes = _encodeLength(len);
        return bytes.concat(bytes1(uint8(0xf7 + lenBytes.length)), lenBytes, payload);
    }

    function _encodeLength(uint256 value) private pure returns (bytes memory) {
        uint256 temp = value;
        uint256 length;
        while (temp != 0) {
            length++;
            temp >>= 8;
        }

        bytes memory out = new bytes(length);
        temp = value;
        for (uint256 i = length; i > 0; i--) {
            out[i - 1] = bytes1(uint8(temp));
            temp >>= 8;
        }
        return out;
    }

    function _decodeItem(bytes memory data, uint256 offset) private pure returns (_Item memory item) {
        if (offset >= data.length) revert InvalidRlp("offset out of bounds");

        uint8 prefix = uint8(data[offset]);
        if (prefix <= 0x7f) {
            return _Item({
                isList: false,
                payloadOffset: offset,
                payloadLength: 1,
                totalLength: 1
            });
        }

        if (prefix <= 0xb7) {
            uint256 shortStringLen = prefix - 0x80;
            _requireBounds(data.length, offset + 1, shortStringLen);
            return _Item({
                isList: false,
                payloadOffset: offset + 1,
                payloadLength: shortStringLen,
                totalLength: 1 + shortStringLen
            });
        }

        if (prefix <= 0xbf) {
            uint256 stringLenOfLen = prefix - 0xb7;
            uint256 longStringLen = _readBigEndian(data, offset + 1, stringLenOfLen);
            _requireBounds(data.length, offset + 1 + stringLenOfLen, longStringLen);
            return _Item({
                isList: false,
                payloadOffset: offset + 1 + stringLenOfLen,
                payloadLength: longStringLen,
                totalLength: 1 + stringLenOfLen + longStringLen
            });
        }

        if (prefix <= 0xf7) {
            uint256 shortListLen = prefix - 0xc0;
            _requireBounds(data.length, offset + 1, shortListLen);
            return _Item({
                isList: true,
                payloadOffset: offset + 1,
                payloadLength: shortListLen,
                totalLength: 1 + shortListLen
            });
        }

        uint256 listLenOfLen = prefix - 0xf7;
        uint256 longListLen = _readBigEndian(data, offset + 1, listLenOfLen);
        _requireBounds(data.length, offset + 1 + listLenOfLen, longListLen);
        return _Item({
            isList: true,
            payloadOffset: offset + 1 + listLenOfLen,
            payloadLength: longListLen,
            totalLength: 1 + listLenOfLen + longListLen
        });
    }

    function _countListItems(bytes memory data, _Item memory listItem) private pure returns (uint256 count) {
        uint256 cursor = listItem.payloadOffset;
        uint256 end = listItem.payloadOffset + listItem.payloadLength;

        while (cursor < end) {
            _Item memory inner = _decodeItem(data, cursor);
            cursor += inner.totalLength;
            count++;
        }

        if (cursor != end) revert InvalidRlp("malformed list payload");
    }

    function _readBigEndian(
        bytes memory data,
        uint256 offset,
        uint256 length
    ) private pure returns (uint256 value) {
        if (length == 0) revert InvalidRlp("zero length-of-length");
        _requireBounds(data.length, offset, length);
        for (uint256 i = 0; i < length; i++) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }

    function _slice(
        bytes memory data,
        uint256 offset,
        uint256 length
    ) private pure returns (bytes memory out) {
        _requireBounds(data.length, offset, length);
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[offset + i];
        }
    }

    function _toBytes32(bytes memory data, uint256 offset) private pure returns (bytes32 out) {
        _requireBounds(data.length, offset, 32);
        assembly {
            out := mload(add(add(data, 0x20), offset))
        }
    }

    function _requireBounds(
        uint256 dataLength,
        uint256 offset,
        uint256 length
    ) private pure {
        if (offset + length > dataLength) revert InvalidRlp("payload out of bounds");
    }
}
