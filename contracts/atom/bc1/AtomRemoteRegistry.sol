// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AtomTypes} from "./AtomTypes.sol";

contract AtomRemoteRegistry is Ownable {
    mapping(bytes32 => AtomTypes.RemoteFunction) private _remoteFunctions;

    event RemoteFunctionRegistered(
        bytes32 indexed functionId,
        uint256 indexed chainId,
        address indexed contractAddress,
        AtomTypes.OperationPattern pattern
    );

    constructor() Ownable(msg.sender) {}

    function registerRemoteFunction(
        bytes32 functionId,
        uint256 chainId,
        address contractAddress,
        string calldata businessUnit,
        AtomTypes.OperationPattern pattern,
        bytes4 atomicReadSelector,
        bytes4 lockDoSelector,
        bytes4 unlockSelector,
        bytes4 undoUnlockSelector
    ) external onlyOwner {
        require(functionId != bytes32(0), "Zero function id");
        require(contractAddress != address(0), "Zero contract");

        _remoteFunctions[functionId] = AtomTypes.RemoteFunction({
            functionId: functionId,
            chainId: chainId,
            contractAddress: contractAddress,
            businessUnit: businessUnit,
            pattern: pattern,
            atomicReadSelector: atomicReadSelector,
            lockDoSelector: lockDoSelector,
            unlockSelector: unlockSelector,
            undoUnlockSelector: undoUnlockSelector,
            active: true
        });

        emit RemoteFunctionRegistered(functionId, chainId, contractAddress, pattern);
    }

    function getRemoteFunction(bytes32 functionId) external view returns (AtomTypes.RemoteFunction memory) {
        return _remoteFunctions[functionId];
    }

    function isRegistered(bytes32 functionId) external view returns (bool) {
        return _remoteFunctions[functionId].active;
    }
}

