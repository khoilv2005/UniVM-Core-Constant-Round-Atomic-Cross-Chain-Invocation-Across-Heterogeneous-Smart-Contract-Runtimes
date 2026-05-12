// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract VASSPApplyTarget {
    string private constant CONTRACT_NAME = "HotelBooking";

    bytes32 public lastSlot;
    bytes public lastValue;
    uint256 public lockedTotal;

    string public bridge;
    uint256 public price;
    uint256 public remain;
    uint256 public lockSize;

    error UnknownSlot(bytes32 slot);

    function __vassp_apply(bytes32 slot, bytes calldata value) external {
        lastSlot = slot;
        lastValue = value;

        if (slot == keccak256(abi.encodePacked("VASSP", CONTRACT_NAME, "LOCK_TOTAL"))) {
            lockedTotal = abi.decode(value, (uint256));
            return;
        }

        if (slot == keccak256(abi.encodePacked("VASSP", CONTRACT_NAME, "META"))) {
            (bridge, price, remain, lockSize) = abi.decode(
                value,
                (string, uint256, uint256, uint256)
            );
            return;
        }

        revert UnknownSlot(slot);
    }
}
