// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPACTLockableStorage} from "../GPACTLockableStorage.sol";
import {IGPACTApp} from "../interfaces/IGPACTApp.sol";

contract GPACTTrain is Ownable, GPACTLockableStorage, IGPACTApp {
    uint256 public ticketPrice;
    uint256 public seats;
    address public crosschainControl;

    mapping(address => uint256) public accounts;
    mapping(address => uint256) public outboundBookings;
    mapping(address => uint256) public returnBookings;

    modifier onlyCrosschainControl() {
        require(msg.sender == crosschainControl, "Not crosschain control");
        _;
    }

    constructor(uint256 ticketPrice_, uint256 seats_, address crosschainControl_) Ownable(msg.sender) {
        require(crosschainControl_ != address(0), "Zero control");
        ticketPrice = ticketPrice_;
        seats = seats_;
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
        (address user, uint256 outboundTickets, uint256 returnTickets) = abi.decode(callData, (address, uint256, uint256));
        require(user != address(0), "Zero user");
        uint256 totalTickets = outboundTickets + returnTickets;
        require(totalTickets > 0, "Zero tickets");
        require(seats >= totalTickets, "Insufficient seats");

        // GP-3 fix: provisionally decrease seats to prevent over-commitment
        seats -= totalTickets;

        uint256 totalCost = totalTickets * ticketPrice;
        _lockForTx(crosschainTxId, timeoutBlocks);
        _storeProvisional(crosschainTxId, abi.encode(user, outboundTickets, returnTickets, totalCost));

        return (abi.encode(totalCost), true);
    }

    function gpactRoot(bytes32, bytes calldata) external pure returns (bool, bool) {
        revert("Train root unsupported");
    }

    function gpactSignal(bytes32 crosschainTxId, bool commit) external onlyCrosschainControl {
        bytes memory provisional = _loadProvisional(crosschainTxId);
        (address user, uint256 outboundTickets, uint256 returnTickets, uint256 totalCost) =
            abi.decode(provisional, (address, uint256, uint256, uint256));

        if (commit) {
            // seats already decreased in gpactSegment, just update accounts
            accounts[user] += totalCost;
            outboundBookings[user] += outboundTickets;
            returnBookings[user] += returnTickets;
        } else {
            // GP-3 fix: restore seats on abort
            uint256 totalTickets = outboundTickets + returnTickets;
            seats += totalTickets;
        }

        _clearLock(crosschainTxId);
    }

    /**
     * @notice Allow anyone to free a stuck lock after timeout.
     *         Restores the provisionally decreased seats.
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
        (, uint256 outboundTickets, uint256 returnTickets, ) =
            abi.decode(provisional, (address, uint256, uint256, uint256));
        seats += outboundTickets + returnTickets;
        _timeoutLock(crosschainTxId);
    }
}
