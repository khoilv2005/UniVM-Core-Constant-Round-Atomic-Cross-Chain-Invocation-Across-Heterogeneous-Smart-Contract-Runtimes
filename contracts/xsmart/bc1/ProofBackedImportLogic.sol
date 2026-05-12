// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ProofBackedImportLogic {
    address public immutable stateContract;

    constructor(address _stateContract) {
        require(_stateContract != address(0), "Zero state contract");
        stateContract = _stateContract;
    }

    function integratedExecute(
        uint256 crossChainTxId,
        bytes[] calldata lockedStates
    ) external view returns (address[] memory destContracts, bytes[] memory updateData) {
        require(lockedStates.length == 1, "Expected one state");

        destContracts = new address[](1);
        destContracts[0] = stateContract;

        updateData = new bytes[](1);
        updateData[0] = abi.encode(crossChainTxId, keccak256(lockedStates[0]));
    }
}
