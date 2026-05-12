// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockSP1Verifier {
    mapping(bytes32 => bool) public acceptedProofs;

    event SP1ProofUpdated(bytes32 indexed digest, bool accepted);

    function setProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes, bool accepted) external {
        bytes32 digest = proofDigest(programVKey, publicValues, proofBytes);
        acceptedProofs[digest] = accepted;
        emit SP1ProofUpdated(digest, accepted);
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        require(acceptedProofs[proofDigest(programVKey, publicValues, proofBytes)], "SP1 proof rejected");
    }

    function proofDigest(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) public pure returns (bytes32) {
        return keccak256(abi.encode(programVKey, keccak256(publicValues), keccak256(proofBytes)));
    }
}
