// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StateContractBase} from "../StateContractBase.sol";
import {LFlight} from "./LFlight.sol";
import {LockPoolLib} from "../lib/LockPoolLib.sol";

/// @notice Extra state contract for RQ1b (depth = 4).
///         Mirrors SHotel/STrain pattern (fine-grained lock pool).
contract SFlight is StateContractBase {
    uint256 public price;
    uint256 public remain;
    address public addrLFlight;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    constructor(
        uint256 _price,
        uint256 _remain,
        address _addrLFlight,
        address _bridgingContract,
        uint256 _lockSize
    ) {
        price = _price;
        remain = _remain;
        addrLFlight = _addrLFlight;
        bridgingContract = _bridgingContract;
        lockSize = _lockSize;
    }

    function getPrice() external view returns (uint256) { return price; }
    function getRemain() external view returns (uint256) { return remain; }
    function getAvailableRemain() external view returns (uint256) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / price;
        return remain - lockedSeats;
    }

    function bookLocal(address userAddr, uint256 num) external onlyAuthorizedOrBridge returns (uint256) {
        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedSeats;
        require(available >= num, "Insufficient available seats");

        (uint256 newRemain, uint256 totalCost) = LFlight(addrLFlight).book(price, available, num);

        remain = lockedSeats + newRemain;
        accounts[userAddr] += totalCost;
        bookings[userAddr] += num;
        return totalCost;
    }

    function lockState(bytes calldata args)
        external
        override
        onlyBridgingContract
        returns (uint256, uint256)
    {
        (uint256 crossChainTxId, uint256 numSeats, uint256 timeoutBlocks) =
            abi.decode(args, (uint256, uint256, uint256));

        uint256 lockedSeats = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedSeats;
        require(available >= numSeats, "Insufficient remain for lock");

        uint256 amountToLock = numSeats > 0 ? numSeats * price : lockSize * price;
        LockPoolLib.lock(_lockPool, crossChainTxId, amountToLock, timeoutBlocks);
        return (price, remain);
    }

    function updateState(bytes calldata args) external override onlyBridgingContract {
        (uint256 crossChainTxId, uint256 newRemain, address userAddr, uint256 num, uint256 totalCost) =
            abi.decode(args, (uint256, uint256, address, uint256, uint256));

        LockPoolLib.unlock(_lockPool, crossChainTxId);
        remain = newRemain;
        accounts[userAddr] += totalCost;
        bookings[userAddr] += num;
    }
}
