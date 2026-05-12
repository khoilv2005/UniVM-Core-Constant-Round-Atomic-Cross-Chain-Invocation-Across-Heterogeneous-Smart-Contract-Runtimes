// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Extra ATOM service for RQ1b (depth = 5).
contract AtomTaxi is Ownable {
    uint256 public ridePrice;
    uint256 public carsAvailable;
    address public atomServer;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public rides;

    struct PendingBooking {
        bool ifLocked;
        bytes32 lockHash;
        uint256 backupCars;
        address user;
        uint256 cars;
        uint256 totalCost;
    }

    mapping(bytes32 => PendingBooking) public pendingBookings;

    event AtomTaxiRead(bytes32 indexed invokeId, uint256 cars, uint256 ridePrice);
    event AtomTaxiLocked(bytes32 indexed invokeId, address indexed user, uint256 cars, bytes32 lockHash);
    event AtomTaxiUnlocked(bytes32 indexed invokeId, address indexed user, uint256 cars);
    event AtomTaxiUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 cars);

    modifier onlyAtomServer() {
        require(msg.sender == atomServer, "Not atom server");
        _;
    }

    constructor(uint256 ridePrice_, uint256 cars_, address atomServer_) Ownable(msg.sender) {
        require(atomServer_ != address(0), "Zero atom server");
        ridePrice = ridePrice_;
        carsAvailable = cars_;
        atomServer = atomServer_;
    }

    function setAtomServer(address atomServer_) external onlyOwner {
        require(atomServer_ != address(0), "Zero atom server");
        atomServer = atomServer_;
    }

    function getCars_atomic(bytes32 invokeId) external onlyAtomServer returns (uint256) {
        emit AtomTaxiRead(invokeId, carsAvailable, ridePrice);
        return carsAvailable;
    }

    function book_lock_do(
        bytes32 invokeId,
        bytes32 lockHash,
        address user,
        uint256 cars
    ) external onlyAtomServer {
        require(user != address(0), "Zero user");
        require(cars > 0, "Zero cars");

        PendingBooking storage pending = pendingBookings[invokeId];
        require(!pending.ifLocked, "Already locked");
        require(carsAvailable >= cars, "Insufficient cars");

        uint256 totalCost = cars * ridePrice;
        pending.ifLocked = true;
        pending.lockHash = lockHash;
        pending.backupCars = carsAvailable;
        pending.user = user;
        pending.cars = cars;
        pending.totalCost = totalCost;

        carsAvailable -= cars;
        emit AtomTaxiLocked(invokeId, user, cars, lockHash);
    }

    function book_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        accounts[pending.user] += pending.totalCost;
        rides[pending.user] += pending.cars;

        emit AtomTaxiUnlocked(invokeId, pending.user, pending.cars);
        delete pendingBookings[invokeId];
    }

    function book_undo_unlock(bytes32 invokeId, bytes calldata hashKey) external onlyAtomServer {
        PendingBooking storage pending = pendingBookings[invokeId];
        require(pending.ifLocked, "Not locked");
        require(keccak256(hashKey) == pending.lockHash, "Invalid hash key");

        carsAvailable = pending.backupCars;
        emit AtomTaxiUndoUnlocked(invokeId, pending.user, pending.cars);
        delete pendingBookings[invokeId];
    }
}
