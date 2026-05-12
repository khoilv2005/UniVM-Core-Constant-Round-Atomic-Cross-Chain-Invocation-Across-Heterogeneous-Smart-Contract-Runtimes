// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title CallTree
 * @notice Minimal call-tree parser and executor helpers for XSmartContract.
 * @dev The prototype uses ABI encoding for the tree blob:
 *      abi.encode(TreeNode[] nodes, uint256 rootIndex)
 *
 *      `args` is the ABI-encoded argument tail for the target function.
 *      `argChildIdx` is interpreted as a fixed-width 32-byte argument map:
 *      - `type(uint256).max` means keep the original 32-byte word in `args`
 *      - otherwise replace that 32-byte word with the first 32 bytes of the
 *        referenced child result.
 *
 *      This is intentionally a constrained prototype, sufficient for the
 *      executor/unit tests in step 8.
 */
library CallTree {
    struct TreeNode {
        address contractAddr;
        bytes4 selector;
        bytes args;
        uint256[] argChildIdx;
        uint256[] children;
    }

    error InvalidRoot(uint256 rootIndex, uint256 nodeCount);
    error ChildIndexOutOfRange(uint256 childIndex, uint256 nodeCount);
    error PlaceholderIndexOutOfRange(uint256 childIndex, uint256 nodeCount);
    error MalformedArgsLength(uint256 argsLength, uint256 placeholderCount);
    error ResultTooShort(uint256 childIndex, uint256 resultLength);
    error CycleDetected(uint256 nodeIndex);

    function parse(bytes memory blob) internal pure returns (TreeNode[] memory nodes, uint256 rootIndex) {
        (nodes, rootIndex) = abi.decode(blob, (TreeNode[], uint256));
        _validate(nodes, rootIndex);
    }

    function topologicalOrder(
        TreeNode[] memory nodes,
        uint256 rootIndex
    ) internal pure returns (uint256[] memory order) {
        uint256 nodeCount = nodes.length;
        order = new uint256[](nodeCount);
        uint8[] memory marks = new uint8[](nodeCount);
        uint256 cursor;

        cursor = _dfs(nodes, rootIndex, marks, order, cursor);

        assembly {
            mstore(order, cursor)
        }
    }

    function materializeArgs(
        TreeNode memory node,
        bytes[] memory results
    ) internal pure returns (bytes memory out) {
        uint256 placeholderCount = node.argChildIdx.length;
        if (placeholderCount == 0) {
            return node.args;
        }
        if (node.args.length != placeholderCount * 32) {
            revert MalformedArgsLength(node.args.length, placeholderCount);
        }

        out = bytes.concat(node.args);
        for (uint256 i = 0; i < placeholderCount; i++) {
            uint256 childIndex = node.argChildIdx[i];
            if (childIndex == type(uint256).max) {
                continue;
            }
            if (childIndex >= results.length) {
                revert PlaceholderIndexOutOfRange(childIndex, results.length);
            }
            bytes memory childResult = results[childIndex];
            if (childResult.length < 32) {
                revert ResultTooShort(childIndex, childResult.length);
            }
            _copyWord(childResult, 0, out, i * 32);
        }
    }

    function callData(TreeNode memory node, bytes memory args) internal pure returns (bytes memory) {
        return bytes.concat(node.selector, args);
    }

    function _validate(TreeNode[] memory nodes, uint256 rootIndex) private pure {
        uint256 nodeCount = nodes.length;
        if (rootIndex >= nodeCount) {
            revert InvalidRoot(rootIndex, nodeCount);
        }

        for (uint256 i = 0; i < nodeCount; i++) {
            for (uint256 j = 0; j < nodes[i].children.length; j++) {
                uint256 child = nodes[i].children[j];
                if (child >= nodeCount) {
                    revert ChildIndexOutOfRange(child, nodeCount);
                }
            }
            for (uint256 j = 0; j < nodes[i].argChildIdx.length; j++) {
                uint256 child = nodes[i].argChildIdx[j];
                if (child != type(uint256).max && child >= nodeCount) {
                    revert PlaceholderIndexOutOfRange(child, nodeCount);
                }
            }
        }

        uint8[] memory marks = new uint8[](nodeCount);
        uint256[] memory sink = new uint256[](nodeCount);
        _dfs(nodes, rootIndex, marks, sink, 0);
    }

    function _dfs(
        TreeNode[] memory nodes,
        uint256 idx,
        uint8[] memory marks,
        uint256[] memory order,
        uint256 cursor
    ) private pure returns (uint256) {
        if (marks[idx] == 1) {
            revert CycleDetected(idx);
        }
        if (marks[idx] == 2) {
            return cursor;
        }

        marks[idx] = 1;
        for (uint256 i = 0; i < nodes[idx].children.length; i++) {
            cursor = _dfs(nodes, nodes[idx].children[i], marks, order, cursor);
        }
        marks[idx] = 2;
        order[cursor] = idx;
        return cursor + 1;
    }

    function _copyWord(
        bytes memory src,
        uint256 srcOffset,
        bytes memory dst,
        uint256 dstOffset
    ) private pure {
        for (uint256 i = 0; i < 32; i++) {
            dst[dstOffset + i] = src[srcOffset + i];
        }
    }
}
