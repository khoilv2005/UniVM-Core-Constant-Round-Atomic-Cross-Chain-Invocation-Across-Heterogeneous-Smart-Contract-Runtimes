// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AtomEntry} from "../AtomEntry.sol";

contract AtomTravelEntry is AtomEntry {
    bytes32 public constant WRITE_ONLY_WORKFLOW_ID = keccak256("atom-travel-write-only");
    bytes32 public constant READ_WRITE_WORKFLOW_ID = keccak256("atom-travel-read-write");
    bytes32 private constant HOTEL_READ_FUNCTION_ID = keccak256("hotel-read");
    bytes32 private constant HOTEL_WRITE_FUNCTION_ID = keccak256("hotel-write");
    bytes32 private constant TRAIN_WRITE_FUNCTION_ID = keccak256("train-write");

    enum TravelWorkflowType {
        None,
        WriteOnly,
        ReadWrite
    }

    struct TravelRequest {
        address user;
        uint256 numRooms;
        uint256 numOutboundTickets;
        uint256 numReturnTickets;
        TravelWorkflowType workflowType;
        bool exists;
    }

    mapping(bytes32 => TravelRequest) private _requests;

    event WriteOnlyInvocationRequested(
        bytes32 indexed invokeId,
        address indexed user,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    );
    event ReadWriteInvocationRequested(
        bytes32 indexed invokeId,
        address indexed user,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    );

    constructor(
        address atomServiceAddress,
        address atomRemoteRegistryAddress,
        address atomServerAddress,
        uint256 judgeNumNeed_,
        uint256 judgeNumMin_,
        uint256 maxServiceTimeBlocks_,
        uint256 maxAuditTimeBlocks_
    )
        AtomEntry(
            atomServiceAddress,
            atomRemoteRegistryAddress,
            atomServerAddress,
            judgeNumNeed_,
            judgeNumMin_,
            maxServiceTimeBlocks_,
            maxAuditTimeBlocks_
        )
    {}

    function invokeWriteOnly(
        bytes32 invokeId,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    ) external {
        require(!_requests[invokeId].exists, "Invocation exists");
        require(numRooms > 0, "Zero rooms");
        require(numOutboundTickets > 0, "Zero outbound tickets");
        require(numReturnTickets > 0, "Zero return tickets");

        _requests[invokeId] = TravelRequest({
            user: msg.sender,
            numRooms: numRooms,
            numOutboundTickets: numOutboundTickets,
            numReturnTickets: numReturnTickets,
            workflowType: TravelWorkflowType.WriteOnly,
            exists: true
        });

        bytes32[] memory requiredFunctionIds = new bytes32[](2);
        requiredFunctionIds[0] = HOTEL_WRITE_FUNCTION_ID;
        requiredFunctionIds[1] = TRAIN_WRITE_FUNCTION_ID;
        _requireRemoteFunctionsRegistered(requiredFunctionIds);

        _startInvocation(invokeId, WRITE_ONLY_WORKFLOW_ID, 2);

        emit WriteOnlyInvocationRequested(
            invokeId,
            msg.sender,
            numRooms,
            numOutboundTickets,
            numReturnTickets
        );
    }

    function invokeReadWrite(
        bytes32 invokeId,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    ) external {
        require(!_requests[invokeId].exists, "Invocation exists");
        require(numRooms > 0, "Zero rooms");
        require(numOutboundTickets > 0, "Zero outbound tickets");
        require(numReturnTickets > 0, "Zero return tickets");

        _requests[invokeId] = TravelRequest({
            user: msg.sender,
            numRooms: numRooms,
            numOutboundTickets: numOutboundTickets,
            numReturnTickets: numReturnTickets,
            workflowType: TravelWorkflowType.ReadWrite,
            exists: true
        });

        bytes32[] memory requiredFunctionIds = new bytes32[](3);
        requiredFunctionIds[0] = HOTEL_READ_FUNCTION_ID;
        requiredFunctionIds[1] = HOTEL_WRITE_FUNCTION_ID;
        requiredFunctionIds[2] = TRAIN_WRITE_FUNCTION_ID;
        _requireRemoteFunctionsRegistered(requiredFunctionIds);

        _startInvocation(invokeId, READ_WRITE_WORKFLOW_ID, 3);

        emit ReadWriteInvocationRequested(
            invokeId,
            msg.sender,
            numRooms,
            numOutboundTickets,
            numReturnTickets
        );
    }

    function getRequest(bytes32 invokeId)
        external
        view
        returns (
            address user,
            uint256 numRooms,
            uint256 numOutboundTickets,
            uint256 numReturnTickets,
            TravelWorkflowType workflowType,
            bool exists
        )
    {
        TravelRequest storage request = _requests[invokeId];
        return (
            request.user,
            request.numRooms,
            request.numOutboundTickets,
            request.numReturnTickets,
            request.workflowType,
            request.exists
        );
    }
}
