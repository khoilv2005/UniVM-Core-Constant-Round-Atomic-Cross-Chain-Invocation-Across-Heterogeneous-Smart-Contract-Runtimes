// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockRiscZeroVerifier {
    mapping(bytes32 => bool) public acceptedReceipts;

    event RiscZeroReceiptUpdated(bytes32 indexed digest, bool accepted);

    function setReceipt(bytes calldata seal, bytes32 imageId, bytes32 journalDigest, bool accepted) external {
        bytes32 digest = receiptDigest(seal, imageId, journalDigest);
        acceptedReceipts[digest] = accepted;
        emit RiscZeroReceiptUpdated(digest, accepted);
    }

    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view {
        require(acceptedReceipts[receiptDigest(seal, imageId, journalDigest)], "RISC Zero receipt rejected");
    }

    function receiptDigest(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(seal), imageId, journalDigest));
    }
}
