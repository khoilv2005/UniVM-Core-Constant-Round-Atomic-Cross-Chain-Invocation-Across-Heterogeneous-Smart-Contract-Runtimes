// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract LFlight {
    function book(
        uint256 price,
        uint256 remain,
        uint256 num
    ) external pure returns (uint256 newRemain, uint256 totalCost) {
        require(remain >= num, "Insufficient seats");
        newRemain = remain - num;
        totalCost = price * num;
    }
}
