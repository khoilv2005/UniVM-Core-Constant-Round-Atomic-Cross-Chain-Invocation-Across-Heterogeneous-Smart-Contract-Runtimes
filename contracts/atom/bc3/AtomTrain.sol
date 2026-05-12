// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AtomTrain is Ownable {
    uint256 public ticketPrice;
    uint256 public seats;
    address public atomServer;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public outboundBookings;
    mapping(address => uint256) public returnBookings;

    struct PendingBooking {
        bool ifLocked;
        bytes32 lockHash;
        uint256 backupSeats;
        address user;
        uint256 outboundTickets;
        uint256 returnTickets;
        uint256 totalCost;
    }

    mapping(bytes32 => PendingBooking) public pendingBookings;

    event AtomTrainRead(bytes32 indexed invokeId, uint256 seats, uint256 ticketPrice);
    event AtomTrainLocked(
        bytes32 indexed invokeId,
        address indexed user,
        uint256 outboundTickets,
        uint256 returnTickets,
        bytes32 lockHash
    );
    event AtomTrainUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets);
    event AtomTrainUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets);

    modifier onlyAtomServer() {
        require(msg.sender == atomServer, "Not atom server");
        _;
    }

    constructor(uint256 ticketPrice_, uint256 seats_, address atomServer_) Ownable(msg.sender) {
        require(atomServer_ != address(0), "Zero atom server");
        ticketPrice = ticketPrice_;
        seats = seats_;
        atomServer = atomServer_;
    }

    function setAtomServer(address atomServer_) external onlyOwner {
        require(atomServer_ != address(0), "Zero atom server");
        atomServer = atomServer_;
    }

    function getSeats_atomic(bytes32 invokeId) external onlyAtomServer returns (uint256) {
        emit AtomTrainRead(invokeId, seats, ticketPrice);
        return seats;
    }

    function book_lock_do(
        bytes32 invokeId,
        bytes32 lockHash,
        address user,
        uint256 outboundTickets,
        uint256 returnTickets
    ) external onlyAtomServer {
        require(user != address(0), "Zero user");
        require(outboundTickets + returnTickets > 0, "Zero tickets");

        PendingBooking storage pending = pendingBookings[invokeId];
        require(!pending.ifLocked, "Already locked");

        uint256 totalTickets = outboundTickets + returnTickets;
        require(seats >= totalTickets, "Insufficient seats");

        pending.ifLocked = true;
        pending.lockHash = lockHash;
        pending.backupSeats = seats;
        pending.user = user;
        pending.outboundTickets = outboundTickets;
        pending.returnTickets = returnTickets;
        pending.totalCost = totalTickets * ticketPrice;

        seats -= totalTickets;

        emit AtomTrainLocked(invokeId, user, outboundTickets, returnTickets, lockHash);
    }

    function book_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        accounts[pending.user] += pending.totalCost;
        outboundBookings[pending.user] += pending.outboundTickets;
        returnBookings[pending.user] += pending.returnTickets;

        emit AtomTrainUnlocked(invokeId, pending.user, pending.outboundTickets, pending.returnTickets);
        delete pendingBookings[invokeId];
    }

    function book_undo_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        seats = pending.backupSeats;

        emit AtomTrainUndoUnlocked(invokeId, pending.user, pending.outboundTickets, pending.returnTickets);
        delete pendingBookings[invokeId];
    }
}

