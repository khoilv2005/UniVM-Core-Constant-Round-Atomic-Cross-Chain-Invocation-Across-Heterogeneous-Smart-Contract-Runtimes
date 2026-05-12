// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal in-tree ECDSA + EIP-191 helpers for GPACT, replacing
///         OpenZeppelin's `ECDSA` and `MessageHashUtils`. The OZ library
///         pulls in `Bytes.sol` which uses the `mcopy` opcode (Cancun-only),
///         making it incompatible with Besu running with `evmVersion: paris`.
///         This in-tree port stays Paris-compatible and matches OZ semantics
///         for the two operations we actually use:
///           * ethSignedMessageHash(bytes32)
///           * recover(bytes32 hash, bytes signature)  (only 65-byte sigs)
library GPACTSigLib {
    /// @dev OZ-compatible: `keccak256("\x19Ethereum Signed Message:\n32" || hash)`
    function ethSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// @dev Recover signer for a 65-byte (r,s,v) signature; returns address(0)
    ///      on any malformed input or s in upper half order (matches OZ guard).
    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
