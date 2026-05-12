// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProofAdapter} from "./IProofAdapter.sol";

contract CompositeProofAdapter is IProofAdapter {
    bytes32 public constant WASM_SUBSTRATE_CHAIN = keccak256("WASM_SUBSTRATE:bc2");
    bytes32 public constant FABRIC_CHAIN = keccak256("FABRIC:bc3");

    IProofAdapter public immutable componentAdapter;
    IProofAdapter public immutable substrateAdapter;
    IProofAdapter public immutable fabricAdapter;

    constructor(address _componentAdapter, address _substrateAdapter, address _fabricAdapter) {
        require(_componentAdapter != address(0), "Zero component adapter");
        require(_substrateAdapter != address(0), "Zero substrate adapter");
        require(_fabricAdapter != address(0), "Zero fabric adapter");
        componentAdapter = IProofAdapter(_componentAdapter);
        substrateAdapter = IProofAdapter(_substrateAdapter);
        fabricAdapter = IProofAdapter(_fabricAdapter);
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
        IProofAdapter selected = componentAdapter;
        if (chainId == WASM_SUBSTRATE_CHAIN) {
            selected = substrateAdapter;
        } else if (chainId == FABRIC_CHAIN) {
            selected = fabricAdapter;
        }
        return selected.verify(
            chainId,
            contractId,
            schemaHash,
            opId,
            lockEpoch,
            stateVersion,
            encodedState,
            proof
        );
    }
}
