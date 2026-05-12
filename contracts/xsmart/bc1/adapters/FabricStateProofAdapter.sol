// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProofAdapter} from "./IProofAdapter.sol";
import {LightClient} from "../LightClient.sol";
import {MerkleProofLib} from "../lib/MerkleProofLib.sol";

contract FabricStateProofAdapter is IProofAdapter {
    bytes32 public constant DOMAIN = keccak256("XSMART_FABRIC_STATE_V1");

    LightClient public immutable lightClient;

    constructor(address _lightClient) {
        require(_lightClient != address(0), "Zero light client");
        lightClient = LightClient(_lightClient);
    }

    function verify(
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState,
        bytes calldata proof
    ) external view override returns (bool) {
        if (proof.length == 0 || encodedState.length == 0) {
            return false;
        }

        (
            uint256 blockNumber,
            bytes32[] memory stateProof,
            bytes32 channelId,
            bytes32 chaincodeNameHash,
            bytes32 chaincodeVersionHash,
            bytes32 endorsementPolicyHash,
            bytes32 rwSetHash,
            bytes32 validationCodeHash,
            bytes32 txId
        ) = abi.decode(
            proof,
            (uint256, bytes32[], bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32)
        );

        if (!lightClient.isBlockFinalized(blockNumber)) {
            return false;
        }

        bytes32 leaf = stateLeaf(
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            encodedState,
            fabricEvidenceHash(
                channelId,
                chaincodeNameHash,
                chaincodeVersionHash,
                endorsementPolicyHash,
                rwSetHash,
                validationCodeHash,
                txId
            )
        );
        return MerkleProofLib.verifyCalldataCompatible(
            stateProof,
            lightClient.getStateRoot(blockNumber),
            leaf
        );
    }

    function fabricEvidenceHash(
        bytes32 channelId,
        bytes32 chaincodeNameHash,
        bytes32 chaincodeVersionHash,
        bytes32 endorsementPolicyHash,
        bytes32 rwSetHash,
        bytes32 validationCodeHash,
        bytes32 txId
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                channelId,
                chaincodeNameHash,
                chaincodeVersionHash,
                endorsementPolicyHash,
                rwSetHash,
                validationCodeHash,
                txId
            )
        );
    }

    function stateLeaf(
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState,
        bytes32 evidenceHash
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                chainId,
                contractId,
                schemaHash,
                opId,
                lockEpoch,
                stateVersion,
                keccak256(encodedState),
                evidenceHash
            )
        );
    }
}
