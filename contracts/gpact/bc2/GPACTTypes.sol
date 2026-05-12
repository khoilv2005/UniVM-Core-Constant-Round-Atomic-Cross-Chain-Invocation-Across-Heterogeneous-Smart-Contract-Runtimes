// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library GPACTTypes {
    enum CrosschainTxStatus {
        None,
        Started,
        Segmented,
        RootProcessed,
        Signalled,
        Completed,
        Aborted
    }

    struct CallTreeNode {
        uint256 chainId;
        address target;
        bytes4 selector;
        bytes params;
    }

    struct StartEventData {
        bytes32 crosschainTxId;
        uint256 rootChainId;
        bytes32 callTreeHash;
        uint256 timeoutBlock;
    }

    struct SegmentEventData {
        bytes32 crosschainTxId;
        uint256 chainId;
        bytes32 callTreeHash;
        bool success;
        bool locked;
        bytes result;
    }

    struct RootEventData {
        bytes32 crosschainTxId;
        uint256 rootChainId;
        bytes32 callTreeHash;
        bool commit;
        bool abortTx;
    }

    struct SignallingEventData {
        bytes32 crosschainTxId;
        uint256 chainId;
        bool commit;
    }

    struct SignedEvent {
        bytes32 digest;
        bytes[] signatures;
    }
}
