// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StateContractBase} from "../StateContractBase.sol";
import {LTrain} from "./LTrain.sol";
import {LockPoolLib} from "../lib/LockPoolLib.sol";

contract STrain is StateContractBase {
    uint256 public ticketPrice;
    uint256 public seats;
    address public addrLTrain;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public outboundBookings;
    mapping(address => uint256) public returnBookings;

    constructor(
        uint256 _ticketPrice,
        uint256 _seats,
        address _addrLTrain,
        address _bridgingContract,
        uint256 _lockSize
    ) {
        ticketPrice = _ticketPrice;
        seats = _seats;
        addrLTrain = _addrLTrain;
        bridgingContract = _bridgingContract;
        lockSize = _lockSize;
    }

    // ===== View functions =====
    function getTicketPrice() external view returns (uint256) { return ticketPrice; }
    function getSeats() external view returns (uint256) { return seats; }
    function getAvailableSeats() external view returns (uint256) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
        return seats - lockedSeats;
    }
    function getAccountBalance(address user) external view returns (uint256) { return accounts[user]; }

    // ===== Local booking via logic contract =====
    function bookOutboundLocal(address userAddr, uint256 num) external onlyAuthorizedOrBridge returns (uint256) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
        uint256 available = seats - lockedSeats;
        require(available >= num, "Insufficient available seats");

        (uint256 newSeats, uint256 totalCost) = LTrain(addrLTrain).bookOutbound(ticketPrice, available, num);
        seats = lockedSeats + newSeats;
        accounts[userAddr] += totalCost;
        outboundBookings[userAddr] += num;
        return totalCost;
    }

    function bookReturnLocal(address userAddr, uint256 num) external onlyAuthorizedOrBridge returns (uint256) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
        uint256 available = seats - lockedSeats;
        require(available >= num, "Insufficient available return seats");

        (uint256 newSeats, uint256 totalCost) = LTrain(addrLTrain).bookReturn(ticketPrice, available, num);
        seats = lockedSeats + newSeats;
        accounts[userAddr] += totalCost;
        returnBookings[userAddr] += num;
        return totalCost;
    }

    // ===== Cross-chain interface =====
    function lockState(bytes calldata args)
        external
        override
        onlyBridgingContract
        returns (uint256, uint256)
    {
        (uint256 crossChainTxId, uint256 numSeats, uint256 timeoutBlocks) =
            abi.decode(args, (uint256, uint256, uint256));

        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
        uint256 available = seats - lockedSeats;
        require(available >= numSeats, "Insufficient seats for lock");

        uint256 amountToLock;
        if (numSeats > 0) {
            amountToLock = numSeats * ticketPrice;
        } else {
            amountToLock = lockSize * ticketPrice;
        }

        LockPoolLib.lock(_lockPool, crossChainTxId, amountToLock, timeoutBlocks);

        return (ticketPrice, seats);
    }

    function updateState(bytes calldata args) external override onlyBridgingContract {
        (
            uint256 crossChainTxId,
            uint256 newSeats,
            address userAddr,
            uint256 outboundNum,
            uint256 returnNum,
            uint256 totalCost
        ) = abi.decode(args, (uint256, uint256, address, uint256, uint256, uint256));

        LockPoolLib.unlock(_lockPool, crossChainTxId);
        seats = newSeats;
        accounts[userAddr] += totalCost;
        outboundBookings[userAddr] += outboundNum;
        returnBookings[userAddr] += returnNum;
    }

    function lockStateForCrossChain(
        uint256 crossChainTxId,
        uint256 numSeats,
        uint256 timeoutBlocks
    ) external onlyBridgingContract returns (bytes memory) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
        uint256 available = seats - lockedSeats;
        require(available >= numSeats, "Insufficient seats");

        uint256 amountToLock = numSeats * ticketPrice;
        LockPoolLib.lock(_lockPool, crossChainTxId, amountToLock, timeoutBlocks);

        return abi.encode(ticketPrice, seats);
    }

    function getLockedSeats() external view returns (uint256) {
        return LockPoolLib.getLockedTotal(_lockPool) / ticketPrice;
    }
}
