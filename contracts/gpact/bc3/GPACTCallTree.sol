// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library GPACTCallTree {
    function hashCallTree(bytes memory encodedTree) internal pure returns (bytes32) {
        return keccak256(encodedTree);
    }

    function hashSegmentLeaf(
        bytes32 crosschainTxId,
        uint256 chainId,
        address target,
        bytes4 selector,
        bytes memory params
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(crosschainTxId, chainId, target, selector, params));
    }

    function hashRoot(
        bytes32 crosschainTxId,
        uint256 chainId,
        address target,
        bytes4 selector,
        bytes memory params,
        bytes32[] memory childHashes
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(crosschainTxId, chainId, target, selector, params, childHashes));
    }
}
