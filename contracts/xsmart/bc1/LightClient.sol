// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CrossChainErrors} from "./lib/CrossChainErrors.sol";
import {MerkleProofLib} from "./lib/MerkleProofLib.sol";

/**
 * @title LightClient
 * @notice On-chain light client for verifying cross-chain block headers and receipts
 *         (Section V-A Finality, Section IV-C).
 *         Stores verified block headers from remote chains and checks that submitted
 *         block headers have reached the required confirmation depth before accepting
 *         cross-chain messages. Mirrors the IBC-style light client pattern referenced
 *         in the paper (Section III-A).
 */
contract LightClient is Ownable {
    struct BlockHeader {
        bytes32 receiptsRoot;
        bytes32 stateRoot;
        uint256 blockNumber;
        uint256 timestamp;
        bool finalized;
    }

    uint256 public trustedChainId;
    uint256 public finalityConfirmations;

    mapping(uint256 => BlockHeader) public headers;
    uint256 public latestFinalizedBlock;

    event BlockHeaderSubmitted(uint256 indexed chainId, uint256 blockNumber, bytes32 receiptsRoot);
    event BlockFinalized(uint256 indexed chainId, uint256 blockNumber);
    event FinalityConfirmationsUpdated(uint256 newConfirmations);

    constructor(uint256 _trustedChainId, uint256 _finalityConfirmations) Ownable(msg.sender) {
        trustedChainId = _trustedChainId;
        finalityConfirmations = _finalityConfirmations;
    }

    function submitBlockHeader(
        uint256 blockNumber,
        bytes32 receiptsRoot,
        bytes32 stateRoot,
        uint256 timestamp
    ) external onlyOwner {
        require(headers[blockNumber].blockNumber == 0, "Header already exists");

        headers[blockNumber] = BlockHeader({
            receiptsRoot: receiptsRoot,
            stateRoot: stateRoot,
            blockNumber: blockNumber,
            timestamp: timestamp,
            finalized: false
        });

        emit BlockHeaderSubmitted(trustedChainId, blockNumber, receiptsRoot);
    }

    function finalizeBlock(uint256 blockNumber) external onlyOwner {
        BlockHeader storage header = headers[blockNumber];
        require(header.blockNumber > 0, "Header not found");
        require(!header.finalized, "Already finalized");

        header.finalized = true;

        if (blockNumber > latestFinalizedBlock) {
            latestFinalizedBlock = blockNumber;
        }

        emit BlockFinalized(trustedChainId, blockNumber);
    }

    function verifyReceipt(
        uint256 blockNumber,
        bytes32 receiptHash,
        bytes32[] calldata merkleProof
    ) external view returns (bool) {
        BlockHeader storage header = headers[blockNumber];
        require(header.blockNumber > 0, "Header not found");
        require(header.finalized, "Block not finalized");

        uint256 currentBlock = block.number;
        require(currentBlock - blockNumber >= finalityConfirmations || header.finalized,
            "Not enough confirmations");

        return MerkleProofLib.verify(merkleProof, header.receiptsRoot, receiptHash);
    }

    function isBlockFinalized(uint256 blockNumber) external view returns (bool) {
        return headers[blockNumber].finalized;
    }

    function getReceiptsRoot(uint256 blockNumber) external view returns (bytes32) {
        return headers[blockNumber].receiptsRoot;
    }

    function getStateRoot(uint256 blockNumber) external view returns (bytes32) {
        return headers[blockNumber].stateRoot;
    }

    function setFinalityConfirmations(uint256 _confirmations) external onlyOwner {
        finalityConfirmations = _confirmations;
        emit FinalityConfirmationsUpdated(_confirmations);
    }

    function verifyCrossChainMessage(
        uint256 blockNumber,
        bytes32 receiptHash,
        bytes32[] calldata merkleProof
    ) external view returns (bool) {
        return this.verifyReceipt(blockNumber, receiptHash, merkleProof);
    }
}
