// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library AtomTypes {
    enum InvocationStatus {
        None,
        Init,
        Serving,
        ProofSubmitted,
        Auditing,
        Valid,
        Invalid,
        Settled,
        ForceSettled
    }

    enum JudgeDecision {
        None,
        Valid,
        Invalid
    }

    enum OperationPattern {
        AtomicWrite,
        AtomicRead
    }

    struct RemoteFunction {
        bytes32 functionId;
        uint256 chainId;
        address contractAddress;
        string businessUnit;
        OperationPattern pattern;
        bytes4 atomicReadSelector;
        bytes4 lockDoSelector;
        bytes4 unlockSelector;
        bytes4 undoUnlockSelector;
        bool active;
    }

    struct OperationProof {
        bytes32 invokeId;
        uint256 operationId;
        uint256 chainId;
        uint256 lockDoBlockNumber;
        bytes32 lockDoTxHash;
        uint256 unlockBlockNumber;
        bytes32 unlockTxHash;
        uint256 undoBlockNumber;
        bytes32 undoTxHash;
        uint256 readBlockNumber;
        bytes32 readTxHash;
        bytes32 dependencyHash;
        bytes32 proofHash;
        bool submitted;
    }

    struct Invocation {
        bytes32 invokeId;
        bytes32 workflowId;
        address entry;
        address server;
        uint256 startedBlock;
        uint256 serviceDeadlineBlock;
        uint256 auditDeadlineBlock;
        uint256 totalOperationCount;
        uint256 proofCount;
        uint256 judgeNumNeed;
        uint256 judgeNumMin;
        uint256 validVoteCount;
        uint256 invalidVoteCount;
        bool proofSubmissionComplete;
        InvocationStatus status;
        address[] judges;
    }

    struct JudgeVote {
        JudgeDecision decision;
        bytes32 auditHash;
        bool submitted;
    }
}
