// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MerkleProofLib
 * @notice Merkle proof verification for cross-chain receipt authenticity (Section IV-C, VI).
 *         Verifies that an event log is embedded in a finalized block by checking
 *         the receipt proof against the block's receiptsRoot.
 */
library MerkleProofLib {
    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == root;
    }

    function hashLeaf(bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), data));
    }
}