// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPACTLockableStorage} from "../GPACTLockableStorage.sol";
import {IGPACTApp} from "../interfaces/IGPACTApp.sol";

/// @notice Extra resource for RQ1b (call tree depth = 5).
///         Reserves a taxi ride; same provisional-lock pattern.
contract GPACTTaxi is Ownable, GPACTLockableStorage, IGPACTApp {
    uint256 public ridePrice;
    uint256 public carsAvailable;
    address public crosschainControl;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public rides;

    modifier onlyCrosschainControl() {
        require(msg.sender == crosschainControl, "Not crosschain control");
        _;
    }

    constructor(uint256 ridePrice_, uint256 cars_, address crosschainControl_) Ownable(msg.sender) {
        require(crosschainControl_ != address(0), "Zero control");
        ridePrice = ridePrice_;
        carsAvailable = cars_;
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
        (address user, uint256 cars) = abi.decode(callData, (address, uint256));
        require(user != address(0), "Zero user");
        require(cars > 0, "Zero cars");
        require(carsAvailable >= cars, "Insufficient cars");

        carsAvailable -= cars;
        uint256 totalCost = cars * ridePrice;
        _lockForTx(crosschainTxId, timeoutBlocks);
        _storeProvisional(crosschainTxId, abi.encode(user, cars, totalCost));

        return (abi.encode(totalCost), true);
    }

    function gpactRoot(bytes32, bytes calldata) external pure returns (bool, bool) {
        revert("Taxi root unsupported");
    }

    function gpactSignal(bytes32 crosschainTxId, bool commit) external onlyCrosschainControl {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (address user, uint256 cars, uint256 totalCost) =
            abi.decode(provisional, (address, uint256, uint256));

        if (commit) {
            accounts[user] += totalCost;
            rides[user] += cars;
        } else {
            carsAvailable += cars;
        }
        _clearLock(crosschainTxId);
    }

    function gpactTimeoutUnlock(bytes32 crosschainTxId) external {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (, uint256 cars, ) = abi.decode(provisional, (address, uint256, uint256));
        carsAvailable += cars;
        _timeoutLock(crosschainTxId);
    }
}
