// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProofAdapter} from "./IProofAdapter.sol";
import {LightClient} from "../LightClient.sol";

contract ComponentVerifiedAdapter is IProofAdapter {
    LightClient public immutable lightClient;

    constructor(address _lightClient) {
        require(_lightClient != address(0), "Zero light client");
        lightClient = LightClient(_lightClient);
    }

    function verify(
        bytes32,
        bytes32,
        bytes32,
        bytes32,
        uint64,
        uint64,
        bytes calldata,
        bytes calldata proof
    ) external view override returns (bool) {
        if (proof.length == 0) {
            return false;
        }

        (uint256 blockNumber, bytes32 receiptHash, bytes32[] memory merkleProof) =
            abi.decode(proof, (uint256, bytes32, bytes32[]));

        try lightClient.verifyReceipt(blockNumber, receiptHash, merkleProof) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
