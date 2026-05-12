// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IProofAdapter {
    function verify(
        bytes32 chainId,
        bytes32 contractId,
        bytes32 schemaHash,
        bytes32 opId,
        uint64 lockEpoch,
        uint64 stateVersion,
        bytes calldata encodedState,
        bytes calldata proof
    ) external view returns (bool);
}
