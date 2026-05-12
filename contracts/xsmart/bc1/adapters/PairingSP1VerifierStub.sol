// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice SP1-compatible verifier stub that exercises the BN254 pairing precompile.
 *         It is intended for verifier-gas microbenchmarks, not production proof acceptance.
 */
contract PairingSP1VerifierStub {
    /**
     * @notice Verifies a proof through a fixed four-pair BN254 pairing workload.
     * @param programVKey Program verification key binding.
     * @param publicValues Public values committed by the zkVM proof.
     * @param proofBytes Succinct proof bytes.
     */
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        bytes32 digest = keccak256(abi.encode(programVKey, keccak256(publicValues), keccak256(proofBytes)));
        require(digest != bytes32(0), "Bad digest");
        require(_fourPairingChecks(), "Pairing failed");
    }

    function _fourPairingChecks() internal view returns (bool) {
        uint256[24] memory input;
        uint256[1] memory out;
        bool ok;
        assembly {
            ok := staticcall(gas(), 8, add(input, 0x20), 0x300, out, 0x20)
        }
        return ok && out[0] == 1;
    }
}
