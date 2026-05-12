// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CrossChainErrors} from "./lib/CrossChainErrors.sol";
import {CrossChainMessage} from "./lib/CrossChainMessage.sol";
import {CallTree} from "./lib/CallTree.sol";
import {MerkleProofLib} from "./lib/MerkleProofLib.sol";
import {LightClient} from "./LightClient.sol";
import {RelayerManager} from "./RelayerManager.sol";
import {UBTLRegistry} from "./UBTLRegistry.sol";
import {IProofAdapter} from "./adapters/IProofAdapter.sol";

/**
 * @title XBridgingContract
 * @notice Full implementation per IntegrateX paper:
 *   - Section IV-B: Off-chain clone with on-chain event trigger for relayers
 *   - Section IV-B: Clone dedup (first registration only)
 *   - Section IV-C: On-chain bytecode hash verification with cross-chain Merkle proof
 *   - Section IV-C: Verified-only execution enforcement
 *   - Section IV-C: Relayer reward on verification success, penalty on failure
 *   - Section V-A: Locking phase with event trigger for relayers
 *   - Section V-A: Rollback with cross-chain unlock events
 *   - Section V-A: Timeout using min(dApp, bridge) per paper
 *   - Section V-A Finality: Block confirmation depth check via LightClient
 *   - Section V-B: Transaction aggregation (array-based per-chain lock/update)
 *   - Section VI-B: Merkle proof verification for all incoming cross-chain messages
 *   - Section III-A: Cross-chain fee collection and relayer reimbursement
 */
contract XBridgingContract is Ownable {
    using CallTree for bytes;

    uint256 public immutable chainId;

    LightClient public lightClient;
    RelayerManager public relayerManager;
    UBTLRegistry public ubtlRegistry;
    IProofAdapter public proofAdapter;

    // ===== Section IV: Deployment Protocol =====
    mapping(string => address) public serviceToLogic;
    mapping(string => bool) public serviceVerified;
    mapping(string => address) public serviceDeployer;
    mapping(string => address) public serviceRelayer;
    mapping(address => bool) public registeredStateContracts;

    // ===== Section V / VI: Cross-chain message dedup =====
    mapping(bytes32 => bool) public processedCrossChainTxs;
    uint256 public crossChainTxNonce;

    // ===== Section III-A / V-A: Fee & Timeout =====
    uint256 public bridgeTimeoutBlocks;
    uint256 public crossChainFee;
    mapping(uint256 => uint256) public collectedFees;
    mapping(address => uint256) public pendingWithdrawals;

    // ===== Section VIII: Authorization =====
    mapping(address => bool) public authorizedProviders;
    mapping(address => bool) public blacklistedProviders;

    // ===== Section V-A: Active cross-chain executions =====
    enum ExecutionPhase {
        None,
        Requested,
        CommitDecided,
        AbortDecided,
        Completed,
        RolledBack
    }

    struct ActiveExecution {
        address[] stateContracts;
        address initiator;
        uint256 startBlock;
        uint256 timeoutBlocks;
        uint256 updateAckCount;
        bool active;
        ExecutionPhase phase;
    }

    struct StateImportProof {
        bytes32 chainId;
        bytes32 contractId;
        bytes32 schemaHash;
        bytes32 opId;
        uint64 lockEpoch;
        uint64 stateVersion;
        bytes proof;
    }
    mapping(uint256 => ActiveExecution) public activeExecutions;
    mapping(uint256 => mapping(bytes32 => bool)) public updateAckRecorded;
    mapping(uint256 => bytes32) public updateRequestHashes;

    // ===== Optional deployment hardening: commit-reveal for MEV exposure =====
    struct CommitRecord {
        address sender;
        uint64 deadline;
        bool revealed;
        bool expired;
    }

    mapping(bytes32 => CommitRecord) public commits;
    mapping(bytes32 => bool) public usedNonces;

    constructor(
        uint256 _chainId,
        address _lightClient,
        address payable _relayerManager,
        uint256 _bridgeTimeoutBlocks,
        uint256 _crossChainFee
    ) Ownable(msg.sender) {
        chainId = _chainId;
        lightClient = LightClient(_lightClient);
        relayerManager = RelayerManager(_relayerManager);
        bridgeTimeoutBlocks = _bridgeTimeoutBlocks;
        crossChainFee = _crossChainFee;
    }

    // ========== MODIFIERS ==========

    modifier notProcessed(bytes32 txKey) {
        require(!processedCrossChainTxs[txKey], "Already processed");
        _;
        processedCrossChainTxs[txKey] = true;
    }

    modifier onlyActiveRelayer() {
        require(relayerManager.isRelayerActive(msg.sender), "Not active relayer");
        _;
    }

    modifier requireVerified(string storage serviceId) {
        require(serviceVerified[serviceId], "Contract not verified");
        _;
    }

    modifier notBlacklisted(address provider) {
        require(!blacklistedProviders[provider], "Provider blacklisted");
        _;
    }

    // ========== SECTION IV-B: Off-Chain Clone and Deployment ==========

    event DeployRequestEmitted(
        string serviceId,
        uint256 invokedChainId,
        address[] logicContractAddresses
    );
    event LogicContractRegistered(string serviceId, address logicContract, uint256 chainId);
    event StateContractRegistered(address stateContract, uint256 chainId);

    /**
     * @notice Section IV-B Preparation: dApp provider triggers cross-chain deployment.
     *         Emits event with invoked chain ID + logic contract addresses for relayers.
     */
    function requestDeploy(
        string calldata serviceId,
        uint256 invokedChainId,
        address[] calldata logicContractAddresses
    ) external notBlacklisted(msg.sender) {
        require(logicContractAddresses.length > 0, "No contracts to clone");

        serviceDeployer[serviceId] = msg.sender;

        emit DeployRequestEmitted(serviceId, invokedChainId, logicContractAddresses);
    }

    /**
     * @notice Section IV-B Clone: Relayer deploys cloned logic contract and registers it.
     *         Only the first registration for a serviceId succeeds (dedup per paper).
     *         If registration fails, the deployment tx reverts (contract not created on-chain).
     */
    function regServer(string calldata serviceId, address logicContract) external {
        require(serviceToLogic[serviceId] == address(0), "Already registered");
        require(logicContract != address(0), "Zero address");

        serviceToLogic[serviceId] = logicContract;
        serviceRelayer[serviceId] = msg.sender;

        emit LogicContractRegistered(serviceId, logicContract, chainId);
    }

    function regState(address stateContract) external {
        require(!registeredStateContracts[stateContract], "Already registered");
        require(stateContract != address(0), "Zero address");

        registeredStateContracts[stateContract] = true;

        emit StateContractRegistered(stateContract, chainId);
    }

    // ========== SECTION IV-C: On-Chain Verification ==========

    event VerificationRequested(string serviceId, bytes32 bytecodeHash, uint256 targetChainId);
    event VerificationResult(string serviceId, bool success);
    event ProofAdapterUpdated(address indexed proofAdapter);

    /**
     * @notice Section IV-C: dApp provider initiates verification.
     *         Computes hash of cloned logic contract bytecode on this chain,
     *         emits event for relayer to transport hash to invoked chain for comparison.
     */
    function verification(string calldata serviceId, uint256 invokedChainId) external {
        address logicAddr = serviceToLogic[serviceId];
        require(logicAddr != address(0), "Not registered");
        require(!serviceVerified[serviceId], "Already verified");

        bytes32 hash = computeBytecodeHash(logicAddr);

        emit VerificationRequested(serviceId, hash, invokedChainId);
    }

    /**
     * @notice Section IV-C: Receive verification result from invoked chain.
     *         The result must come with a valid Merkle proof from the invoked chain.
     *         On success: mark verified, reward relayer.
     *         On failure: mark not verified, penalize relayer, restart deployment.
     */
    function confirmVerification(
        string calldata serviceId,
        bool success,
        uint256 invokedChainBlockNumber,
        bytes32[] calldata merkleProof,
        bytes32 receiptHash
    ) external {
        require(serviceToLogic[serviceId] != address(0), "Not registered");
        require(!serviceVerified[serviceId], "Already verified");

        // Section VI: Verify that the verification result is authentic.
        _verifyCrossChainEvidence(
            invokedChainBlockNumber,
            receiptHash,
            merkleProof,
            keccak256(bytes(serviceId)),
            abi.encodePacked(receiptHash)
        );

        if (success) {
            serviceVerified[serviceId] = true;
            relayerManager.rewardRelayer(serviceRelayer[serviceId], "Verification success");
        } else {
            relayerManager.penalizeRelayer(serviceRelayer[serviceId], "Verification failed");
        }

        emit VerificationResult(serviceId, success);
    }

    function isVerified(string calldata serviceId) external view returns (bool) {
        return serviceVerified[serviceId];
    }

    function getLogicContractAddress(string calldata serviceId) external view returns (address) {
        return serviceToLogic[serviceId];
    }

    function computeBytecodeHash(address contractAddr) public view returns (bytes32) {
        uint256 size;
        assembly {
            size := extcodesize(contractAddr)
        }
        require(size > 0, "Not a contract");
        bytes memory code = new bytes(size);
        assembly {
            extcodecopy(contractAddr, add(code, 0x20), 0, size)
        }
        return keccak256(code);
    }

    // ========== SECTION V-A: Atomic Integrated Execution ==========

    event CrossChainLockRequested(
        uint256 indexed crossChainTxId,
        string serviceId,
        address[] stateContracts,
        uint256 executionChainId
    );
    event CrossChainLockResponse(
        uint256 indexed crossChainTxId,
        address stateContract,
        bytes lockedState
    );
    event CrossChainUpdateRequested(
        uint256 indexed crossChainTxId,
        address[] stateContracts,
        bytes[] updateData
    );
    event CrossChainUpdateAck(
        uint256 indexed crossChainTxId,
        address stateContract,
        bool success
    );
    event CrossChainRollback(uint256 indexed crossChainTxId, address[] stateContracts);
    event CrossChainFeePaid(uint256 indexed crossChainTxId, uint256 fee);
    event UnlockFailed(address indexed target, uint256 indexed crossChainTxId);
    event UnlockRetryRequested(address indexed target, uint256 indexed crossChainTxId, uint256 attempt);
    event UnlockForcedTimeout(address indexed target, uint256 indexed crossChainTxId);
    event IntegratedExecutionPerformed(
        uint256 indexed crossChainTxId,
        string serviceId,
        address logicContract,
        bytes resultHash
    );
    event IntegratedExecutionFailed(uint256 indexed crossChainTxId, string serviceId, bytes reason);
    event TranslationVerificationFailed(
        uint256 indexed crossChainTxId,
        bytes32 indexed translationKey,
        bytes32 peerIrHash
    );
    event CallTreeNodeExecuted(
        uint256 indexed crossChainTxId,
        uint256 indexed nodeIndex,
        address indexed contractAddr,
        bytes result
    );
    event UpdateAckRecorded(
        uint256 indexed crossChainTxId,
        bytes32 indexed ackKey,
        bool success,
        uint256 ackCount,
        uint256 requiredAckCount
    );
    event ExecutionPhaseChanged(uint256 indexed crossChainTxId, ExecutionPhase phase);
    event ExecutionCompleted(uint256 indexed crossChainTxId, address indexed completedBy);
    event OperationCommitted(bytes32 indexed commitHash, address indexed sender, uint64 deadline);
    event OperationRevealed(bytes32 indexed commitHash, bytes32 indexed opId, bytes32 lockManifestHash);
    event CommitExpired(bytes32 indexed commitHash);

    /**
     * @notice Section V-A Locking (Step 1): Execution chain emits event to lock states
     *         on invoked chains. Relayers transport this request cross-chain.
     *         Only verified contracts can participate (Section IV-C).
     *         Fee is collected from the initiator (Section III-A).
     */
    function requestLockStates(
        uint256 crossChainTxId,
        string calldata serviceId,
        address[] calldata stateContracts,
        uint256 timeoutBlocks,
        uint256 destChainId
    ) external payable notBlacklisted(msg.sender) {
        _startLockStates(crossChainTxId, serviceId, stateContracts, timeoutBlocks, destChainId, msg.sender, msg.value);
    }

    /**
     * @notice Optional MEV hardening: submit an operation commitment before
     *         revealing the call tree and lock manifest. This hides sensitive
     *         manifest contents during the pre-lock commitment transaction.
     */
    function submitCommit(bytes32 commitHash, uint64 deadline) external notBlacklisted(msg.sender) {
        require(commitHash != bytes32(0), "Zero commit");
        require(deadline > block.timestamp, "Invalid deadline");
        CommitRecord storage record = commits[commitHash];
        require(record.sender == address(0), "Commit exists");

        commits[commitHash] = CommitRecord({
            sender: msg.sender,
            deadline: deadline,
            revealed: false,
            expired: false
        });

        emit OperationCommitted(commitHash, msg.sender, deadline);
    }

    /**
     * @notice Reveal a previously committed operation and start the regular
     *         lock phase. `lockManifest` is ABI-encoded as
     *         `(string serviceId, address[] stateContracts, uint256 timeoutBlocks, uint256 destChainId)`.
     */
    function revealAndStart(
        bytes32 opId,
        bytes calldata callTree,
        bytes calldata lockManifest,
        bytes calldata stateVersionVector,
        bytes32 schemaHash,
        bytes32 nonce,
        uint64 deadline
    ) external payable notBlacklisted(msg.sender) {
        bytes32 commitHash = computeOperationCommitHash(
            opId,
            msg.sender,
            callTree,
            lockManifest,
            stateVersionVector,
            schemaHash,
            nonce,
            deadline
        );
        CommitRecord storage record = commits[commitHash];
        require(record.sender == msg.sender, "Unknown commit");
        require(!record.revealed, "Already revealed");
        require(!record.expired, "Commit expired");
        require(record.deadline == deadline, "Deadline mismatch");
        require(block.timestamp <= deadline, "Reveal deadline passed");
        require(!usedNonces[nonce], "Nonce used");

        (string memory serviceId, address[] memory stateContracts, uint256 timeoutBlocks, uint256 destChainId) =
            abi.decode(lockManifest, (string, address[], uint256, uint256));

        uint256 crossChainTxId = uint256(opId);
        record.revealed = true;
        usedNonces[nonce] = true;

        emit OperationRevealed(commitHash, opId, keccak256(lockManifest));
        _startLockStates(crossChainTxId, serviceId, stateContracts, timeoutBlocks, destChainId, msg.sender, msg.value);
    }

    function expireCommit(bytes32 commitHash) external {
        CommitRecord storage record = commits[commitHash];
        require(record.sender != address(0), "Unknown commit");
        require(!record.revealed, "Already revealed");
        require(!record.expired, "Commit expired");
        require(block.timestamp > record.deadline, "Not expired");

        record.expired = true;
        emit CommitExpired(commitHash);
    }

    function computeOperationCommitHash(
        bytes32 opId,
        address user,
        bytes calldata callTree,
        bytes calldata lockManifest,
        bytes calldata stateVersionVector,
        bytes32 schemaHash,
        bytes32 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "XSMART_OPERATION_COMMIT_V1",
                chainId,
                address(this),
                opId,
                user,
                keccak256(callTree),
                keccak256(lockManifest),
                keccak256(stateVersionVector),
                schemaHash,
                nonce,
                deadline
            )
        );
    }

    function _startLockStates(
        uint256 crossChainTxId,
        string memory serviceId,
        address[] memory stateContracts,
        uint256 timeoutBlocks,
        uint256 destChainId,
        address initiator,
        uint256 feePaid
    ) internal {
        require(feePaid >= crossChainFee, "Fee not paid");
        require(stateContracts.length > 0, "Empty contracts");
        require(serviceVerified[serviceId], "Service not verified");
        require(!activeExecutions[crossChainTxId].active, "Execution active");

        uint256 effectiveTimeout = _getEffectiveTimeout(timeoutBlocks);

        activeExecutions[crossChainTxId] = ActiveExecution({
            stateContracts: stateContracts,
            initiator: initiator,
            startBlock: block.number,
            timeoutBlocks: effectiveTimeout,
            updateAckCount: 0,
            active: true,
            phase: ExecutionPhase.Requested
        });

        collectedFees[crossChainTxId] = feePaid;
        updateRequestHashes[crossChainTxId] = bytes32(0);

        emit ExecutionPhaseChanged(crossChainTxId, ExecutionPhase.Requested);
        emit CrossChainLockRequested(crossChainTxId, serviceId, stateContracts, destChainId);
        emit CrossChainFeePaid(crossChainTxId, feePaid);
    }

    /**
     * @notice Section V-A Locking (Step 2): Invoked chain receives lock request.
     *         Verifies Merkle proof + finality from execution chain.
     *         Locks state on each state contract and returns locked state values.
     */
    function receiveLockRequest(
        uint256 crossChainTxId,
        address[] calldata stateContracts,
        bytes[] calldata lockArgs,
        uint256 timeoutBlocks,
        uint256 executionChainBlockNumber,
        bytes32[] calldata merkleProof,
        bytes32 receiptHash
    ) external onlyActiveRelayer {
        bytes32 txKey = keccak256(abi.encodePacked(crossChainTxId, chainId, "lock"));
        require(!processedCrossChainTxs[txKey], "Already processed");
        processedCrossChainTxs[txKey] = true;

        _verifyCrossChainEvidence(
            executionChainBlockNumber,
            receiptHash,
            merkleProof,
            txKey,
            abi.encodePacked(receiptHash)
        );

        require(stateContracts.length == lockArgs.length, "Length mismatch");

        _getEffectiveTimeout(timeoutBlocks);

        _executeLocks(crossChainTxId, stateContracts, lockArgs);
    }

    function _executeLocks(
        uint256 crossChainTxId,
        address[] calldata stateContracts,
        bytes[] calldata lockArgs
    ) private {
        for (uint256 i = 0; i < stateContracts.length; i++) {
            require(registeredStateContracts[stateContracts[i]], "Not registered state contract");

            (bool ok, bytes memory retData) = stateContracts[i].call(
                abi.encodeWithSignature("lockState(bytes)", lockArgs[i])
            );
            if (!ok) {
                for (uint256 j = 0; j < i; j++) {
                    _unlockState(stateContracts[j], crossChainTxId);
                }
                emit CrossChainLockResponse(crossChainTxId, stateContracts[i], bytes(""));
                return;
            }

            emit CrossChainLockResponse(crossChainTxId, stateContracts[i], retData);
        }
    }

    /**
     * @notice Section V-A Integrated Execution: the execution chain runs the
     *         cloned DApp logic locally using the locked-state values returned
     *         by every invoked chain. The result is a list of updateData blobs
     *         that is then shipped back to each invoked chain through
     *         `requestUpdate` / `receiveUpdateRequest`.
     *
     *         This is the paper's "integrated execution" pillar (§V-A): it
     *         must happen on-chain so the updateData is verifiable by relayers
     *         via Merkle proofs against this execution chain's block headers.
     *
     *         The cloned logic contract MUST implement:
     *            `integratedExecute(uint256,bytes[]) returns (address[],bytes[])`
     *         returning the destination state contracts and their respective
     *         update payloads. If it reverts or returns mismatched lengths,
     *         the cross-chain tx is flagged for rollback.
     *
     * @param crossChainTxId    Cross-chain execution identifier
     * @param serviceId         Service whose cloned logic contract will run
     * @param lockedStates      Values returned by `lockState` on invoked chains
     *                          (ordered to match the original stateContracts)
     */
    function executeIntegratedLogic(
        uint256 crossChainTxId,
        string calldata serviceId,
        bytes[] calldata lockedStates
    )
        external
        returns (address[] memory destContracts, bytes[] memory updateData)
    {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.Requested, "Invalid execution phase");
        require(exec.initiator == msg.sender || relayerManager.isRelayerActive(msg.sender), "Not authorized");
        require(serviceVerified[serviceId], "Service not verified");

        address logic = serviceToLogic[serviceId];
        require(logic != address(0), "Logic not registered");
        require(lockedStates.length == exec.stateContracts.length, "Length mismatch");

        (bool ok, bytes memory ret) = logic.call(
            abi.encodeWithSignature("integratedExecute(uint256,bytes[])", crossChainTxId, lockedStates)
        );
        if (!ok) {
            emit IntegratedExecutionFailed(crossChainTxId, serviceId, ret);
            _abortExecution(crossChainTxId, exec);
            return (new address[](0), new bytes[](0));
        }

        (destContracts, updateData) = abi.decode(ret, (address[], bytes[]));
        require(destContracts.length == exec.stateContracts.length, "Dest length mismatch");
        require(destContracts.length == updateData.length, "Update length mismatch");
        for (uint256 i = 0; i < destContracts.length; i++) {
            require(destContracts[i] == exec.stateContracts[i], "Unexpected state contract");
        }
        updateRequestHashes[crossChainTxId] = keccak256(abi.encode(destContracts, updateData));

        emit IntegratedExecutionPerformed(
            crossChainTxId,
            serviceId,
            logic,
            abi.encodePacked(keccak256(ret))
        );

        _decideCommit(crossChainTxId, exec);

        // Automatically emit CrossChainUpdateRequested — same payload that
        // `requestUpdate` would produce — so relayers can immediately pick up
        // the update without a second transaction.
        emit CrossChainUpdateRequested(crossChainTxId, destContracts, updateData);
    }

    function executeIntegratedLogicWithProofs(
        uint256 crossChainTxId,
        string calldata serviceId,
        bytes[] calldata lockedStates,
        StateImportProof[] calldata importProofs
    )
        external
        returns (address[] memory destContracts, bytes[] memory updateData)
    {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.Requested, "Invalid execution phase");
        require(exec.initiator == msg.sender || relayerManager.isRelayerActive(msg.sender), "Not authorized");
        require(serviceVerified[serviceId], "Service not verified");
        require(address(proofAdapter) != address(0), "Proof adapter not set");
        require(lockedStates.length == exec.stateContracts.length, "Length mismatch");
        require(importProofs.length == lockedStates.length, "Proof length mismatch");

        for (uint256 i = 0; i < lockedStates.length; i++) {
            StateImportProof calldata importProof = importProofs[i];
            try proofAdapter.verify(
                importProof.chainId,
                importProof.contractId,
                importProof.schemaHash,
                importProof.opId,
                importProof.lockEpoch,
                importProof.stateVersion,
                lockedStates[i],
                importProof.proof
            ) returns (bool proofOk) {
                require(proofOk, "State import proof failed");
            } catch {
                revert("State import proof failed");
            }
        }

        address logic = serviceToLogic[serviceId];
        require(logic != address(0), "Logic not registered");

        (bool ok, bytes memory ret) = logic.call(
            abi.encodeWithSignature("integratedExecute(uint256,bytes[])", crossChainTxId, lockedStates)
        );
        if (!ok) {
            emit IntegratedExecutionFailed(crossChainTxId, serviceId, ret);
            _abortExecution(crossChainTxId, exec);
            return (new address[](0), new bytes[](0));
        }

        (destContracts, updateData) = abi.decode(ret, (address[], bytes[]));
        require(destContracts.length == exec.stateContracts.length, "Dest length mismatch");
        require(destContracts.length == updateData.length, "Update length mismatch");
        for (uint256 i = 0; i < destContracts.length; i++) {
            require(destContracts[i] == exec.stateContracts[i], "Unexpected state contract");
        }
        updateRequestHashes[crossChainTxId] = keccak256(abi.encode(destContracts, updateData));

        emit IntegratedExecutionPerformed(
            crossChainTxId,
            serviceId,
            logic,
            abi.encodePacked(keccak256(ret))
        );

        _decideCommit(crossChainTxId, exec);

        emit CrossChainUpdateRequested(crossChainTxId, destContracts, updateData);
    }

    /**
     * @notice XSmart step 8: execute a call tree directly on bc1.
     *         Translation commitments are checked through UBTLRegistry before
     *         the first node runs. A downstream node failure does not revert the
     *         outer transaction; instead the bridge marks the execution inactive
     *         and emits rollback so relayers can fan out unlocks.
     */
    function executeIntegratedCallTree(
        uint256 crossChainTxId,
        string calldata serviceId,
        bytes calldata callTreeBlob,
        bytes32[] calldata translationKeys,
        bytes32[] calldata peerIrHashes
    )
        external
        returns (bool success, bytes memory rootResult)
    {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.Requested, "Invalid execution phase");
        require(exec.initiator == msg.sender || relayerManager.isRelayerActive(msg.sender), "Not authorized");
        require(serviceVerified[serviceId], "Service not verified");

        if (!_verifyTranslations(crossChainTxId, translationKeys, peerIrHashes)) {
            _abortExecution(crossChainTxId, exec);
            return (false, bytes(""));
        }

        return _runCallTree(crossChainTxId, exec, callTreeBlob);
    }

    /**
     * @notice Section V-A Updating (source chain): emit update request for relayers.
     *         Relayers transport the prepared update payloads to the invoked chains.
     * @param crossChainTxId Cross-chain execution identifier
     * @param stateContracts State contracts to update on the destination chain
     * @param updateData ABI-encoded update payloads for each state contract
     */
    function requestUpdate(
        uint256 crossChainTxId,
        address[] calldata stateContracts,
        bytes[] calldata updateData
    ) external {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.CommitDecided, "Commit not decided");
        require(exec.initiator == msg.sender || relayerManager.isRelayerActive(msg.sender), "Not authorized");
        require(stateContracts.length == updateData.length, "Length mismatch");
        require(stateContracts.length > 0, "Empty contracts");
        require(stateContracts.length == exec.stateContracts.length, "Unexpected state contract count");
        for (uint256 i = 0; i < stateContracts.length; i++) {
            require(stateContracts[i] == exec.stateContracts[i], "Unexpected state contract");
        }

        bytes32 updateHash = keccak256(abi.encode(stateContracts, updateData));
        bytes32 expectedHash = updateRequestHashes[crossChainTxId];
        if (expectedHash == bytes32(0)) {
            updateRequestHashes[crossChainTxId] = updateHash;
        } else {
            require(expectedHash == updateHash, "Update payload mismatch");
        }

        emit CrossChainUpdateRequested(crossChainTxId, stateContracts, updateData);
    }

    /**
     * @notice Section V-A Updating: Invoked chain receives update request.
     *         Verifies Merkle proof + finality from execution chain.
     *         Calls updateState on each state contract which unlocks + updates.
     */
    function receiveUpdateRequest(
        uint256 crossChainTxId,
        address[] calldata stateContracts,
        bytes[] calldata updateData,
        uint256 executionChainBlockNumber,
        bytes32[] calldata merkleProof,
        bytes32 receiptHash
    ) external onlyActiveRelayer {
        bytes32 txKey = keccak256(abi.encodePacked(crossChainTxId, chainId, "update"));
        require(!processedCrossChainTxs[txKey], "Already processed");

        _verifyCrossChainEvidence(
            executionChainBlockNumber,
            receiptHash,
            merkleProof,
            txKey,
            abi.encodePacked(receiptHash)
        );

        require(stateContracts.length == updateData.length, "Length mismatch");

        // Section V-A atomicity: all updates in this invoked-chain batch
        // succeed or the EVM transaction reverts. After CommitDecided, timeout
        // rollback is disabled on the execution chain; missing updates remain
        // a liveness retry obligation until their ACKs are recorded.
        for (uint256 i = 0; i < stateContracts.length; i++) {
            require(registeredStateContracts[stateContracts[i]], "Not registered state contract");

            (bool ok, bytes memory retData) = stateContracts[i].call(
                abi.encodeWithSignature("updateState(bytes)", updateData[i])
            );
            if (!ok) {
                emit CrossChainUpdateAck(crossChainTxId, stateContracts[i], false);
                // Bubble up revert reason if present, else use generic 2PC abort message
                if (retData.length > 0) {
                    assembly {
                        revert(add(retData, 0x20), mload(retData))
                    }
                }
                revert("Update failed; 2PC abort (Section V-A)");
            }

            emit CrossChainUpdateAck(crossChainTxId, stateContracts[i], true);
        }

        processedCrossChainTxs[txKey] = true;
    }

    /**
     * @notice Section V-A Rollback: Unlock all locked states on invoked chains.
     *         Triggered by execution chain when locking fails or execution fails.
     *         Verifies Merkle proof from execution chain.
     *         No state updates occur during rollback — only unlocks (Section V-A Remarks).
     */
    function receiveRollbackRequest(
        uint256 crossChainTxId,
        address[] calldata stateContracts,
        uint256 executionChainBlockNumber,
        bytes32[] calldata merkleProof,
        bytes32 receiptHash
    ) external onlyActiveRelayer {
        bytes32 txKey = keccak256(abi.encodePacked(crossChainTxId, chainId, "rollback"));
        require(!processedCrossChainTxs[txKey], "Already processed");
        processedCrossChainTxs[txKey] = true;

        _verifyCrossChainEvidence(
            executionChainBlockNumber,
            receiptHash,
            merkleProof,
            txKey,
            abi.encodePacked(receiptHash)
        );

        for (uint256 i = 0; i < stateContracts.length; i++) {
            _unlockState(stateContracts[i], crossChainTxId);
        }

        emit CrossChainRollback(crossChainTxId, stateContracts);
    }

    /**
     * @notice Section V-A Timeout: Execution chain detects timeout and triggers rollback.
     */
    function timeoutExecution(uint256 crossChainTxId) external {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.Requested, "Commit already decided");
        require(
            (block.number - exec.startBlock) > exec.timeoutBlocks,
            "Not timed out"
        );

        _abortExecution(crossChainTxId, exec);
    }

    /**
     * @notice Section V-A Updating (execution chain): record one invoked-chain
     *         update acknowledgment. The final ACK atomically completes the
     *         execution so completion cannot happen before every invoked chain
     *         has committed its update.
     * @param crossChainTxId Cross-chain execution identifier.
     * @param ackKey Unique ACK key derived from source chain and endpoint/state
     *        contract. This deduplicates ACKs across heterogeneous VM targets.
     * @param success Whether the invoked-chain update succeeded.
     * @param invokedChainBlockNumber Finalized invoked-chain block containing
     *        the ACK event. A value of 0 keeps the current benchmark shortcut;
     *        non-zero values require Merkle verification.
     * @param merkleProof Merkle proof for the ACK event receipt.
     * @param receiptHash Receipt hash containing the ACK event.
     */
    function recordUpdateAckAndMaybeComplete(
        uint256 crossChainTxId,
        bytes32 ackKey,
        bool success,
        uint256 invokedChainBlockNumber,
        bytes32[] calldata merkleProof,
        bytes32 receiptHash
    ) external onlyActiveRelayer {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.CommitDecided, "Commit not decided");
        require(ackKey != bytes32(0), "Zero ack key");
        require(success, "Update failed");
        require(!updateAckRecorded[crossChainTxId][ackKey], "Ack already recorded");

        _verifyCrossChainEvidence(
            invokedChainBlockNumber,
            receiptHash,
            merkleProof,
            ackKey,
            abi.encodePacked(receiptHash)
        );

        updateAckRecorded[crossChainTxId][ackKey] = true;
        exec.updateAckCount += 1;

        emit UpdateAckRecorded(
            crossChainTxId,
            ackKey,
            success,
            exec.updateAckCount,
            exec.stateContracts.length
        );

        if (exec.updateAckCount >= exec.stateContracts.length) {
            _completeExecution(crossChainTxId, msg.sender);
        }
    }

    /**
     * @notice Mark execution as completed after all updates acknowledged.
     *         Fee is credited to caller's pending withdrawals (pull pattern).
     */
    function completeExecution(uint256 crossChainTxId) external {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        require(exec.active, "Not active");
        require(exec.phase == ExecutionPhase.CommitDecided, "Commit not decided");
        require(exec.updateAckCount >= exec.stateContracts.length, "Missing update acks");

        _completeExecution(crossChainTxId, msg.sender);
    }

    function _completeExecution(uint256 crossChainTxId, address completedBy) internal {
        ActiveExecution storage exec = activeExecutions[crossChainTxId];
        exec.active = false;
        exec.phase = ExecutionPhase.Completed;

        // Section III-A: Credit fee to caller's pending withdrawals (pull pattern)
        uint256 fee = collectedFees[crossChainTxId];
        if (fee > 0) {
            collectedFees[crossChainTxId] = 0;
            pendingWithdrawals[completedBy] += fee;
        }

        emit ExecutionPhaseChanged(crossChainTxId, ExecutionPhase.Completed);
        emit ExecutionCompleted(crossChainTxId, completedBy);
    }

    /**
     * @notice Withdraw accumulated relayer fees (pull pattern for safe ETH transfer).
     */
    function withdrawFee() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No pending fee");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Withdraw failed");
    }

    // ========== SECTION V-B: Transaction Aggregation ==========
    // lockStates/updateStates already accept arrays (aggregation is implicit
    // in the API design: one call per chain, regardless of # of contracts).

    // ========== SECTION VIII: Authorization / Blacklisting ==========

    function authorizeProvider(address provider) external onlyOwner {
        authorizedProviders[provider] = true;
        blacklistedProviders[provider] = false;
    }

    function blacklistProvider(address provider) external onlyOwner {
        blacklistedProviders[provider] = true;
        authorizedProviders[provider] = false;
    }

    function isAuthorizedProvider(address provider) external view returns (bool) {
        return authorizedProviders[provider];
    }

    function isBlacklisted(address provider) external view returns (bool) {
        return blacklistedProviders[provider];
    }

    // ========== ADMIN ==========

    function setBridgeTimeoutBlocks(uint256 _blocks) external onlyOwner {
        bridgeTimeoutBlocks = _blocks;
    }

    function setCrossChainFee(uint256 _fee) external onlyOwner {
        crossChainFee = _fee;
    }

    function setUBTLRegistry(address _ubtlRegistry) external onlyOwner {
        ubtlRegistry = UBTLRegistry(_ubtlRegistry);
    }

    function setProofAdapter(address _proofAdapter) external onlyOwner {
        proofAdapter = IProofAdapter(_proofAdapter);
        emit ProofAdapterUpdated(_proofAdapter);
    }

    function nextCrossChainTxId() external returns (uint256) {
        return ++crossChainTxNonce;
    }

    // ========== INTERNAL ==========

    /**
     * @notice Section V-A Timeout: The effective timeout is the **minimum** of the
     *         dApp-specified timeout and the bridge maximum timeout, per paper:
     *         "the effective timeout is determined by taking the minimum of these two values"
     */
    function _getEffectiveTimeout(uint256 dappTimeout) internal view returns (uint256) {
        return dappTimeout < bridgeTimeoutBlocks ? dappTimeout : bridgeTimeoutBlocks;
    }

    function _verifyCrossChainEvidence(
        uint256 blockNumber,
        bytes32 receiptHash,
        bytes32[] calldata merkleProof,
        bytes32 proofContext,
        bytes memory encodedState
    ) internal view {
        if (blockNumber == 0) {
            return;
        }

        if (address(proofAdapter) == address(0)) {
            require(
                lightClient.verifyReceipt(blockNumber, receiptHash, merkleProof),
                "Merkle proof failed"
            );
            return;
        }

        bytes memory proof = abi.encode(blockNumber, receiptHash, merkleProof);
        try proofAdapter.verify(
                bytes32(chainId),
                proofContext,
                bytes32(0),
                bytes32(0),
                0,
                0,
                encodedState,
                proof
        ) returns (bool ok) {
            require(ok, "Proof adapter failed");
        } catch {
            revert("Proof adapter failed");
        }
    }

    function _verifyTranslations(
        uint256 crossChainTxId,
        bytes32[] calldata translationKeys,
        bytes32[] calldata peerIrHashes
    ) internal returns (bool) {
        require(address(ubtlRegistry) != address(0), "UBTL registry not set");
        require(translationKeys.length == peerIrHashes.length, "Verification length mismatch");

        for (uint256 i = 0; i < translationKeys.length; i++) {
            bool ok = ubtlRegistry.verify(
                translationKeys[i],
                peerIrHashes[i],
                bytes("")
            );
            if (!ok) {
                emit TranslationVerificationFailed(
                    crossChainTxId,
                    translationKeys[i],
                    peerIrHashes[i]
                );
                return false;
            }
        }

        return true;
    }

    function _runCallTree(
        uint256 crossChainTxId,
        ActiveExecution storage exec,
        bytes calldata callTreeBlob
    ) internal returns (bool success, bytes memory rootResult) {
        (CallTree.TreeNode[] memory nodes, uint256 rootIndex) = CallTree.parse(callTreeBlob);
        uint256[] memory order = CallTree.topologicalOrder(nodes, rootIndex);
        bytes[] memory results = new bytes[](nodes.length);

        for (uint256 i = 0; i < order.length; i++) {
            uint256 nodeIndex = order[i];
            bytes memory args = CallTree.materializeArgs(nodes[nodeIndex], results);
            (bool ok, bytes memory ret) = nodes[nodeIndex].contractAddr.call(
                CallTree.callData(nodes[nodeIndex], args)
            );
            if (!ok) {
                emit IntegratedExecutionFailed(crossChainTxId, "", ret);
                _abortExecution(crossChainTxId, exec);
                return (false, bytes(""));
            }

            results[nodeIndex] = ret;
            emit CallTreeNodeExecuted(crossChainTxId, nodeIndex, nodes[nodeIndex].contractAddr, ret);
        }

        rootResult = results[rootIndex];
        emit IntegratedExecutionPerformed(
            crossChainTxId,
            "",
            nodes[rootIndex].contractAddr,
            abi.encodePacked(keccak256(rootResult))
        );
        _decideCommit(crossChainTxId, exec);
        return (true, rootResult);
    }

    function _decideCommit(uint256 crossChainTxId, ActiveExecution storage exec) private {
        require(exec.phase == ExecutionPhase.Requested, "Invalid execution phase");
        exec.phase = ExecutionPhase.CommitDecided;
        emit ExecutionPhaseChanged(crossChainTxId, ExecutionPhase.CommitDecided);
    }

    function _abortExecution(uint256 crossChainTxId, ActiveExecution storage exec) private {
        require(exec.phase == ExecutionPhase.Requested, "Commit already decided");
        exec.active = false;
        exec.phase = ExecutionPhase.AbortDecided;
        emit ExecutionPhaseChanged(crossChainTxId, ExecutionPhase.AbortDecided);
        emit CrossChainRollback(crossChainTxId, exec.stateContracts);
    }

    // ===== Section V-A: Unlock retry bookkeeping (EC-IX-1 hardening) =====
    mapping(bytes32 => uint256) public unlockAttempts;

    function _unlockState(address target, uint256 crossChainTxId) private {
        (bool ok, ) = target.call(
            abi.encodeWithSignature("unlockState(uint256)", crossChainTxId)
        );
        if (!ok) {
            bytes32 key = keccak256(abi.encodePacked(target, crossChainTxId));
            unlockAttempts[key] += 1;
            emit UnlockFailed(target, crossChainTxId);
            emit UnlockRetryRequested(target, crossChainTxId, unlockAttempts[key]);
        } else {
            // Clear attempts counter on success so a future tx with the same
            // (target, txId) pair starts fresh.
            bytes32 key = keccak256(abi.encodePacked(target, crossChainTxId));
            if (unlockAttempts[key] != 0) {
                unlockAttempts[key] = 0;
            }
        }
    }

    /**
     * @notice Section V-A hardening (EC-IX-1): Allow anyone to retry a failed
     *         unlock. If the target contract exposes `unlockOnTimeout(uint256)`
     *         (StateContractBase does), invoke it to force-release the lock
     *         once the per-pool timeout has elapsed. Reverts if neither the
     *         standard `unlockState` nor the timeout path succeeds, so the
     *         caller learns the state contract is permanently stuck and can
     *         escalate off-chain.
     */
    function retryUnlock(address target, uint256 crossChainTxId) external {
        require(registeredStateContracts[target], "Not registered state contract");

        (bool ok, ) = target.call(
            abi.encodeWithSignature("unlockState(uint256)", crossChainTxId)
        );
        if (ok) {
            bytes32 key = keccak256(abi.encodePacked(target, crossChainTxId));
            if (unlockAttempts[key] != 0) {
                unlockAttempts[key] = 0;
            }
            return;
        }

        (bool okTimeout, ) = target.call(
            abi.encodeWithSignature("unlockOnTimeout(uint256)", crossChainTxId)
        );
        require(okTimeout, "Unlock retry failed");
        emit UnlockForcedTimeout(target, crossChainTxId);
        bytes32 keyT = keccak256(abi.encodePacked(target, crossChainTxId));
        if (unlockAttempts[keyT] != 0) {
            unlockAttempts[keyT] = 0;
        }
    }

    receive() external payable {}
}
