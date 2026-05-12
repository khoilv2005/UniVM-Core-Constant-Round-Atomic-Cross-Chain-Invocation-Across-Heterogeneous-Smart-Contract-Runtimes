// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPACTLockableStorage} from "../GPACTLockableStorage.sol";
import {IGPACTApp} from "../interfaces/IGPACTApp.sol";

contract GPACTHotel is Ownable, GPACTLockableStorage, IGPACTApp {
    uint256 public roomPrice;
    uint256 public remain;
    address public crosschainControl;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public bookings;

    modifier onlyCrosschainControl() {
        require(msg.sender == crosschainControl, "Not crosschain control");
        _;
    }

    constructor(uint256 roomPrice_, uint256 remain_, address crosschainControl_) Ownable(msg.sender) {
        require(crosschainControl_ != address(0), "Zero control");
        roomPrice = roomPrice_;
        remain = remain_;
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
        (address user, uint256 rooms) = abi.decode(callData, (address, uint256));
        require(user != address(0), "Zero user");
        require(rooms > 0, "Zero rooms");
        require(remain >= rooms, "Insufficient remain");

        // GP-3 fix: provisionally decrease remain to prevent over-commitment
        remain -= rooms;

        uint256 totalCost = rooms * roomPrice;
        _lockForTx(crosschainTxId, timeoutBlocks);
        _storeProvisional(crosschainTxId, abi.encode(user, rooms, totalCost));

        return (abi.encode(totalCost), true);
    }

    function gpactRoot(bytes32, bytes calldata) external pure returns (bool, bool) {
        revert("Hotel root unsupported");
    }

    function gpactSignal(bytes32 crosschainTxId, bool commit) external onlyCrosschainControl {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (address user, uint256 rooms, uint256 totalCost) = abi.decode(provisional, (address, uint256, uint256));

        if (commit) {
            // remain already decreased in gpactSegment, just update accounts
            accounts[user] += totalCost;
            bookings[user] += rooms;
        } else {
            // GP-3 fix: restore remain on abort
            remain += rooms;
        }

        _clearLock(crosschainTxId);
    }

    /**
     * @notice Allow anyone to free a stuck lock after timeout.
     *         Restores the provisionally decreased remain.
     */
    function timeoutLock(bytes32 crosschainTxId) external {
        _restoreAndTimeout(crosschainTxId);
    }

    /// @inheritdoc IGPACTApp
    function gpactTimeoutUnlock(bytes32 crosschainTxId) external {
        _restoreAndTimeout(crosschainTxId);
    }

    function _restoreAndTimeout(bytes32 crosschainTxId) private {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (, uint256 rooms, ) = abi.decode(provisional, (address, uint256, uint256));
        remain += rooms;
        _timeoutLock(crosschainTxId);
    }
}
