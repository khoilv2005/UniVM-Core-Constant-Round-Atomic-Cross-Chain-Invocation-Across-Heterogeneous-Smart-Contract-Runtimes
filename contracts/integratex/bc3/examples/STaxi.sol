// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StateContractBase} from "../StateContractBase.sol";
import {LTaxi} from "./LTaxi.sol";
import {LockPoolLib} from "../lib/LockPoolLib.sol";

/// @notice Extra state contract for RQ1b (depth = 5).
contract STaxi is StateContractBase {
    uint256 public price;
    uint256 public remain;
    address public addrLTaxi;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    constructor(
        uint256 _price,
        uint256 _remain,
        address _addrLTaxi,
        address _bridgingContract,
        uint256 _lockSize
    ) {
        price = _price;
        remain = _remain;
        addrLTaxi = _addrLTaxi;
        bridgingContract = _bridgingContract;
        lockSize = _lockSize;
    }

    function getPrice() external view returns (uint256) { return price; }
    function getRemain() external view returns (uint256) { return remain; }
    function getAvailableRemain() external view returns (uint256) {
        uint256 lockedCars = LockPoolLib.getLockedTotal(_lockPool) / price;
        return remain - lockedCars;
    }

    function bookLocal(address userAddr, uint256 num) external onlyAuthorizedOrBridge returns (uint256) {
        uint256 lockedCars = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedCars;
        require(available >= num, "Insufficient available cars");

        (uint256 newRemain, uint256 totalCost) = LTaxi(addrLTaxi).book(price, available, num);

        remain = lockedCars + newRemain;
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
        (uint256 crossChainTxId, uint256 numCars, uint256 timeoutBlocks) =
            abi.decode(args, (uint256, uint256, uint256));

        uint256 lockedCars = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedCars;
        require(available >= numCars, "Insufficient remain for lock");

        uint256 amountToLock = numCars > 0 ? numCars * price : lockSize * price;
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
