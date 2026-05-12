// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AtomEntry} from "../AtomEntry.sol";

/// @notice Benchmark-only ATOM entry for RQ1b.
///         Unlike AtomTravelEntry, this contract allows the caller to choose
///         the total operation count dynamically so the same ATOM stack can be
///         exercised at different call-tree depths.
contract AtomTravelDepthEntry is AtomEntry {
    bytes32 private constant HOTEL_WRITE_FUNCTION_ID = keccak256("hotel-write");
    bytes32 private constant TRAIN_WRITE_FUNCTION_ID = keccak256("train-write");
    bytes32 private constant FLIGHT_WRITE_FUNCTION_ID = keccak256("flight-write");
    bytes32 private constant TAXI_WRITE_FUNCTION_ID = keccak256("taxi-write");

    event WriteOnlyInvocationRequested(
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

    function invokeWriteOnlyDepth(
        bytes32 invokeId,
        uint256 totalOperationCount,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    ) external {
        require(invokeId != bytes32(0), "Zero invoke id");
        require(totalOperationCount > 0, "Zero operation count");
        require(numRooms > 0, "Zero rooms");
        require(totalOperationCount <= 4, "Unsupported operation count");

        bytes32[] memory requiredFunctionIds = new bytes32[](totalOperationCount);
        requiredFunctionIds[0] = HOTEL_WRITE_FUNCTION_ID;
        if (totalOperationCount >= 2) {
            requiredFunctionIds[1] = TRAIN_WRITE_FUNCTION_ID;
        }
        if (totalOperationCount >= 3) {
            requiredFunctionIds[2] = FLIGHT_WRITE_FUNCTION_ID;
        }
        if (totalOperationCount >= 4) {
            requiredFunctionIds[3] = TAXI_WRITE_FUNCTION_ID;
        }
        _requireRemoteFunctionsRegistered(requiredFunctionIds);

        bytes32 workflowId = keccak256(
            abi.encodePacked("atom-travel-write-only-depth-", totalOperationCount)
        );
        _startInvocation(invokeId, workflowId, totalOperationCount);

        emit WriteOnlyInvocationRequested(
            invokeId,
            msg.sender,
            numRooms,
            numOutboundTickets,
            numReturnTickets
        );
    }
}
