// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AtomHotel is Ownable {
    uint256 public roomPrice;
    uint256 public remain;
    address public atomServer;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    struct PendingBooking {
        bool ifLocked;
        bytes32 lockHash;
        uint256 backupRemain;
        address user;
        uint256 rooms;
        uint256 totalCost;
    }

    mapping(bytes32 => PendingBooking) public pendingBookings;

    event AtomHotelRead(bytes32 indexed invokeId, uint256 remain, uint256 roomPrice);
    event AtomHotelLocked(bytes32 indexed invokeId, address indexed user, uint256 rooms, bytes32 lockHash);
    event AtomHotelUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms);
    event AtomHotelUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms);

    modifier onlyAtomServer() {
        require(msg.sender == atomServer, "Not atom server");
        _;
    }

    constructor(uint256 roomPrice_, uint256 remain_, address atomServer_) Ownable(msg.sender) {
        require(atomServer_ != address(0), "Zero atom server");
        roomPrice = roomPrice_;
        remain = remain_;
        atomServer = atomServer_;
    }

    function setAtomServer(address atomServer_) external onlyOwner {
        require(atomServer_ != address(0), "Zero atom server");
        atomServer = atomServer_;
    }

    function getRemain_atomic(bytes32 invokeId) external onlyAtomServer returns (uint256) {
        emit AtomHotelRead(invokeId, remain, roomPrice);
        return remain;
    }

    function book_lock_do(
        bytes32 invokeId,
        bytes32 lockHash,
        address user,
        uint256 rooms
    ) external onlyAtomServer {
        require(user != address(0), "Zero user");
        require(rooms > 0, "Zero rooms");

        PendingBooking storage pending = pendingBookings[invokeId];
        require(!pending.ifLocked, "Already locked");
        require(remain >= rooms, "Insufficient remain");

        uint256 totalCost = rooms * roomPrice;

        pending.ifLocked = true;
        pending.lockHash = lockHash;
        pending.backupRemain = remain;
        pending.user = user;
        pending.rooms = rooms;
        pending.totalCost = totalCost;

        remain -= rooms;

        emit AtomHotelLocked(invokeId, user, rooms, lockHash);
    }

    function book_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        accounts[pending.user] += pending.totalCost;
        bookings[pending.user] += pending.rooms;

        emit AtomHotelUnlocked(invokeId, pending.user, pending.rooms);
        delete pendingBookings[invokeId];
    }

    function book_undo_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        remain = pending.backupRemain;

        emit AtomHotelUndoUnlocked(invokeId, pending.user, pending.rooms);
        delete pendingBookings[invokeId];
    }
}

