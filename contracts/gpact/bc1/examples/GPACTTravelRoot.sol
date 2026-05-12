// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IGPACTApp} from "../interfaces/IGPACTApp.sol";
import {IGPACTCrosschainControl} from "../interfaces/IGPACTCrosschainControl.sol";

contract GPACTTravelRoot is Ownable, IGPACTApp {
    IGPACTCrosschainControl public crosschainControl;

    struct BookingRequest {
        address user;
        uint256 rooms;
        uint256 outboundTickets;
        uint256 returnTickets;
        bool exists;
    }

    mapping(bytes32 => bool) public started;
    mapping(bytes32 => bool) public completed;
    mapping(bytes32 => bool) public aborted;
    mapping(bytes32 => BookingRequest) private _requests;

    event BookingStarted(bytes32 indexed crosschainTxId, address indexed user, uint256 rooms, uint256 outbound, uint256 returnTickets);

    constructor(address crosschainControlAddress) Ownable(msg.sender) {
        require(crosschainControlAddress != address(0), "Zero control");
        crosschainControl = IGPACTCrosschainControl(crosschainControlAddress);
    }

    function setCrosschainControl(address crosschainControlAddress) external onlyOwner {
        require(crosschainControlAddress != address(0), "Zero control");
        crosschainControl = IGPACTCrosschainControl(crosschainControlAddress);
    }

    function startBooking(
        bytes32 crosschainTxId,
        uint256 rooms,
        uint256 outboundTickets,
        uint256 returnTickets,
        uint256 timeoutBlock
    ) external {
        require(crosschainTxId != bytes32(0), "Zero tx id");
        require(!started[crosschainTxId], "Already started");

        _requests[crosschainTxId] = BookingRequest({
            user: msg.sender,
            rooms: rooms,
            outboundTickets: outboundTickets,
            returnTickets: returnTickets,
            exists: true
        });

        bytes memory callTree = abi.encode(msg.sender, rooms, outboundTickets, returnTickets);
        crosschainControl.start(crosschainTxId, 1, callTree, timeoutBlock);
        started[crosschainTxId] = true;

        emit BookingStarted(crosschainTxId, msg.sender, rooms, outboundTickets, returnTickets);
    }

    function gpactSegment(bytes32, bytes calldata, uint256) external pure returns (bytes memory, bool) {
        revert("Root segment unsupported");
    }

    function gpactRoot(bytes32 crosschainTxId, bytes calldata callData)
        external
        view
        returns (bool commit, bool abortTx)
    {
        require(started[crosschainTxId], "Unknown tx");
        (
            address user,
            uint256 rooms,
            uint256 outboundTickets,
            uint256 returnTickets,
            uint256[] memory segmentIds,
            bytes32[] memory segmentResultHashes
        ) = abi.decode(callData, (address, uint256, uint256, uint256, uint256[], bytes32[]));
        require(user != address(0), "Zero user");
        require(rooms > 0, "Zero rooms");
        require(outboundTickets + returnTickets > 0, "Zero tickets");
        require(segmentIds.length > 0, "No segment results");
        require(segmentIds.length == segmentResultHashes.length, "Segment result mismatch");
        for (uint256 i = 0; i < segmentResultHashes.length; i++) {
            require(segmentIds[i] > 0, "Zero segment id");
            require(segmentResultHashes[i] != bytes32(0), "Zero segment result");
        }
        return (true, false);
    }

    function gpactSignal(bytes32 crosschainTxId, bool commit) external {
        require(started[crosschainTxId], "Unknown tx");
        if (commit) {
            completed[crosschainTxId] = true;
        } else {
            aborted[crosschainTxId] = true;
        }
    }

    /// @inheritdoc IGPACTApp
    function gpactTimeoutUnlock(bytes32 crosschainTxId) external {
        // Root has no locked state on this chain: just record timeout as abort.
        require(started[crosschainTxId], "Unknown tx");
        aborted[crosschainTxId] = true;
    }

    function getBookingRequest(bytes32 crosschainTxId)
        external
        view
        returns (address user, uint256 rooms, uint256 outboundTickets, uint256 returnTickets, bool exists)
    {
        BookingRequest storage request = _requests[crosschainTxId];
        return (
            request.user,
            request.rooms,
            request.outboundTickets,
            request.returnTickets,
            request.exists
        );
    }
}
