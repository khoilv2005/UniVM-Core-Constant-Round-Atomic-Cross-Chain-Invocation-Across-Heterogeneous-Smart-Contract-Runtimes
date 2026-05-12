// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Extra ATOM service for RQ1b (depth = 4).
///         Mirrors AtomHotel/AtomTrain patterns (lock_do / unlock / undo_unlock).
contract AtomFlight is Ownable {
    uint256 public seatPrice;
    uint256 public seatsAvailable;
    address public atomServer;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    struct PendingBooking {
        bool ifLocked;
        bytes32 lockHash;
        uint256 backupSeats;
        address user;
        uint256 seats;
        uint256 totalCost;
    }

    mapping(bytes32 => PendingBooking) public pendingBookings;

    event AtomFlightRead(bytes32 indexed invokeId, uint256 seats, uint256 seatPrice);
    event AtomFlightLocked(bytes32 indexed invokeId, address indexed user, uint256 seats, bytes32 lockHash);
    event AtomFlightUnlocked(bytes32 indexed invokeId, address indexed user, uint256 seats);
    event AtomFlightUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 seats);

    modifier onlyAtomServer() {
        require(msg.sender == atomServer, "Not atom server");
        _;
    }

    constructor(uint256 seatPrice_, uint256 seats_, address atomServer_) Ownable(msg.sender) {
        require(atomServer_ != address(0), "Zero atom server");
        seatPrice = seatPrice_;
        seatsAvailable = seats_;
        atomServer = atomServer_;
    }

    function setAtomServer(address atomServer_) external onlyOwner {
        require(atomServer_ != address(0), "Zero atom server");
        atomServer = atomServer_;
    }

    function getSeats_atomic(bytes32 invokeId) external onlyAtomServer returns (uint256) {
        emit AtomFlightRead(invokeId, seatsAvailable, seatPrice);
        return seatsAvailable;
    }

    function book_lock_do(
        bytes32 invokeId,
        bytes32 lockHash,
        address user,
        uint256 seats
    ) external onlyAtomServer {
        require(user != address(0), "Zero user");
        require(seats > 0, "Zero seats");

        PendingBooking storage pending = pendingBookings[invokeId];
        require(!pending.ifLocked, "Already locked");
        require(seatsAvailable >= seats, "Insufficient seats");

        uint256 totalCost = seats * seatPrice;
        pending.ifLocked = true;
        pending.lockHash = lockHash;
        pending.backupSeats = seatsAvailable;
        pending.user = user;
        pending.seats = seats;
        pending.totalCost = totalCost;

        seatsAvailable -= seats;
        emit AtomFlightLocked(invokeId, user, seats, lockHash);
    }

    function book_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        accounts[pending.user] += pending.totalCost;
        bookings[pending.user] += pending.seats;

        emit AtomFlightUnlocked(invokeId, pending.user, pending.seats);
        delete pendingBookings[invokeId];
    }

    function book_undo_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        seatsAvailable = pending.backupSeats;
        emit AtomFlightUndoUnlocked(invokeId, pending.user, pending.seats);
        delete pendingBookings[invokeId];
    }
}
