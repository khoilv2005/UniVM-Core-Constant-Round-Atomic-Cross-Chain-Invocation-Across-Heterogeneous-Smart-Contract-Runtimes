// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract LTrain {
    function bookOutbound(
        uint256 ticketPrice,
        uint256 seatsRemaining,
        uint256 num
    ) external pure returns (uint256 newRemainingSeats, uint256 totalCost) {
        require(seatsRemaining >= num, "Insufficient seats");
        newRemainingSeats = seatsRemaining - num;
        totalCost = ticketPrice * num;
    }

    function bookReturn(
        uint256 ticketPrice,
        uint256 seatsRemaining,
        uint256 num
    ) external pure returns (uint256 newRemainingSeats, uint256 totalCost) {
        require(seatsRemaining >= num, "Insufficient return seats");
        newRemainingSeats = seatsRemaining - num;
        totalCost = ticketPrice * num;
    }
}