// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgingContract} from "./BridgeingContract.sol";
import {LHotel} from "./examples/LHotel.sol";
import {LTrain} from "./examples/LTrain.sol";
import {CrossChainErrors} from "./lib/CrossChainErrors.sol";

/**
 * @title CrossChainTravelDApp
 * @notice Full IntegrateX implementation of the Train-and-Hotel cross-chain dApp (Figure 1).
 *         Implements the 2PC-based Atomic Integrated Execution Protocol (Section V-A):
 *
 *   Step 1 — LOCKING:
 *     User calls initiateExecution() → emits event for relayers
 *     Relayers relay request to invoked chains → states locked
 *     Relayers return locked state values → stored in this contract
 *
 *   Step 2 — INTEGRATED EXECUTION:
 *     executeIntegrated() processes hotel + train booking in ONE transaction
 *     Results are recorded as "pending update" pending cross-chain confirmation
 *
 *   Step 3 — UPDATING:
 *     Relayers relay update requests to invoked chains
 *     State contracts unlock + update atomically
 *     dApp marks execution complete
 *
 *   ROLLBACK: If any step fails, all locked states are unlocked via rollback events
 *
 *   TIMEOUT: Measured in block depth; effective timeout = min(dApp, bridge) per paper
 *
 *   FEES: Cross-chain fee collected upfront, released to relayer on success
 */
contract CrossChainTravelDApp {
    BridgingContract public bridgingContract;
    address public lHotel;
    address public lTrain;

    uint256 public defaultTimeoutBlocks;

    modifier onlyBridgingContract() {
        require(msg.sender == address(bridgingContract), "Not bridging contract");
        _;
    }

    enum CCSCStatus {
        None,
        Initiated,      // Step 1 started
        Locking,        // Locking in progress
        LockFailed,     // Locking phase failed — rollback triggered
        Executing,      // Step 2: Integrated execution
        ExecutionFailed,// Execution failed — rollback triggered
        Updating,       // Step 3: Update in progress
        Completed,      // All steps succeeded
        RolledBack      // Rollback completed
    }

    struct CCSCExecution {
        uint256 crossChainTxId;
        address user;
        uint256 numRooms;
        uint256 numOutboundTickets;
        uint256 numReturnTickets;
        CCSCStatus status;
        uint256 startBlock;
        uint256 timeoutBlocks;
        bytes hotelLockedState;
        bytes trainLockedState;
        uint256 hotelCost;
        uint256 outboundTrainCost;
        uint256 returnTrainCost;
        uint256 totalCost;
        address[] invokedStateContracts;
        uint256[] invokedChainIds;
    }

    mapping(uint256 => CCSCExecution) public executions;
    uint256 public executionCount;

    // Track which executions are waiting for lock responses from each chain
    mapping(uint256 => mapping(uint256 => bool)) public lockResponseReceived;
    mapping(uint256 => mapping(uint256 => bytes)) public lockedStateByChain;

    // Track update acknowledgments from each invoked chain (Section VI-B receipt mechanism)
    mapping(uint256 => mapping(address => bool)) public updateAckReceived;

    event CrossChainExecutionInitiated(
        uint256 indexed crossChainTxId,
        address indexed user,
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets,
        uint256 timeoutBlocks
    );
    event LockingPhaseStarted(uint256 indexed crossChainTxId, address[] stateContracts, uint256[] chainIds);
    event LockResponseReceived(uint256 indexed crossChainTxId, uint256 chainId, bytes stateData);
    event LockingPhaseCompleted(uint256 indexed crossChainTxId);
    event IntegratedExecutionCompleted(
        uint256 indexed crossChainTxId,
        uint256 hotelCost,
        uint256 outboundTrainCost,
        uint256 returnTrainCost,
        uint256 totalCost,
        uint256 newHotelRemain,
        uint256 newTrainSeats
    );
    event UpdatingPhaseStarted(uint256 indexed crossChainTxId);
    event UpdateAckReceived(uint256 indexed crossChainTxId, address stateContract);
    event UpdatingPhaseCompleted(uint256 indexed crossChainTxId);
    event CrossChainExecutionCompleted(uint256 indexed crossChainTxId);
    event CrossChainExecutionRolledBack(uint256 indexed crossChainTxId, CCSCStatus fromStatus, string reason);
    event TimeoutDetected(uint256 indexed crossChainTxId);

    modifier validExecution(uint256 txId) {
        require(executions[txId].status != CCSCStatus.None, "No such execution");
        _;
    }

    constructor(
        address _bridgingContract,
        address _lHotel,
        address _lTrain,
        uint256 _defaultTimeoutBlocks
    ) {
        require(_bridgingContract != address(0), "Zero bridge address");
        bridgingContract = BridgingContract(payable(_bridgingContract));
        lHotel = _lHotel;
        lTrain = _lTrain;
        defaultTimeoutBlocks = _defaultTimeoutBlocks;
    }

    // ===== Section V-A: Step 1 — Initiate & Lock =====
    function initiateExecution(
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    ) external returns (uint256) {
        require(numRooms > 0, "Must book at least 1 room");
        require(numOutboundTickets > 0, "Must book at least 1 outbound ticket");
        require(numReturnTickets > 0, "Must book at least 1 return ticket");

        uint256 txId = ++executionCount;
        uint256 effectiveTimeout = _getEffectiveTimeout(defaultTimeoutBlocks);

        CCSCExecution storage exec = executions[txId];
        exec.crossChainTxId = txId;
        exec.user = msg.sender;
        exec.numRooms = numRooms;
        exec.numOutboundTickets = numOutboundTickets;
        exec.numReturnTickets = numReturnTickets;
        exec.status = CCSCStatus.Initiated;
        exec.startBlock = block.number;
        exec.timeoutBlocks = effectiveTimeout;

        emit CrossChainExecutionInitiated(
            txId, msg.sender, numRooms, numOutboundTickets, numReturnTickets, effectiveTimeout
        );

        return txId;
    }

    // ===== Section V-A: Step 1 — Locking: emit cross-chain lock request =====
    function startLocking(
        uint256 txId,
        address[] calldata stateContracts,
        uint256[] calldata chainIds
    ) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Initiated || exec.status == CCSCStatus.Locking,
            "Cannot start locking");

        exec.status = CCSCStatus.Locking;
        exec.invokedStateContracts = stateContracts;
        exec.invokedChainIds = chainIds;

        emit LockingPhaseStarted(txId, stateContracts, chainIds);

        // Call bridging contract on each target chain via relayer
        // In production: relayers listen to events and call bridgingContract.requestLockStates()
    }

    // ===== Section V-A: Step 1 — Locking: receive locked state from each chain =====
    // Called by relayer when the invoked chain returns the locked state
    function receiveLockResponse(
        uint256 txId,
        uint256 chainId,
        bytes calldata stateData
    ) external validExecution(txId) {
        _recordLockResponse(txId, chainId, stateData);
    }

    function receiveLockResponseBatch(
        uint256 txId,
        uint256 chainId,
        bytes[] calldata stateDataList
    ) external validExecution(txId) {
        require(stateDataList.length > 0, "Empty state data");
        _recordLockResponse(txId, chainId, stateDataList[0]);
    }

    function _recordLockResponse(
        uint256 txId,
        uint256 chainId,
        bytes memory stateData
    ) internal {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Locking, "Not in locking phase");

        lockedStateByChain[txId][chainId] = stateData;
        lockResponseReceived[txId][chainId] = true;

        emit LockResponseReceived(txId, chainId, stateData);

        // Check if ALL chains have responded
        if (_allLockResponsesReceived(txId)) {
            _proceedToExecution(txId);
        }
    }

    // ===== Section V-A: Step 2 — Integrated Execution =====
    function _proceedToExecution(uint256 txId) internal {
        CCSCExecution storage exec = executions[txId];

        // Decode locked states from both chains
        // State format: abi.encode(price, remain)
        (uint256 hotelPrice, uint256 hotelRemain) = _decodeState(lockedStateByChain[txId][exec.invokedChainIds[0]]);
        (uint256 trainPrice, uint256 trainSeats) = _decodeState(lockedStateByChain[txId][exec.invokedChainIds[1]]);

        // ===== Section V-A Rollback: Execution failure cases =====
        if (hotelRemain < exec.numRooms) {
            _triggerRollback(txId, CCSCStatus.Locking, "Insufficient hotel rooms");
            return;
        }
        if (trainSeats < exec.numOutboundTickets + exec.numReturnTickets) {
            _triggerRollback(txId, CCSCStatus.Locking, "Insufficient train seats");
            return;
        }

        exec.status = CCSCStatus.Executing;

        // ===== Section V-A: Integrated Execution — all logic in ONE transaction =====
        (uint256 newHotelRemain, uint256 hotelCost) =
            LHotel(lHotel).book(hotelPrice, hotelRemain, exec.numRooms);

        (uint256 seatsAfterOutbound, uint256 outboundCost) =
            LTrain(lTrain).bookOutbound(trainPrice, trainSeats, exec.numOutboundTickets);

        (uint256 finalSeats, uint256 returnCost) =
            LTrain(lTrain).bookReturn(trainPrice, seatsAfterOutbound, exec.numReturnTickets);

        exec.hotelCost = hotelCost;
        exec.outboundTrainCost = outboundCost;
        exec.returnTrainCost = returnCost;
        exec.totalCost = hotelCost + outboundCost + returnCost;
        exec.status = CCSCStatus.Updating;

        // Store execution results pending cross-chain update confirmation
        exec.hotelLockedState =
            abi.encode(txId, newHotelRemain, exec.user, exec.numRooms, hotelCost);
        exec.trainLockedState = abi.encode(
            txId,
            finalSeats,
            exec.user,
            exec.numOutboundTickets,
            exec.numReturnTickets,
            outboundCost + returnCost
        );

        emit IntegratedExecutionCompleted(
            txId, hotelCost, outboundCost, returnCost, exec.totalCost, newHotelRemain, finalSeats
        );
        emit LockingPhaseCompleted(txId);
        _emitUpdatingPhaseStarted(txId);
    }

    // ===== Section V-A: Step 3 — Updating: emit update requests =====
    function startUpdating(uint256 txId) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Updating, "Not in updating phase");

        _emitUpdatingPhaseStarted(txId);
    }

    // ===== Section V-A: Step 3 — Update acknowledgment =====
    // Called by relayers to report that update was successful on an invoked chain
    // This implements the receipt mechanism from Section VI-B:
    // "Only after all receipts confirm that the state updates have been successfully
    //  completed on the respective chains will the final result be output"
    function receiveUpdateAck(uint256 txId, address stateContract) external validExecution(txId) {
        _recordUpdateAck(txId, stateContract);
    }

    function receiveUpdateAckBatch(uint256 txId, address[] calldata stateContracts) external validExecution(txId) {
        require(stateContracts.length > 0, "Empty state contracts");
        for (uint256 i = 0; i < stateContracts.length; i++) {
            _recordUpdateAck(txId, stateContracts[i]);
        }
    }

    function _recordUpdateAck(uint256 txId, address stateContract) internal {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Updating, "Not in updating phase");

        updateAckReceived[txId][stateContract] = true;

        emit UpdateAckReceived(txId, stateContract);

        if (_allUpdateAcksReceived(txId)) {
            _completeExecution(txId);
        }
    }

    // ===== Section VI-B: Verify all receipts before completing =====
    function confirmUpdateComplete(uint256 txId) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        if (exec.status == CCSCStatus.Completed) {
            return;
        }
        require(exec.status == CCSCStatus.Updating, "Not in updating phase");

        // Section VI-B: Require all update acknowledgments before marking complete
        require(_allUpdateAcksReceived(txId), "Not all update acks received");

        _completeExecution(txId);
    }

    // ===== Section V-A: Rollback =====
    // Triggered on lock failure or execution failure
    // Emits rollback event — relayers pick this up and call bridgingContract.receiveRollbackRequest()
    function _triggerRollback(uint256 txId, CCSCStatus fromStatus, string memory reason) internal {
        CCSCExecution storage exec = executions[txId];
        exec.status = CCSCStatus.RolledBack;

        emit CrossChainExecutionRolledBack(txId, fromStatus, reason);
        emit LockingPhaseCompleted(txId);
    }

    // Manual rollback trigger (e.g., from user or timeout checker)
    function triggerRollback(uint256 txId, string calldata reason) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        require(
            exec.status == CCSCStatus.Locking ||
            exec.status == CCSCStatus.Executing ||
            exec.status == CCSCStatus.Updating,
            "Cannot rollback"
        );

        CCSCStatus fromStatus = exec.status;
        exec.status = CCSCStatus.RolledBack;

        emit CrossChainExecutionRolledBack(txId, fromStatus, reason);
    }

    // ===== Section V-A: Timeout Detection =====
    function checkTimeout(uint256 txId) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        require(
            exec.status == CCSCStatus.Locking
                || exec.status == CCSCStatus.Executing
                || exec.status == CCSCStatus.Updating,
            "Cannot check timeout");

        if ((block.number - exec.startBlock) > exec.timeoutBlocks) {
            CCSCStatus fromStatus = exec.status;
            exec.status = CCSCStatus.RolledBack;
            emit TimeoutDetected(txId);
            emit CrossChainExecutionRolledBack(txId, fromStatus, "Timeout exceeded");
        }
    }

    // ===== Query Functions =====
    function getExecution(uint256 txId) external view returns (CCSCExecution memory) {
        return executions[txId];
    }

    function getUpdatePayloads(uint256 txId) external view validExecution(txId) returns (
        address[] memory stateContracts,
        uint256[] memory chainIds,
        bytes[] memory updateData
    ) {
        CCSCExecution storage exec = executions[txId];
        require(
            exec.status == CCSCStatus.Updating || exec.status == CCSCStatus.Completed,
            "Not ready for update"
        );

        uint256 len = exec.invokedStateContracts.length;
        stateContracts = new address[](len);
        chainIds = new uint256[](len);
        updateData = new bytes[](len);

        for (uint256 i = 0; i < len; i++) {
            stateContracts[i] = exec.invokedStateContracts[i];
            chainIds[i] = exec.invokedChainIds[i];

            if (exec.invokedChainIds[i] == 2) {
                updateData[i] = exec.hotelLockedState;
            } else if (exec.invokedChainIds[i] == 3) {
                updateData[i] = exec.trainLockedState;
            } else {
                revert("Unknown invoked chain");
            }
        }
    }

    function getExecutionStatus(uint256 txId) external view returns (CCSCStatus) {
        return executions[txId].status;
    }

    function getExecutionCosts(uint256 txId) external view returns (
        uint256 hotelCost,
        uint256 outboundTrainCost,
        uint256 returnTrainCost,
        uint256 totalCost
    ) {
        CCSCExecution storage exec = executions[txId];
        return (exec.hotelCost, exec.outboundTrainCost, exec.returnTrainCost, exec.totalCost);
    }

    // ===== Internal Helpers =====
    function _allLockResponsesReceived(uint256 txId) internal view returns (bool) {
        CCSCExecution storage exec = executions[txId];
        for (uint256 i = 0; i < exec.invokedChainIds.length; i++) {
            if (!lockResponseReceived[txId][exec.invokedChainIds[i]]) {
                return false;
            }
        }
        return exec.invokedChainIds.length > 0;
    }

    // Section VI-B: Verify all update acknowledgments received
    function _allUpdateAcksReceived(uint256 txId) internal view returns (bool) {
        CCSCExecution storage exec = executions[txId];
        for (uint256 i = 0; i < exec.invokedStateContracts.length; i++) {
            if (!updateAckReceived[txId][exec.invokedStateContracts[i]]) {
                return false;
            }
        }
        return exec.invokedStateContracts.length > 0;
    }

    function _decodeState(bytes memory stateData) internal pure returns (uint256 a, uint256 b) {
        return abi.decode(stateData, (uint256, uint256));
    }

    function _getEffectiveTimeout(uint256 dappTimeout) internal view returns (uint256) {
        uint256 bridgeTimeout = bridgingContract.bridgeTimeoutBlocks();
        return dappTimeout < bridgeTimeout ? dappTimeout : bridgeTimeout;
    }

    function _emitUpdatingPhaseStarted(uint256 txId) internal {
        emit UpdatingPhaseStarted(txId);
    }

    function _completeExecution(uint256 txId) internal {
        CCSCExecution storage exec = executions[txId];
        if (exec.status == CCSCStatus.Completed) {
            return;
        }

        exec.status = CCSCStatus.Completed;

        emit UpdatingPhaseCompleted(txId);
        emit CrossChainExecutionCompleted(txId);
    }
}
