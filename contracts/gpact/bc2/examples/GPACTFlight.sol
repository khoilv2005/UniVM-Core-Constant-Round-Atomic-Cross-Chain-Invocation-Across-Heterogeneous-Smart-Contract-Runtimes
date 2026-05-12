// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPACTLockableStorage} from "../GPACTLockableStorage.sol";
import {IGPACTApp} from "../interfaces/IGPACTApp.sol";

/// @notice Extra resource for RQ1b (call tree depth = 4).
///         Mirrors the Hotel/Train pattern: provisional decrement on segment,
///         commit/abort on signalling.
contract GPACTFlight is Ownable, GPACTLockableStorage, IGPACTApp {
    uint256 public seatPrice;
    uint256 public seatsAvailable;
    address public crosschainControl;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    modifier onlyCrosschainControl() {
        require(msg.sender == crosschainControl, "Not crosschain control");
        _;
    }

    constructor(uint256 seatPrice_, uint256 seats_, address crosschainControl_) Ownable(msg.sender) {
        require(crosschainControl_ != address(0), "Zero control");
        seatPrice = seatPrice_;
        seatsAvailable = seats_;
        crosschainControl = crosschainControl_;
    }

    function setCrosschainControl(address crosschainControl_) external onlyOwner {
        require(crosschainControl_ != address(0), "Zero control");
        crosschainControl = crosschainControl_;
    }

    function gpactSegment(bytes32 crosschainTxId, bytes calldata callData, uint256 timeoutBlocks)
        external
        onlyCrosschainControl
        returns (bytes memory result, bool lockedContractsUsed)
    {
        (address user, uint256 seats) = abi.decode(callData, (address, uint256));
        require(user != address(0), "Zero user");
        require(seats > 0, "Zero seats");
        require(seatsAvailable >= seats, "Insufficient seats");

        seatsAvailable -= seats;

        uint256 totalCost = seats * seatPrice;
        _lockForTx(crosschainTxId, timeoutBlocks);
        _storeProvisional(crosschainTxId, abi.encode(user, seats, totalCost));

        return (abi.encode(totalCost), true);
    }

    function gpactRoot(bytes32, bytes calldata) external pure returns (bool, bool) {
        revert("Flight root unsupported");
    }

    function gpactSignal(bytes32 crosschainTxId, bool commit) external onlyCrosschainControl {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (address user, uint256 seats, uint256 totalCost) =
            abi.decode(provisional, (address, uint256, uint256));

        if (commit) {
            accounts[user] += totalCost;
            bookings[user] += seats;
        } else {
            seatsAvailable += seats;
        }
        _clearLock(crosschainTxId);
    }

    function gpactTimeoutUnlock(bytes32 crosschainTxId) external {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (, uint256 seats, ) = abi.decode(provisional, (address, uint256, uint256));
        seatsAvailable += seats;
        _timeoutLock(crosschainTxId);
    }
}
