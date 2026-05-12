// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProofAdapter} from "./IProofAdapter.sol";

interface IHarnessSP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IHarnessRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

/**
 * @notice Transaction harness for measuring verifier gas and receipt latency.
 */
contract ZkVerifierGasHarness {
    event AdapterVerified(address indexed adapter, bytes32 indexed opId, bool accepted);
    event SP1Verified(address indexed verifier, bytes32 indexed programVKey);
    event RiscZeroVerified(address indexed verifier, bytes32 indexed imageId);

    function verifyAdapterTx(
        address adapter,
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState,
        bytes calldata proof
    ) external returns (bool) {
        bool accepted = IProofAdapter(adapter).verify(
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            encodedState,
            proof
        );
        require(accepted, "Adapter rejected");
        emit AdapterVerified(adapter, opId, accepted);
        return accepted;
    }

    function verifySp1Tx(
        address verifier,
        bytes32 programVKey,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external {
        IHarnessSP1Verifier(verifier).verifyProof(programVKey, publicValues, proofBytes);
        emit SP1Verified(verifier, programVKey);
    }

    function verifyRiscZeroTx(
        address verifier,
        bytes calldata seal,
        bytes32 imageId,
        bytes32 journalDigest
    ) external {
        IHarnessRiscZeroVerifier(verifier).verify(seal, imageId, journalDigest);
        emit RiscZeroVerified(verifier, imageId);
    }
}
