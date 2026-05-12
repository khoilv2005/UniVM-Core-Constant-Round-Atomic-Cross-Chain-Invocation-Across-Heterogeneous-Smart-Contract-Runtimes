// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract CallTreeMathTarget {
    function seed(uint256 value) external pure returns (uint256) {
        return value;
    }

    function add(uint256 lhs, uint256 rhs) external pure returns (uint256) {
        return lhs + rhs;
    }

    function mul(uint256 lhs, uint256 rhs) external pure returns (uint256) {
        return lhs * rhs;
    }

    function alwaysFail(uint256) external pure returns (uint256) {
        revert("boom");
    }
}
