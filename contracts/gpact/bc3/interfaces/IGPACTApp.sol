// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGPACTApp {
    function gpactSegment(bytes32 crosschainTxId, bytes calldata callData, uint256 timeoutBlocks)
        external
        returns (bytes memory result, bool lockedContractsUsed);

    function gpactRoot(bytes32 crosschainTxId, bytes calldata callData)
        external
        view
        returns (bool commit, bool abortTx);

    function gpactSignal(bytes32 crosschainTxId, bool commit) external;

    /// @notice EC-GP-1 hardening: invoked by the protocol after the segment
    ///         timeout window has elapsed. Implementations MUST release any
    ///         locks held against `crosschainTxId` (e.g. delegate to
    ///         GPACTLockableStorage._timeoutLock).
    function gpactTimeoutUnlock(bytes32 crosschainTxId) external;
}
