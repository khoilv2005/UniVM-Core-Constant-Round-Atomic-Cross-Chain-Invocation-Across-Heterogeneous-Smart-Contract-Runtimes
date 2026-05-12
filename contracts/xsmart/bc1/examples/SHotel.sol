// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StateContractBase} from "../StateContractBase.sol";
import {LHotel} from "./LHotel.sol";
import {LockPoolLib} from "../lib/LockPoolLib.sol";

contract SHotel is StateContractBase {
    uint256 public price;
    uint256 public remain;
    address public addrLHotel;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    constructor(
        uint256 _price,
        uint256 _remain,
        address _addrLHotel,
        address _bridgingContract,
        uint256 _lockSize
    ) {
        price = _price;
        remain = _remain;
        addrLHotel = _addrLHotel;
        bridgingContract = _bridgingContract;
        lockSize = _lockSize;
    }

    // ===== View functions (Section IV-A: "all the view functions that read the contract's state") =====
    function getPrice() external view returns (uint256) { return price; }
    function getRemain() external view returns (uint256) { return remain; }
    function getAvailableRemain() external view returns (uint256) {
        uint256 lockedRooms = LockPoolLib.getLockedTotal(_lockPool) / price;
        return remain - lockedRooms;
    }
    function getAccountBalance(address user) external view returns (uint256) { return accounts[user]; }
    function getBooking(address user) external view returns (uint256) { return bookings[user]; }

    // ===== Section IV-A: State contract calls logic contract for normal interaction =====
    function bookLocal(address userAddr, uint256 num) external onlyAuthorizedOrBridge returns (uint256) {
        uint256 lockedRooms = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedRooms;
        require(available >= num, "Insufficient available rooms");

        (uint256 newRemain, uint256 totalCost) = LHotel(addrLHotel).book(price, available, num);

        remain = lockedRooms + newRemain;
        accounts[userAddr] += totalCost;
        bookings[userAddr] += num;

        return totalCost;
    }

    // ===== Section V-A: Called by bridging contract on invoked chain =====
    function lockState(bytes calldata args)
        external
        override
        onlyBridgingContract
        returns (uint256, uint256)
    {
        (uint256 crossChainTxId, uint256 numRooms, uint256 timeoutBlocks) =
            abi.decode(args, (uint256, uint256, uint256));

        uint256 lockedRooms = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedRooms;
        require(available >= numRooms, "Insufficient remain for lock");

        // Section V-C: Fine-grained lock — lock exact amount if derivable,
        // otherwise use lockSize as fixed-size increment for dynamic states
        uint256 amountToLock;
        if (numRooms > 0) {
            amountToLock = numRooms * price;
        } else {
            amountToLock = lockSize * price;
        }

        LockPoolLib.lock(_lockPool, crossChainTxId, amountToLock, timeoutBlocks);

        return (price, remain);
    }

    function updateState(bytes calldata args) external override onlyBridgingContract {
        (uint256 crossChainTxId, uint256 newRemain, address userAddr, uint256 num, uint256 totalCost) =
            abi.decode(args, (uint256, uint256, address, uint256, uint256));

        // Section V-A: updateState unlocks + updates atomically
        LockPoolLib.unlock(_lockPool, crossChainTxId);

        remain = newRemain;
        accounts[userAddr] += totalCost;
        bookings[userAddr] += num;
    }

    // ===== Section V-A: Return locked state for cross-chain transmission =====
    function lockStateForCrossChain(
        uint256 crossChainTxId,
        uint256 numRooms,
        uint256 timeoutBlocks
    ) external onlyBridgingContract returns (bytes memory) {
        uint256 lockedRooms = LockPoolLib.getLockedTotal(_lockPool) / price;
        uint256 available = remain - lockedRooms;
        require(available >= numRooms, "Insufficient remain");

        uint256 amountToLock = numRooms * price;
        LockPoolLib.lock(_lockPool, crossChainTxId, amountToLock, timeoutBlocks);

        return abi.encode(price, remain);
    }

    function getLockedRemain() external view returns (uint256) {
        return LockPoolLib.getLockedTotal(_lockPool) / price;
    }
}
