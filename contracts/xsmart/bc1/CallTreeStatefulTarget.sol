// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract CallTreeStatefulTarget {
    uint256 public stored;

    function setValue(uint256 value) external returns (uint256) {
        stored = value;
        return value;
    }
}
