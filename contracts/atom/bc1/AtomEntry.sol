// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AtomService} from "./AtomService.sol";
import {AtomRemoteRegistry} from "./AtomRemoteRegistry.sol";

contract AtomEntry is Ownable {
    AtomService public atomService;
    AtomRemoteRegistry public atomRemoteRegistry;
    address public atomServer;
    uint256 public judgeNumNeed;
    uint256 public judgeNumMin;
    uint256 public maxServiceTimeBlocks;
    uint256 public maxAuditTimeBlocks;

    event AtomServerUpdated(address indexed atomServer);
    event JudgeConfigUpdated(
        uint256 judgeNumNeed,
        uint256 judgeNumMin,
        uint256 maxServiceTimeBlocks,
        uint256 maxAuditTimeBlocks
    );
    event AtomServiceUpdated(address indexed atomService);
    event AtomRemoteRegistryUpdated(address indexed atomRemoteRegistry);

    constructor(
        address atomServiceAddress,
        address atomRemoteRegistryAddress,
        address atomServerAddress,
        uint256 judgeNumNeed_,
        uint256 judgeNumMin_,
        uint256 maxServiceTimeBlocks_,
        uint256 maxAuditTimeBlocks_
    ) Ownable(msg.sender) {
        require(atomServiceAddress != address(0), "Zero service");
        require(atomRemoteRegistryAddress != address(0), "Zero remote registry");
        require(atomServerAddress != address(0), "Zero atom server");

        atomService = AtomService(atomServiceAddress);
        atomRemoteRegistry = AtomRemoteRegistry(atomRemoteRegistryAddress);
        atomServer = atomServerAddress;
        judgeNumNeed = judgeNumNeed_;
        judgeNumMin = judgeNumMin_;
        maxServiceTimeBlocks = maxServiceTimeBlocks_;
        maxAuditTimeBlocks = maxAuditTimeBlocks_;
    }

    function setAtomService(address atomServiceAddress) external onlyOwner {
        require(atomServiceAddress != address(0), "Zero service");
        atomService = AtomService(atomServiceAddress);
        emit AtomServiceUpdated(atomServiceAddress);
    }

    function setAtomRemoteRegistry(address atomRemoteRegistryAddress) external onlyOwner {
        require(atomRemoteRegistryAddress != address(0), "Zero remote registry");
        atomRemoteRegistry = AtomRemoteRegistry(atomRemoteRegistryAddress);
        emit AtomRemoteRegistryUpdated(atomRemoteRegistryAddress);
    }

    function setAtomServer(address atomServerAddress) external onlyOwner {
        require(atomServerAddress != address(0), "Zero atom server");
        atomServer = atomServerAddress;
        emit AtomServerUpdated(atomServerAddress);
    }

    function setJudgeConfig(
        uint256 judgeNumNeed_,
        uint256 judgeNumMin_,
        uint256 maxServiceTimeBlocks_,
        uint256 maxAuditTimeBlocks_
    ) external onlyOwner {
        require(judgeNumNeed_ > 0, "Zero judge need");
        require(judgeNumMin_ > 0 && judgeNumMin_ <= judgeNumNeed_, "Invalid judge min");
        require(maxServiceTimeBlocks_ > 0, "Zero service time");
        require(maxAuditTimeBlocks_ > 0, "Zero audit time");

        judgeNumNeed = judgeNumNeed_;
        judgeNumMin = judgeNumMin_;
        maxServiceTimeBlocks = maxServiceTimeBlocks_;
        maxAuditTimeBlocks = maxAuditTimeBlocks_;

        emit JudgeConfigUpdated(
            judgeNumNeed_,
            judgeNumMin_,
            maxServiceTimeBlocks_,
            maxAuditTimeBlocks_
        );
    }

    function _startInvocation(bytes32 invokeId, bytes32 workflowId, uint256 totalOperationCount) internal {
        atomService.initInvocation(
            invokeId,
            workflowId,
            address(this),
            atomServer,
            judgeNumNeed,
            judgeNumMin,
            maxServiceTimeBlocks,
            maxAuditTimeBlocks,
            totalOperationCount
        );
    }

    function _requireRemoteFunctionsRegistered(bytes32[] memory functionIds) internal view {
        uint256 len = functionIds.length;
        for (uint256 i = 0; i < len; i++) {
            require(atomRemoteRegistry.isRegistered(functionIds[i]), "Remote function not registered");
        }
    }
}
