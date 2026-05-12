// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CrossChainErrors} from "./lib/CrossChainErrors.sol";

/**
 * @title RelayerManager
 * @notice Manages relayer registration, staking, reward, and penalty (Section III-A, IV-C, VI).
 *         At least one honest relayer is assumed (standard threat model).
 *         Relayers stake collateral; successful deployments earn fees; malicious
 *         behavior results in slashing. Fee mechanism incentivizes honest relaying
 *         as described in Section III-A and verification penalty in Section IV-C.
 */
contract RelayerManager is Ownable {
    uint256 public minimumStake;
    uint256 public totalPenaltyPool;
    address public bridgingContract;

    struct RelayerInfo {
        bool registered;
        uint256 stakedAmount;
        uint256 successfulDeliveries;
        uint256 failedDeliveries;
        uint256 rewardAccumulated;
        bool active;
    }

    mapping(address => RelayerInfo) public relayers;
    address[] public relayerList;

    uint256 public rewardPerSuccessfulDelivery;
    uint256 public penaltyPerFailedVerification;

    event RelayerRegistered(address indexed relayer, uint256 stake);
    event RelayerDeactivated(address indexed relayer);
    event RelayerReactivated(address indexed relayer);
    event RewardDistributed(address indexed relayer, uint256 amount, string reason);
    event PenaltyApplied(address indexed relayer, uint256 amount, string reason);
    event StakeSlashed(address indexed relayer, uint256 amount);

    constructor(
        uint256 _minimumStake,
        uint256 _rewardPerSuccessfulDelivery,
        uint256 _penaltyPerFailedVerification
    ) Ownable(msg.sender) {
        minimumStake = _minimumStake;
        rewardPerSuccessfulDelivery = _rewardPerSuccessfulDelivery;
        penaltyPerFailedVerification = _penaltyPerFailedVerification;
    }

    modifier onlyRegisteredRelayer() {
        require(relayers[msg.sender].registered, "Not registered relayer");
        _;
    }

    modifier onlyBridgingContract() {
        require(msg.sender == bridgingContract, "Not bridging contract");
        _;
    }

    function setBridgingContract(address _bridgingContract) external onlyOwner {
        bridgingContract = _bridgingContract;
    }

    function registerRelayer() external payable {
        require(!relayers[msg.sender].registered, "Already registered");
        require(msg.value >= minimumStake, "Insufficient stake");

        relayers[msg.sender] = RelayerInfo({
            registered: true,
            stakedAmount: msg.value,
            successfulDeliveries: 0,
            failedDeliveries: 0,
            rewardAccumulated: 0,
            active: true
        });
        relayerList.push(msg.sender);

        emit RelayerRegistered(msg.sender, msg.value);
    }

    function deactivateRelayer(address relayer) external onlyOwner {
        require(relayers[relayer].registered, "Not registered");
        relayers[relayer].active = false;
        emit RelayerDeactivated(relayer);
    }

    function reactivateRelayer(address relayer) external onlyOwner {
        require(relayers[relayer].registered, "Not registered");
        relayers[relayer].active = true;
        emit RelayerReactivated(relayer);
    }

    function rewardRelayer(address relayer, string calldata reason) external {
        require(relayers[relayer].registered, "Not registered");
        uint256 reward = rewardPerSuccessfulDelivery;
        relayers[relayer].successfulDeliveries++;
        relayers[relayer].rewardAccumulated += reward;

        emit RewardDistributed(relayer, reward, reason);
    }

    function penalizeRelayer(address relayer, string calldata reason) external {
        require(relayers[relayer].registered, "Not registered");
        uint256 penalty = penaltyPerFailedVerification;
        if (penalty > relayers[relayer].stakedAmount) {
            penalty = relayers[relayer].stakedAmount;
        }
        relayers[relayer].stakedAmount -= penalty;
        relayers[relayer].failedDeliveries++;
        totalPenaltyPool += penalty;

        if (relayers[relayer].stakedAmount == 0) {
            relayers[relayer].active = false;
        }

        emit PenaltyApplied(relayer, penalty, reason);
        emit StakeSlashed(relayer, penalty);
    }

    function isRelayerActive(address relayer) external view returns (bool) {
        return relayers[relayer].registered && relayers[relayer].active;
    }

    function getRelayerStake(address relayer) external view returns (uint256) {
        return relayers[relayer].stakedAmount;
    }

    function getRelayerCount() external view returns (uint256) {
        return relayerList.length;
    }

    function getActiveRelayerCount() external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < relayerList.length; i++) {
            if (relayers[relayerList[i]].active) {
                count++;
            }
        }
        return count;
    }

    function claimReward() external onlyRegisteredRelayer {
        uint256 reward = relayers[msg.sender].rewardAccumulated;
        require(reward > 0, "No reward to claim");
        relayers[msg.sender].rewardAccumulated = 0;
        (bool ok, ) = payable(msg.sender).call{value: reward}("");
        require(ok, "Transfer failed");
    }

    function withdrawStake(uint256 amount) external onlyRegisteredRelayer {
        require(amount <= relayers[msg.sender].stakedAmount, "Amount exceeds stake");
        require(relayers[msg.sender].stakedAmount - amount >= minimumStake, "Below minimum stake");
        relayers[msg.sender].stakedAmount -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function addStake() external payable onlyRegisteredRelayer {
        require(msg.value > 0, "Must send ETH");
        relayers[msg.sender].stakedAmount += msg.value;
        if (!relayers[msg.sender].active && relayers[msg.sender].stakedAmount >= minimumStake) {
            relayers[msg.sender].active = true;
            emit RelayerReactivated(msg.sender);
        }
    }

    function setMinimumStake(uint256 _stake) external onlyOwner {
        minimumStake = _stake;
    }

    function setRewardPerSuccessfulDelivery(uint256 _reward) external onlyOwner {
        rewardPerSuccessfulDelivery = _reward;
    }

    function setPenaltyPerFailedVerification(uint256 _penalty) external onlyOwner {
        penaltyPerFailedVerification = _penalty;
    }

    receive() external payable {}
}