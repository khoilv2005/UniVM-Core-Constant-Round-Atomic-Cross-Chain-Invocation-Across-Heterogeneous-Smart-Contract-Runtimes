// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IProofAdapter} from "./IProofAdapter.sol";

interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

contract ZkProofAdapter is Ownable, IProofAdapter {
    enum Backend {
        SP1,
        RISC_ZERO
    }

    bytes32 public constant PUBLIC_VALUES_DOMAIN = keccak256("XSMART_SUCCINCT_STATE_IMPORT_V1");

    Backend public backend;
    address public verifier;
    bytes32 public verificationKey;

    event SuccinctVerifierUpdated(Backend indexed backend, address indexed verifier, bytes32 verificationKey);

    constructor(address _verifier, bytes32 _verificationKey, Backend _backend) Ownable(msg.sender) {
        _setSuccinctVerifier(_verifier, _verificationKey, _backend);
    }

    function setSuccinctVerifier(address _verifier, bytes32 _verificationKey, Backend _backend) external onlyOwner {
        _setSuccinctVerifier(_verifier, _verificationKey, _backend);
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

        (bytes memory publicValuesBytes, bytes memory proofBytes) = abi.decode(proof, (bytes, bytes));
        if (!_matchesPublicValues(
            publicValuesBytes,
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            keccak256(encodedState)
        )) {
            return false;
        }

        if (backend == Backend.SP1) {
            try ISP1Verifier(verifier).verifyProof(verificationKey, publicValuesBytes, proofBytes) {
                return true;
            } catch {
                return false;
            }
        }

        try IRiscZeroVerifier(verifier).verify(proofBytes, verificationKey, sha256(publicValuesBytes)) {
            return true;
        } catch {
            return false;
        }
    }

    function publicValuesHash(
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState
    ) external pure returns (bytes32) {
        return keccak256(publicValues(
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            encodedState
        ));
    }

    function publicValues(
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState
    ) public pure returns (bytes memory) {
        return abi.encode(
            PUBLIC_VALUES_DOMAIN,
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            keccak256(encodedState)
        );
    }

    function _setSuccinctVerifier(address _verifier, bytes32 _verificationKey, Backend _backend) internal {
        require(_verifier != address(0), "Zero verifier");
        require(_verificationKey != bytes32(0), "Zero key");
        verifier = _verifier;
        verificationKey = _verificationKey;
        backend = _backend;
        emit SuccinctVerifierUpdated(_backend, _verifier, _verificationKey);
    }

    function _matchesPublicValues(
        bytes memory raw,
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes32 encodedStateHash
    ) internal pure returns (bool) {
        (
            bytes32 domain,
            bytes32 pvChainId,
            bytes32 pvContractId,
            bytes32 pvSchemaHash,
            bytes32 pvOpId,
            uint64 pvLockEpoch,
            uint64 pvStateVersion,
            bytes32 pvEncodedStateHash
        ) = abi.decode(raw, (bytes32, bytes32, bytes32, bytes32, bytes32, uint64, uint64, bytes32));

        return domain == PUBLIC_VALUES_DOMAIN &&
            pvChainId == chainId &&
            pvContractId == contractId &&
            pvSchemaHash == schemaHash &&
            pvOpId == opId &&
            pvLockEpoch == lockEpoch &&
            pvStateVersion == stateVersion &&
            pvEncodedStateHash == encodedStateHash;
    }
}
