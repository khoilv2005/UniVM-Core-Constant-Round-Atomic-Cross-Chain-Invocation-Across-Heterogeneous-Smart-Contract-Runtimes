// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGPACTCrosschainControl {
    function start(bytes32 crosschainTxId, uint256 rootChainId, bytes calldata callTree, uint256 timeoutBlock) external;

    function segment(
        bytes32 crosschainTxId,
        uint256 segmentId,
        uint256 rootChainId,
        bytes32 callTreeHash,
        address app,
        bytes calldata callData,
        uint256 segmentTimeoutBlocks
    ) external;

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
    ) external;

    function signalling(
        bytes32 crosschainTxId,
        uint256 segmentId,
        bytes32 callTreeHash,
        address app,
        bool commit,
        bool abortTx,
        bytes[] calldata rootEventSignatures
    ) external;
}
