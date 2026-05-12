// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgingContract} from "./BridgeingContract.sol";
import {LHotel} from "./examples/LHotel.sol";
import {LTrain} from "./examples/LTrain.sol";
import {LFlight} from "./examples/LFlight.sol";
import {LTaxi} from "./examples/LTaxi.sol";

contract CrossChainTravelDepthDApp {
    uint256 public constant TX_ID_OFFSET = 1_000_000;

    BridgingContract public bridgingContract;
    address public lHotel;
    address public lTrain;
    address public lFlight;
    address public lTaxi;

    uint256 public defaultTimeoutBlocks;

    modifier onlyBridgingContract() {
        require(msg.sender == address(bridgingContract), "Not bridging contract");
        _;
    }

    enum CCSCStatus {
        None,
        Initiated,
        Locking,
        LockFailed,
        Executing,
        ExecutionFailed,
        Updating,
        Completed,
        RolledBack
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
        address[] invokedStateContracts;
        uint256[] invokedChainIds;
        bytes hotelUpdateData;
        bytes trainUpdateData;
        bytes flightUpdateData;
        bytes taxiUpdateData;
        uint256 totalCost;
    }

    mapping(uint256 => CCSCExecution) public executions;
    uint256 public executionCount;

    mapping(uint256 => mapping(uint256 => bool)) public lockResponseReceivedByIndex;
    mapping(uint256 => mapping(uint256 => bytes)) public lockedStateByIndex;
    mapping(uint256 => mapping(uint256 => uint256)) public chainResponseCount;
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
    event LockResponseReceived(uint256 indexed crossChainTxId, uint256 indexed stateIndex, uint256 chainId, bytes stateData);
    event LockingPhaseCompleted(uint256 indexed crossChainTxId);
    event IntegratedExecutionCompleted(uint256 indexed crossChainTxId, uint256 totalCost, uint256 depth);
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
        address _lFlight,
        address _lTaxi,
        uint256 _defaultTimeoutBlocks
    ) {
        require(_bridgingContract != address(0), "Zero bridge address");
        bridgingContract = BridgingContract(payable(_bridgingContract));
        lHotel = _lHotel;
        lTrain = _lTrain;
        lFlight = _lFlight;
        lTaxi = _lTaxi;
        defaultTimeoutBlocks = _defaultTimeoutBlocks;
    }

    function initiateExecution(
        uint256 numRooms,
        uint256 numOutboundTickets,
        uint256 numReturnTickets
    ) external returns (uint256) {
        require(numRooms > 0, "Must book at least 1 room");
        uint256 txId = TX_ID_OFFSET + (++executionCount);
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

    function startLocking(
        uint256 txId,
        address[] calldata stateContracts,
        uint256[] calldata chainIds
    ) external validExecution(txId) {
        require(stateContracts.length > 0, "No state contracts");
        require(stateContracts.length == chainIds.length, "Length mismatch");

        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Initiated || exec.status == CCSCStatus.Locking, "Cannot start locking");

        exec.status = CCSCStatus.Locking;
        exec.invokedStateContracts = stateContracts;
        exec.invokedChainIds = chainIds;

        emit LockingPhaseStarted(txId, stateContracts, chainIds);
    }

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
        for (uint256 i = 0; i < stateDataList.length; i++) {
            _recordLockResponse(txId, chainId, stateDataList[i]);
        }
    }

    function _recordLockResponse(
        uint256 txId,
        uint256 chainId,
        bytes memory stateData
    ) internal {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Locking, "Not in locking phase");

        uint256 ordinal = ++chainResponseCount[txId][chainId];
        uint256 slot = _lockSlotForChain(exec.invokedStateContracts.length, chainId, ordinal);
        require(slot < exec.invokedStateContracts.length, "Unexpected lock response");
        require(!lockResponseReceivedByIndex[txId][slot], "Duplicate lock response");

        lockResponseReceivedByIndex[txId][slot] = true;
        lockedStateByIndex[txId][slot] = stateData;
        emit LockResponseReceived(txId, slot, chainId, stateData);

        if (_allLockResponsesReceived(txId)) {
            _proceedToExecution(txId);
        }
    }

    function _proceedToExecution(uint256 txId) internal {
        CCSCExecution storage exec = executions[txId];
        uint256 depth = exec.invokedStateContracts.length + 1;
        exec.status = CCSCStatus.Executing;

        uint256 totalCost = 0;
        if (exec.invokedStateContracts.length >= 1) {
            (uint256 hotelPrice, uint256 hotelRemain) = _decodeState(lockedStateByIndex[txId][0]);
            if (hotelRemain < exec.numRooms) {
                _triggerRollback(txId, CCSCStatus.Locking, "Insufficient hotel rooms");
                return;
            }
            (uint256 newHotelRemain, uint256 hotelCost) = LHotel(lHotel).book(hotelPrice, hotelRemain, exec.numRooms);
            exec.hotelUpdateData = abi.encode(txId, newHotelRemain, exec.user, exec.numRooms, hotelCost);
            totalCost += hotelCost;
        }

        if (exec.invokedStateContracts.length >= 2) {
            (uint256 trainPrice, uint256 trainSeats) = _decodeState(lockedStateByIndex[txId][1]);
            if (trainSeats < exec.numOutboundTickets + exec.numReturnTickets) {
                _triggerRollback(txId, CCSCStatus.Locking, "Insufficient train seats");
                return;
            }
            (uint256 seatsAfterOutbound, uint256 outboundCost) =
                LTrain(lTrain).bookOutbound(trainPrice, trainSeats, exec.numOutboundTickets);
            (uint256 finalSeats, uint256 returnCost) =
                LTrain(lTrain).bookReturn(trainPrice, seatsAfterOutbound, exec.numReturnTickets);
            exec.trainUpdateData = abi.encode(
                txId,
                finalSeats,
                exec.user,
                exec.numOutboundTickets,
                exec.numReturnTickets,
                outboundCost + returnCost
            );
            totalCost += outboundCost + returnCost;
        }

        if (exec.invokedStateContracts.length >= 3) {
            (uint256 flightPrice, uint256 flightRemain) = _decodeState(lockedStateByIndex[txId][2]);
            if (flightRemain < exec.numRooms) {
                _triggerRollback(txId, CCSCStatus.Locking, "Insufficient flight seats");
                return;
            }
            (uint256 newFlightRemain, uint256 flightCost) = LFlight(lFlight).book(flightPrice, flightRemain, exec.numRooms);
            exec.flightUpdateData = abi.encode(txId, newFlightRemain, exec.user, exec.numRooms, flightCost);
            totalCost += flightCost;
        }

        if (exec.invokedStateContracts.length >= 4) {
            (uint256 taxiPrice, uint256 taxiRemain) = _decodeState(lockedStateByIndex[txId][3]);
            if (taxiRemain < exec.numRooms) {
                _triggerRollback(txId, CCSCStatus.Locking, "Insufficient taxis");
                return;
            }
            (uint256 newTaxiRemain, uint256 taxiCost) = LTaxi(lTaxi).book(taxiPrice, taxiRemain, exec.numRooms);
            exec.taxiUpdateData = abi.encode(txId, newTaxiRemain, exec.user, exec.numRooms, taxiCost);
            totalCost += taxiCost;
        }

        exec.totalCost = totalCost;
        exec.status = CCSCStatus.Updating;
        emit IntegratedExecutionCompleted(txId, totalCost, depth);
        emit LockingPhaseCompleted(txId);
        emit UpdatingPhaseStarted(txId);
    }

    function startUpdating(uint256 txId) external validExecution(txId) {
        require(executions[txId].status == CCSCStatus.Updating, "Not in updating phase");
        emit UpdatingPhaseStarted(txId);
    }

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

    function confirmUpdateComplete(uint256 txId) external validExecution(txId) {
        require(executions[txId].status == CCSCStatus.Updating, "Not in updating phase");
        require(_allUpdateAcksReceived(txId), "Not all update acks received");
        _completeExecution(txId);
    }

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

    function checkTimeout(uint256 txId) external validExecution(txId) {
        CCSCExecution storage exec = executions[txId];
        require(
            exec.status == CCSCStatus.Locking
                || exec.status == CCSCStatus.Executing
                || exec.status == CCSCStatus.Updating,
            "Cannot check timeout"
        );
        if ((block.number - exec.startBlock) > exec.timeoutBlocks) {
            CCSCStatus fromStatus = exec.status;
            exec.status = CCSCStatus.RolledBack;
            emit TimeoutDetected(txId);
            emit CrossChainExecutionRolledBack(txId, fromStatus, "Timeout exceeded");
        }
    }

    function getExecutionStatus(uint256 txId) external view returns (CCSCStatus) {
        return executions[txId].status;
    }

    function getUpdatePayloads(uint256 txId) external view validExecution(txId) returns (
        address[] memory stateContracts,
        uint256[] memory chainIds,
        bytes[] memory updateData
    ) {
        CCSCExecution storage exec = executions[txId];
        require(exec.status == CCSCStatus.Updating || exec.status == CCSCStatus.Completed, "Not ready for update");

        uint256 len = exec.invokedStateContracts.length;
        stateContracts = new address[](len);
        chainIds = new uint256[](len);
        updateData = new bytes[](len);

        for (uint256 i = 0; i < len; i++) {
            stateContracts[i] = exec.invokedStateContracts[i];
            chainIds[i] = exec.invokedChainIds[i];
            if (i == 0) {
                updateData[i] = exec.hotelUpdateData;
            } else if (i == 1) {
                updateData[i] = exec.trainUpdateData;
            } else if (i == 2) {
                updateData[i] = exec.flightUpdateData;
            } else if (i == 3) {
                updateData[i] = exec.taxiUpdateData;
            }
        }
    }

    function _allLockResponsesReceived(uint256 txId) internal view returns (bool) {
        CCSCExecution storage exec = executions[txId];
        for (uint256 i = 0; i < exec.invokedStateContracts.length; i++) {
            if (!lockResponseReceivedByIndex[txId][i]) {
                return false;
            }
        }
        return exec.invokedStateContracts.length > 0;
    }

    function _allUpdateAcksReceived(uint256 txId) internal view returns (bool) {
        CCSCExecution storage exec = executions[txId];
        for (uint256 i = 0; i < exec.invokedStateContracts.length; i++) {
            if (!updateAckReceived[txId][exec.invokedStateContracts[i]]) {
                return false;
            }
        }
        return exec.invokedStateContracts.length > 0;
    }

    function _triggerRollback(uint256 txId, CCSCStatus fromStatus, string memory reason) internal {
        executions[txId].status = CCSCStatus.RolledBack;
        emit CrossChainExecutionRolledBack(txId, fromStatus, reason);
        emit LockingPhaseCompleted(txId);
    }

    function _decodeState(bytes memory stateData) internal pure returns (uint256 a, uint256 b) {
        return abi.decode(stateData, (uint256, uint256));
    }

    function _getEffectiveTimeout(uint256 dappTimeout) internal view returns (uint256) {
        uint256 bridgeTimeout = bridgingContract.bridgeTimeoutBlocks();
        return dappTimeout < bridgeTimeout ? dappTimeout : bridgeTimeout;
    }

    function _completeExecution(uint256 txId) internal {
        if (executions[txId].status == CCSCStatus.Completed) {
            return;
        }
        executions[txId].status = CCSCStatus.Completed;
        emit UpdatingPhaseCompleted(txId);
        emit CrossChainExecutionCompleted(txId);
    }

    function _lockSlotForChain(uint256 len, uint256 chainId, uint256 ordinal) internal pure returns (uint256) {
        if (len == 1) {
            if (chainId == 2 && ordinal == 1) return 0;
        } else if (len == 2) {
            if (chainId == 2 && ordinal == 1) return 0;
            if (chainId == 3 && ordinal == 1) return 1;
        } else if (len == 3) {
            if (chainId == 2 && ordinal == 1) return 0;
            if (chainId == 3 && ordinal == 1) return 1;
            if (chainId == 2 && ordinal == 2) return 2;
        } else if (len == 4) {
            if (chainId == 2 && ordinal == 1) return 0;
            if (chainId == 3 && ordinal == 1) return 1;
            if (chainId == 2 && ordinal == 2) return 2;
            if (chainId == 3 && ordinal == 2) return 3;
        }
        return type(uint256).max;
    }
}
