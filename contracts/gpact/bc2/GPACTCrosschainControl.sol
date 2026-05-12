// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPACTCallTree} from "./GPACTCallTree.sol";
import {GPACTEventSignerRegistry} from "./GPACTEventSignerRegistry.sol";
import {GPACTTypes} from "./GPACTTypes.sol";
import {IGPACTApp} from "./interfaces/IGPACTApp.sol";
import {IGPACTCrosschainControl} from "./interfaces/IGPACTCrosschainControl.sol";

contract GPACTCrosschainControl is Ownable, IGPACTCrosschainControl {
    bytes32 public constant SEGMENT_EVENT_TAG = keccak256("GPACT_SEGMENT_EVENT");
    bytes32 public constant ROOT_EVENT_TAG = keccak256("GPACT_ROOT_EVENT");

    uint256 public immutable chainId;
    GPACTEventSignerRegistry public immutable signerRegistry;

    mapping(bytes32 => GPACTTypes.CrosschainTxStatus) public txStatus;
    mapping(bytes32 => bytes32) public callTreeHashes;
    mapping(bytes32 => uint256) public rootChainIds;
    mapping(bytes32 => uint256) public timeoutBlocks;
    mapping(bytes32 => bool) public rootDecisions;
    mapping(bytes32 => bool) public rootAborts;
    mapping(bytes32 => mapping(uint256 => bool)) public processedSegments;

    // Section VI paper: record start block to detect root timeout.
    mapping(bytes32 => uint256) public startBlocks;

    event StartEvent(bytes32 indexed crosschainTxId, uint256 indexed rootChainId, bytes32 callTreeHash, uint256 timeoutBlock);
    event RootTimedOut(bytes32 indexed crosschainTxId, uint256 startBlock, uint256 timeoutBlock);
    event SegmentEvent(
        bytes32 indexed crosschainTxId,
        uint256 indexed chainId,
        uint256 indexed segmentId,
        bytes32 callTreeHash,
        bool success,
        bool locked,
        bytes result
    );
    event RootEvent(
        bytes32 indexed crosschainTxId,
        uint256 indexed rootChainId,
        bytes32 callTreeHash,
        bool commit,
        bool abortTx
    );
    event SignallingEvent(bytes32 indexed crosschainTxId, uint256 indexed chainId, uint256 indexed segmentId, bool commit);
    event TimeoutUnlockFailed(bytes32 indexed crosschainTxId, address indexed app);

    constructor(uint256 chainId_, address signerRegistryAddress) Ownable(msg.sender) {
        require(chainId_ > 0, "Zero chain id");
        require(signerRegistryAddress != address(0), "Zero signer registry");
        chainId = chainId_;
        signerRegistry = GPACTEventSignerRegistry(signerRegistryAddress);
    }

    function start(bytes32 crosschainTxId, uint256 rootChainId, bytes calldata callTree, uint256 timeoutBlock) external {
        require(crosschainTxId != bytes32(0), "Zero tx id");
        require(rootChainId > 0, "Zero root chain");
        require(txStatus[crosschainTxId] == GPACTTypes.CrosschainTxStatus.None, "Already started");

        bytes32 callTreeHash = GPACTCallTree.hashCallTree(callTree);
        txStatus[crosschainTxId] = GPACTTypes.CrosschainTxStatus.Started;
        callTreeHashes[crosschainTxId] = callTreeHash;
        rootChainIds[crosschainTxId] = rootChainId;
        timeoutBlocks[crosschainTxId] = timeoutBlock;
        startBlocks[crosschainTxId] = block.number;

        emit StartEvent(crosschainTxId, rootChainId, callTreeHash, timeoutBlock);
    }

    function segment(
        bytes32 crosschainTxId,
        uint256 segmentId,
        uint256 rootChainId,
        bytes32 callTreeHash,
        address app,
        bytes calldata callData,
        uint256 segmentTimeoutBlocks
    ) external {
        require(crosschainTxId != bytes32(0), "Zero tx id");
        require(segmentId > 0, "Zero segment id");
        require(rootChainId > 0, "Zero root chain");
        require(app != address(0), "Zero app");
        require(rootChainId != chainId, "Segment on root chain");
        require(!processedSegments[crosschainTxId][segmentId], "Segment already processed");

        GPACTTypes.CrosschainTxStatus status = txStatus[crosschainTxId];
        require(
            status == GPACTTypes.CrosschainTxStatus.None ||
                status == GPACTTypes.CrosschainTxStatus.Segmented,
            "Segment already closed"
        );
        if (status == GPACTTypes.CrosschainTxStatus.Segmented) {
            require(rootChainIds[crosschainTxId] == rootChainId, "Root chain mismatch");
            require(callTreeHashes[crosschainTxId] == callTreeHash, "Call tree mismatch");
        }

        (bytes memory result, bool lockedContractsUsed) = IGPACTApp(app).gpactSegment(crosschainTxId, callData, segmentTimeoutBlocks);

        txStatus[crosschainTxId] = GPACTTypes.CrosschainTxStatus.Segmented;
        callTreeHashes[crosschainTxId] = callTreeHash;
        rootChainIds[crosschainTxId] = rootChainId;
        processedSegments[crosschainTxId][segmentId] = true;

        emit SegmentEvent(crosschainTxId, chainId, segmentId, callTreeHash, true, lockedContractsUsed, result);
    }

    function root(
        bytes32 crosschainTxId,
        uint256 rootChainId,
        bytes32 callTreeHash,
        address app,
        bytes calldata callData,
        uint256[] calldata segmentIds,
        uint256[] calldata segmentChainIds,
        bytes32[] calldata segmentResultHashes,
        bytes[][] calldata segmentSignatures
    ) external {
        require(app != address(0), "Zero app");
        require(txStatus[crosschainTxId] == GPACTTypes.CrosschainTxStatus.Started, "Root invalid status");
        require(rootChainIds[crosschainTxId] == rootChainId, "Root chain mismatch");
        require(callTreeHashes[crosschainTxId] == callTreeHash, "Call tree mismatch");
        require(segmentIds.length == segmentChainIds.length, "Segment id mismatch");
        require(segmentChainIds.length == segmentResultHashes.length, "Segment result mismatch");
        require(segmentResultHashes.length == segmentSignatures.length, "Segment proof mismatch");

        // Section VI paper: the root transaction must reject stale invocations
        // that arrive after the configured timeout window. Off-chain relayers
        // must race the deadline or the whole crosschain tx is marked Aborted
        // via abortOnTimeout().
        {
            uint256 startBlk = startBlocks[crosschainTxId];
            uint256 tb = timeoutBlocks[crosschainTxId];
            require(startBlk != 0, "Start block missing");
            require(block.number <= startBlk + tb, "Root timed out");
        }

        _verifySegmentProofs(
            crosschainTxId,
            rootChainId,
            callTreeHash,
            segmentIds,
            segmentChainIds,
            segmentResultHashes,
            segmentSignatures
        );

        (bool commit, bool abortTx) = IGPACTApp(app).gpactRoot(crosschainTxId, callData);

        txStatus[crosschainTxId] = GPACTTypes.CrosschainTxStatus.RootProcessed;
        rootDecisions[crosschainTxId] = commit;
        rootAborts[crosschainTxId] = abortTx;

        emit RootEvent(crosschainTxId, rootChainId, callTreeHash, commit, abortTx);
    }

    function signalling(
        bytes32 crosschainTxId,
        uint256 segmentId,
        bytes32 callTreeHash,
        address app,
        bool commit,
        bool abortTx,
        bytes[] calldata rootEventSignatures
    ) external {
        require(app != address(0), "Zero app");
        require(txStatus[crosschainTxId] == GPACTTypes.CrosschainTxStatus.Segmented, "Signal invalid status");
        require(processedSegments[crosschainTxId][segmentId], "Unknown segment");
        require(callTreeHashes[crosschainTxId] == callTreeHash, "Call tree mismatch");
        require(signerRegistry.verifySignedEvent(hashRootEvent(crosschainTxId, rootChainIds[crosschainTxId], callTreeHash, commit, abortTx), rootEventSignatures), "Invalid root signatures");

        bool finalCommit = commit && !abortTx;
        IGPACTApp(app).gpactSignal(crosschainTxId, finalCommit);
        emit SignallingEvent(crosschainTxId, chainId, segmentId, finalCommit);
    }

    function completeExecution(bytes32 crosschainTxId) external onlyOwner {
        require(txStatus[crosschainTxId] == GPACTTypes.CrosschainTxStatus.RootProcessed, "Invalid status for complete");
        txStatus[crosschainTxId] = GPACTTypes.CrosschainTxStatus.Completed;
    }

    /**
     * @notice Section VI paper: any party may flag a crosschain tx as Aborted
     *         once the root timeout window has passed without a root() call
     *         consuming it. This protects segments from waiting for a root
     *         that will never come. Segments on other chains observe this
     *         via a root-event signed with commit=false/abortTx=true (or
     *         directly via their own GPACTLockableStorage timeout path).
     */
    function abortOnTimeout(bytes32 crosschainTxId) external {
        GPACTTypes.CrosschainTxStatus status = txStatus[crosschainTxId];
        require(
            status == GPACTTypes.CrosschainTxStatus.Started ||
                status == GPACTTypes.CrosschainTxStatus.Segmented,
            "Not abortable"
        );
        uint256 startBlk = startBlocks[crosschainTxId];
        require(startBlk != 0, "Start block missing");
        uint256 tb = timeoutBlocks[crosschainTxId];
        require(block.number > startBlk + tb, "Not timed out");

        txStatus[crosschainTxId] = GPACTTypes.CrosschainTxStatus.Aborted;
        rootAborts[crosschainTxId] = true;
        rootDecisions[crosschainTxId] = false;

        emit RootTimedOut(crosschainTxId, startBlk, tb);
        emit RootEvent(crosschainTxId, rootChainIds[crosschainTxId], callTreeHashes[crosschainTxId], false, true);
    }

    /**
     * @notice EC-GP-1 hardening: cascade unlock for a single segment app after
     *         the root timeout has passed. Anyone can trigger this once the
     *         crosschain tx is Aborted (via abortOnTimeout) — the per-app lock
     *         table is then cleared via IGPACTApp.gpactTimeoutUnlock.
     */
    function gpactTimeoutUnlock(bytes32 crosschainTxId, address app) external {
        require(app != address(0), "Zero app");
        GPACTTypes.CrosschainTxStatus status = txStatus[crosschainTxId];
        require(
            status == GPACTTypes.CrosschainTxStatus.Aborted ||
                status == GPACTTypes.CrosschainTxStatus.Segmented,
            "Not unlockable"
        );
        uint256 startBlk = startBlocks[crosschainTxId];
        require(startBlk != 0, "Start block missing");
        uint256 tb = timeoutBlocks[crosschainTxId];
        require(block.number > startBlk + tb, "Not timed out");

        try IGPACTApp(app).gpactTimeoutUnlock(crosschainTxId) {
            return;
        } catch {
            (bool ok, ) = app.call(abi.encodeWithSignature("timeoutLock(bytes32)", crosschainTxId));
            if (!ok) {
                emit TimeoutUnlockFailed(crosschainTxId, app);
            }
        }
    }

    function hashSegmentEvent(
        bytes32 crosschainTxId,
        uint256 segmentId,
        uint256 segmentChainId,
        bytes32 callTreeHash,
        bytes32 segmentResultHash
    )
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(SEGMENT_EVENT_TAG, crosschainTxId, segmentId, segmentChainId, callTreeHash, segmentResultHash)
        );
    }

    function hashRootEvent(bytes32 crosschainTxId, uint256 rootChainId, bytes32 callTreeHash, bool commit, bool abortTx)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ROOT_EVENT_TAG, crosschainTxId, rootChainId, callTreeHash, commit, abortTx));
    }

    function _verifySegmentProofs(
        bytes32 crosschainTxId,
        uint256 rootChainId,
        bytes32 callTreeHash,
        uint256[] calldata segmentIds,
        uint256[] calldata segmentChainIds,
        bytes32[] calldata segmentResultHashes,
        bytes[][] calldata segmentSignatures
    ) internal view {
        uint256 segmentCount = segmentChainIds.length;
        for (uint256 i = 0; i < segmentCount; i++) {
            uint256 segmentId = segmentIds[i];
            uint256 segmentChainId = segmentChainIds[i];
            bytes32 segmentResultHash = segmentResultHashes[i];
            require(segmentId > 0, "Zero segment id");
            require(segmentChainId != rootChainId, "Root chain cannot be a segment");
            require(segmentResultHash != bytes32(0), "Zero segment result hash");
            for (uint256 j = 0; j < i; j++) {
                require(segmentIds[j] != segmentId, "Duplicate segment id");
            }

            bytes32 digest = hashSegmentEvent(
                crosschainTxId,
                segmentId,
                segmentChainId,
                callTreeHash,
                segmentResultHash
            );
            require(signerRegistry.verifySignedEvent(digest, segmentSignatures[i]), "Invalid segment signatures");
        }
    }
}
