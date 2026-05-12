// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract LHotel {
    function book(
        uint256 price,
        uint256 remain,
        uint256 num
    ) external pure returns (uint256 newRemain, uint256 totalCost) {
        require(remain >= num, "Insufficient rooms");
        newRemain = remain - num;
        totalCost = price * num;
    }

    function computeRefund(
        uint256 price,
        uint256 num
    ) external pure returns (uint256 refundAmount) {
        refundAmount = price * num;
    }
}