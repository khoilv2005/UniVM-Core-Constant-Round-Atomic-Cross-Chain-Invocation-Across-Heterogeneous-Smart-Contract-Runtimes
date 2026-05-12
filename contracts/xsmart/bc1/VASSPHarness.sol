// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VASSP} from "./lib/VASSP.sol";

contract VASSPHarness {
    function encodePairs(
        bytes32[] memory slotIds,
        bytes[] memory values
    ) external pure returns (bytes memory) {
        if (slotIds.length != values.length) revert VASSP.LengthMismatch();

        VASSP.Pair[] memory pairs = new VASSP.Pair[](slotIds.length);
        for (uint256 i = 0; i < slotIds.length; i++) {
            pairs[i] = VASSP.Pair({slotId: slotIds[i], abiValue: values[i]});
        }
        return VASSP.encode(pairs);
    }

    function decodePairs(
        bytes memory encoded
    ) external pure returns (bytes32[] memory slotIds, bytes[] memory values) {
        VASSP.Pair[] memory pairs = VASSP.decode(encoded);

        slotIds = new bytes32[](pairs.length);
        values = new bytes[](pairs.length);
        for (uint256 i = 0; i < pairs.length; i++) {
            slotIds[i] = pairs[i].slotId;
            values[i] = pairs[i].abiValue;
        }
    }

    function slotIdFor(
        string memory contractName,
        string memory slotName,
        bytes[] memory keys
    ) external pure returns (bytes32) {
        return VASSP.slotIdFor(contractName, slotName, keys);
    }

    function decodeAndApply(
        address translated,
        bytes memory encoded,
        bytes32 storageMapRoot
    ) external {
        VASSP.decodeAndApply(translated, encoded, storageMapRoot);
    }
}
