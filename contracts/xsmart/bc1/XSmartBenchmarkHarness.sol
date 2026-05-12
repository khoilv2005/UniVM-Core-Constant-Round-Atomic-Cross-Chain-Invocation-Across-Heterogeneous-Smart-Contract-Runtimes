// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IXSmartBenchmarkBridge {
    function crossChainFee() external view returns (uint256);

    function requestLockStates(
        uint256 crossChainTxId,
        string calldata serviceId,
        address[] calldata stateContracts,
        uint256 timeoutBlocks,
        uint256 destChainId
    ) external payable;

    function executeIntegratedCallTree(
        uint256 crossChainTxId,
        string calldata serviceId,
        bytes calldata callTreeBlob,
        bytes32[] calldata translationKeys,
        bytes32[] calldata peerIrHashes
    ) external returns (bool success, bytes memory rootResult);

    function completeExecution(uint256 crossChainTxId) external;

    function pendingWithdrawals(address account) external view returns (uint256);

    function withdrawFee() external;
}

contract XSmartBenchmarkHarness {
    IXSmartBenchmarkBridge public immutable bridge;

    error FeeNotPaid();
    error IntegratedExecutionFailed();
    error RefundFailed();

    constructor(address bridgeAddress) {
        bridge = IXSmartBenchmarkBridge(bridgeAddress);
    }

    receive() external payable {}

    function runSingleTx(
        uint256 crossChainTxId,
        string calldata serviceId,
        address[] calldata stateContracts,
        uint256 timeoutBlocks,
        uint256 destChainId,
        bytes calldata callTreeBlob,
        bytes32[] calldata translationKeys,
        bytes32[] calldata peerIrHashes,
        address refundRecipient
    ) external payable returns (bytes memory rootResult) {
        uint256 fee = bridge.crossChainFee();
        if (msg.value < fee) {
            revert FeeNotPaid();
        }

        bridge.requestLockStates{value: fee}(
            crossChainTxId,
            serviceId,
            stateContracts,
            timeoutBlocks,
            destChainId
        );

        (bool success, bytes memory result) = bridge.executeIntegratedCallTree(
            crossChainTxId,
            serviceId,
            callTreeBlob,
            translationKeys,
            peerIrHashes
        );
        if (!success) {
            revert IntegratedExecutionFailed();
        }

        bridge.completeExecution(crossChainTxId);

        if (bridge.pendingWithdrawals(address(this)) > 0) {
            bridge.withdrawFee();
        }

        uint256 refundAmount = address(this).balance;
        if (refundAmount > 0 && refundRecipient != address(0)) {
            (bool ok, ) = payable(refundRecipient).call{value: refundAmount}("");
            if (!ok) {
                revert RefundFailed();
            }
        }

        return result;
    }
}
