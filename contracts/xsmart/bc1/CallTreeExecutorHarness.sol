// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CallTree} from "./lib/CallTree.sol";

contract CallTreeExecutorHarness {
    using CallTree for bytes;

    error NodeCallFailed(uint256 nodeIndex, bytes reason);

    event NodeExecuted(uint256 indexed nodeIndex, bytes result);

    function parseAndOrder(bytes calldata blob) external pure returns (uint256[] memory order) {
        (CallTree.TreeNode[] memory nodes, uint256 rootIndex) = CallTree.parse(blob);
        return CallTree.topologicalOrder(nodes, rootIndex);
    }

    function materializeForNode(
        bytes calldata blob,
        uint256 nodeIndex,
        bytes[] calldata results
    ) external pure returns (bytes memory) {
        (CallTree.TreeNode[] memory nodes, ) = CallTree.parse(blob);
        return CallTree.materializeArgs(nodes[nodeIndex], results);
    }

    function execute(bytes calldata blob) external returns (bytes[] memory results, bytes memory rootResult) {
        (CallTree.TreeNode[] memory nodes, uint256 rootIndex) = CallTree.parse(blob);
        uint256[] memory order = CallTree.topologicalOrder(nodes, rootIndex);
        results = new bytes[](nodes.length);

        for (uint256 i = 0; i < order.length; i++) {
            uint256 nodeIndex = order[i];
            bytes memory args = CallTree.materializeArgs(nodes[nodeIndex], results);
            (bool ok, bytes memory ret) = nodes[nodeIndex].contractAddr.call(
                CallTree.callData(nodes[nodeIndex], args)
            );
            if (!ok) {
                revert NodeCallFailed(nodeIndex, ret);
            }
            results[nodeIndex] = ret;
            emit NodeExecuted(nodeIndex, ret);
        }

        rootResult = results[rootIndex];
    }
}
