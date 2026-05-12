// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AtomCommunity} from "./AtomCommunity.sol";
import {AtomTypes} from "./AtomTypes.sol";

contract AtomService is Ownable {
    AtomCommunity public immutable atomCommunity;

    mapping(bytes32 => AtomTypes.Invocation) private _invocations;
    mapping(bytes32 => mapping(uint256 => AtomTypes.OperationProof)) private _operationProofs;
    mapping(bytes32 => mapping(address => AtomTypes.JudgeVote)) private _judgeVotes;
    mapping(bytes32 => mapping(address => bool)) public isJudgeSelected;
    mapping(bytes32 => uint256) public extensionCount;
    mapping(address => uint256) public depositedBonds;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(bytes32 => bool) public settlementApplied;
    uint256 public constant MAX_EXTENSIONS = 3;
    uint256 public rewardPool;
    uint256 public penaltyPool;
    uint256 public serverRewardAmount;
    uint256 public serverPenaltyAmount;
    uint256 public judgeRewardAmount;
    uint256 public judgePenaltyAmount;

    event InvocationStarted(
        bytes32 indexed invokeId,
        bytes32 indexed workflowId,
        address indexed server,
        address entry,
        uint256 totalOperationCount
    );
    event OperationProofSubmitted(
        bytes32 indexed invokeId,
        uint256 indexed operationId,
        uint256 indexed chainId,
        bytes32 lockDoTxHash,
        bytes32 unlockTxHash,
        bytes32 undoTxHash,
        bytes32 readTxHash,
        bytes32 dependencyHash,
        bytes32 proofHash
    );
    event AllProofsSubmitted(bytes32 indexed invokeId, uint256 proofCount);
    event JudgeVoteSubmitted(bytes32 indexed invokeId, address indexed judge, bool valid, bytes32 auditHash);
    event InvocationFinalized(bytes32 indexed invokeId);
    event InvocationInvalidated(bytes32 indexed invokeId);
    event InvocationExtended(bytes32 indexed invokeId, uint256 newServiceDeadlineBlock, uint256 newAuditDeadlineBlock);
    event InvocationForceSettled(bytes32 indexed invokeId);
    event ForceSettleUndoRequired(bytes32 indexed invokeId, address indexed server, uint256 totalOperationCount);
    event SettlementTermsUpdated(
        uint256 serverRewardAmount,
        uint256 serverPenaltyAmount,
        uint256 judgeRewardAmount,
        uint256 judgePenaltyAmount
    );
    event RewardPoolFunded(address indexed funder, uint256 amount, uint256 rewardPoolBalance);
    event BondDeposited(address indexed participant, uint256 amount, uint256 totalBond);
    event BondWithdrawn(address indexed participant, uint256 amount, uint256 remainingBond);
    event SettlementWithdrawal(address indexed participant, uint256 amount);
    event RewardCredited(address indexed participant, uint256 amount, string reason);
    event BondSlashed(address indexed participant, uint256 amount, string reason);
    event InvocationSettled(bytes32 indexed invokeId, bool valid);

    constructor(address communityAddress) Ownable(msg.sender) {
        require(communityAddress != address(0), "Zero community");
        atomCommunity = AtomCommunity(communityAddress);
        serverRewardAmount = 0.01 ether;
        serverPenaltyAmount = 0.02 ether;
        judgeRewardAmount = 0.005 ether;
        judgePenaltyAmount = 0.01 ether;
    }

    function initInvocation(
        bytes32 invokeId,
        bytes32 workflowId,
        address entry,
        address server,
        uint256 judgeNumNeed,
        uint256 judgeNumMin,
        uint256 maxServiceTimeBlocks,
        uint256 maxAuditTimeBlocks,
        uint256 totalOperationCount
    ) external {
        require(invokeId != bytes32(0), "Zero invoke id");
        require(entry != address(0), "Zero entry");
        require(server != address(0), "Zero server");
        require(totalOperationCount > 0, "Zero operation count");
        require(judgeNumNeed > 0, "Zero judgeNumNeed");
        require(judgeNumMin > 0 && judgeNumMin <= judgeNumNeed, "Invalid judge threshold");
        require(atomCommunity.activeServers(server), "Inactive server");

        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(inv.status == AtomTypes.InvocationStatus.None, "Invocation exists");

        address[] memory selectedJudges = atomCommunity.selectJudges(invokeId, judgeNumNeed);

        inv.invokeId = invokeId;
        inv.workflowId = workflowId;
        inv.entry = entry;
        inv.server = server;
        inv.startedBlock = block.number;
        inv.serviceDeadlineBlock = block.number + maxServiceTimeBlocks;
        inv.auditDeadlineBlock = block.number + maxServiceTimeBlocks + maxAuditTimeBlocks;
        inv.totalOperationCount = totalOperationCount;
        inv.judgeNumNeed = judgeNumNeed;
        inv.judgeNumMin = judgeNumMin;
        inv.status = AtomTypes.InvocationStatus.Serving;

        for (uint256 i = 0; i < selectedJudges.length; i++) {
            inv.judges.push(selectedJudges[i]);
            isJudgeSelected[invokeId][selectedJudges[i]] = true;
        }

        emit InvocationStarted(invokeId, workflowId, server, entry, totalOperationCount);
    }

    function submitOperationProof(bytes32 invokeId, AtomTypes.OperationProof calldata proof, bytes calldata signature)
        external
    {
        _submitOperationProof(invokeId, proof, signature);
    }

    function submitOperationProofFlat(
        bytes32 invokeId,
        uint256 operationId,
        uint256 chainId,
        uint256 lockDoBlockNumber,
        bytes32 lockDoTxHash,
        uint256 unlockBlockNumber,
        bytes32 unlockTxHash,
        uint256 undoBlockNumber,
        bytes32 undoTxHash,
        uint256 readBlockNumber,
        bytes32 readTxHash,
        bytes32 dependencyHash,
        bytes calldata signature
    ) external {
        _submitOperationProof(
            invokeId,
            AtomTypes.OperationProof({
                invokeId: invokeId,
                operationId: operationId,
                chainId: chainId,
                lockDoBlockNumber: lockDoBlockNumber,
                lockDoTxHash: lockDoTxHash,
                unlockBlockNumber: unlockBlockNumber,
                unlockTxHash: unlockTxHash,
                undoBlockNumber: undoBlockNumber,
                undoTxHash: undoTxHash,
                readBlockNumber: readBlockNumber,
                readTxHash: readTxHash,
                dependencyHash: dependencyHash,
                proofHash: bytes32(0),
                submitted: true
            }),
            signature
        );
    }

    function submitOperationProofBatch(
        bytes32 invokeId,
        AtomTypes.OperationProof[] calldata proofs,
        bytes[] calldata signatures
    ) external {
        uint256 len = proofs.length;
        require(len > 0, "Empty proofs");
        require(len == signatures.length, "Signature length mismatch");
        for (uint256 i = 0; i < len; i++) {
            _submitOperationProof(invokeId, proofs[i], signatures[i]);
        }
    }

    function _submitOperationProof(bytes32 invokeId, AtomTypes.OperationProof memory proof, bytes memory signature)
        internal
    {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(inv.status == AtomTypes.InvocationStatus.Serving, "Not serving");
        require(msg.sender == inv.server, "Not invocation server");
        require(block.number <= inv.serviceDeadlineBlock, "Service deadline passed");
        require(proof.invokeId == invokeId, "InvokeId mismatch");
        require(proof.operationId > 0, "Invalid operation id");
        require(proof.operationId <= inv.totalOperationCount, "Operation out of range");

        AtomTypes.OperationProof storage stored = _operationProofs[invokeId][proof.operationId];
        require(!stored.submitted, "Proof exists");

        bytes32 proofHash = _hashOperationProof(proof);
        address signer = _recoverProofSigner(proofHash, signature);
        require(signer == inv.server, "Invalid proof signature");

        if (proof.operationId == 1) {
            require(proof.dependencyHash == bytes32(0), "Unexpected dependency");
        } else {
            AtomTypes.OperationProof storage previous = _operationProofs[invokeId][proof.operationId - 1];
            require(previous.submitted, "Missing dependency proof");
            require(proof.dependencyHash == previous.proofHash, "Broken proof chain");
        }

        _operationProofs[invokeId][proof.operationId] = AtomTypes.OperationProof({
            invokeId: proof.invokeId,
            operationId: proof.operationId,
            chainId: proof.chainId,
            lockDoBlockNumber: proof.lockDoBlockNumber,
            lockDoTxHash: proof.lockDoTxHash,
            unlockBlockNumber: proof.unlockBlockNumber,
            unlockTxHash: proof.unlockTxHash,
            undoBlockNumber: proof.undoBlockNumber,
            undoTxHash: proof.undoTxHash,
            readBlockNumber: proof.readBlockNumber,
            readTxHash: proof.readTxHash,
            dependencyHash: proof.dependencyHash,
            proofHash: proofHash,
            submitted: true
        });
        inv.proofCount += 1;

        emit OperationProofSubmitted(
            invokeId,
            proof.operationId,
            proof.chainId,
            proof.lockDoTxHash,
            proof.unlockTxHash,
            proof.undoTxHash,
            proof.readTxHash,
            proof.dependencyHash,
            proofHash
        );
    }

    function markProofSubmissionComplete(bytes32 invokeId) external {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(inv.status == AtomTypes.InvocationStatus.Serving, "Invalid status");
        require(msg.sender == inv.server, "Not invocation server");
        require(block.number <= inv.serviceDeadlineBlock, "Service deadline passed");
        require(inv.proofCount == inv.totalOperationCount, "Incomplete proofs");

        inv.proofSubmissionComplete = true;
        inv.status = AtomTypes.InvocationStatus.Auditing;
        emit AllProofsSubmitted(invokeId, inv.proofCount);
    }

    function submitJudgeVote(bytes32 invokeId, bool valid, bytes32 auditHash) external {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(inv.status == AtomTypes.InvocationStatus.Auditing, "Not auditing");
        require(block.number <= inv.auditDeadlineBlock, "Audit deadline passed");
        require(isJudgeSelected[invokeId][msg.sender], "Not selected judge");

        AtomTypes.JudgeVote storage vote = _judgeVotes[invokeId][msg.sender];
        require(!vote.submitted, "Vote exists");

        vote.submitted = true;
        vote.auditHash = auditHash;
        vote.decision = valid ? AtomTypes.JudgeDecision.Valid : AtomTypes.JudgeDecision.Invalid;

        if (valid) {
            inv.validVoteCount += 1;
            if (inv.validVoteCount >= inv.judgeNumMin) {
                inv.status = AtomTypes.InvocationStatus.Valid;
            }
        } else {
            inv.invalidVoteCount += 1;
            if (inv.invalidVoteCount >= inv.judgeNumMin) {
                inv.status = AtomTypes.InvocationStatus.Invalid;
            }
        }

        emit JudgeVoteSubmitted(invokeId, msg.sender, valid, auditHash);
    }

    function finalizeInvocation(bytes32 invokeId) external {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        if (inv.status == AtomTypes.InvocationStatus.Valid) {
            _settleInvocation(invokeId, true);
            inv.status = AtomTypes.InvocationStatus.Settled;
            emit InvocationFinalized(invokeId);
            return;
        }
        if (inv.status == AtomTypes.InvocationStatus.Invalid) {
            _settleInvocation(invokeId, false);
            inv.status = AtomTypes.InvocationStatus.Settled;
            emit InvocationInvalidated(invokeId);
            return;
        }
        revert("Invocation not finalizable");
    }

    function extendInvocation(bytes32 invokeId) external {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(
            inv.status == AtomTypes.InvocationStatus.Serving || inv.status == AtomTypes.InvocationStatus.Auditing,
            "Invocation not extendable"
        );
        require(msg.sender == inv.server || msg.sender == owner(), "Not authorized");
        require(extensionCount[invokeId] < MAX_EXTENSIONS, "Max extensions reached");

        extensionCount[invokeId] += 1;

        uint256 serviceExtension = inv.serviceDeadlineBlock - inv.startedBlock;
        uint256 auditExtension = inv.auditDeadlineBlock - inv.serviceDeadlineBlock;

        inv.serviceDeadlineBlock += serviceExtension;
        inv.auditDeadlineBlock += auditExtension;

        emit InvocationExtended(invokeId, inv.serviceDeadlineBlock, inv.auditDeadlineBlock);
    }

    function forceSettle(bytes32 invokeId) external {
        AtomTypes.Invocation storage inv = _invocations[invokeId];
        require(
            inv.status == AtomTypes.InvocationStatus.Serving ||
                inv.status == AtomTypes.InvocationStatus.Auditing ||
                inv.status == AtomTypes.InvocationStatus.Valid ||
                inv.status == AtomTypes.InvocationStatus.Invalid,
            "Invocation not force-settlable"
        );
        require(block.number > inv.auditDeadlineBlock, "Audit deadline not reached");

        inv.status = AtomTypes.InvocationStatus.ForceSettled;
        emit InvocationForceSettled(invokeId);
        // Signal off-chain Server to trigger book_undo_unlock() on all service chains
        emit ForceSettleUndoRequired(invokeId, inv.server, inv.totalOperationCount);
    }

    function setSettlementTerms(
        uint256 serverRewardAmount_,
        uint256 serverPenaltyAmount_,
        uint256 judgeRewardAmount_,
        uint256 judgePenaltyAmount_
    ) external onlyOwner {
        serverRewardAmount = serverRewardAmount_;
        serverPenaltyAmount = serverPenaltyAmount_;
        judgeRewardAmount = judgeRewardAmount_;
        judgePenaltyAmount = judgePenaltyAmount_;
        emit SettlementTermsUpdated(
            serverRewardAmount_,
            serverPenaltyAmount_,
            judgeRewardAmount_,
            judgePenaltyAmount_
        );
    }

    function fundRewardPool() external payable onlyOwner {
        require(msg.value > 0, "Zero funding");
        rewardPool += msg.value;
        emit RewardPoolFunded(msg.sender, msg.value, rewardPool);
    }

    function depositBond() external payable {
        require(msg.value > 0, "Zero bond");
        require(
            atomCommunity.activeServers(msg.sender) || atomCommunity.activeJudges(msg.sender),
            "Not community participant"
        );
        depositedBonds[msg.sender] += msg.value;
        emit BondDeposited(msg.sender, msg.value, depositedBonds[msg.sender]);
    }

    function withdrawBond(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(depositedBonds[msg.sender] >= amount, "Insufficient bond");
        depositedBonds[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Bond withdraw failed");
        emit BondWithdrawn(msg.sender, amount, depositedBonds[msg.sender]);
    }

    function withdrawSettlement() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No pending settlement");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Settlement withdraw failed");
        emit SettlementWithdrawal(msg.sender, amount);
    }

    function getInvocation(bytes32 invokeId) external view returns (AtomTypes.Invocation memory) {
        return _invocations[invokeId];
    }

    function getSelectedJudges(bytes32 invokeId) external view returns (address[] memory) {
        return _invocations[invokeId].judges;
    }

    function getOperationProof(bytes32 invokeId, uint256 operationId)
        external
        view
        returns (AtomTypes.OperationProof memory)
    {
        return _operationProofs[invokeId][operationId];
    }

    function getJudgeVote(bytes32 invokeId, address judge) external view returns (AtomTypes.JudgeVote memory) {
        return _judgeVotes[invokeId][judge];
    }

    function hashOperationProof(AtomTypes.OperationProof calldata proof) external pure returns (bytes32) {
        return _hashOperationProof(proof);
    }

    function _settleInvocation(bytes32 invokeId, bool finalDecisionValid) internal {
        require(!settlementApplied[invokeId], "Invocation already settled");
        settlementApplied[invokeId] = true;

        AtomTypes.Invocation storage inv = _invocations[invokeId];
        if (finalDecisionValid) {
            _creditReward(inv.server, serverRewardAmount, "Server produced valid invocation");
        } else {
            _slashBond(inv.server, serverPenaltyAmount, "Server produced invalid invocation");
        }

        uint256 len = inv.judges.length;
        for (uint256 i = 0; i < len; i++) {
            address judge = inv.judges[i];
            AtomTypes.JudgeVote storage vote = _judgeVotes[invokeId][judge];
            bool voteMatches = vote.submitted
                && (
                    (finalDecisionValid && vote.decision == AtomTypes.JudgeDecision.Valid)
                        || (!finalDecisionValid && vote.decision == AtomTypes.JudgeDecision.Invalid)
                );

            if (voteMatches) {
                _creditReward(judge, judgeRewardAmount, "Judge matched final audit result");
            } else {
                _slashBond(judge, judgePenaltyAmount, "Judge mismatch or missing vote");
            }
        }

        emit InvocationSettled(invokeId, finalDecisionValid);
    }

    function _creditReward(address participant, uint256 amount, string memory reason) internal {
        if (participant == address(0) || amount == 0) {
            return;
        }

        uint256 available = rewardPool + penaltyPool;
        uint256 credit = amount > available ? available : amount;
        if (credit == 0) {
            return;
        }

        if (rewardPool >= credit) {
            rewardPool -= credit;
        } else {
            uint256 remainder = credit - rewardPool;
            rewardPool = 0;
            penaltyPool -= remainder;
        }

        pendingWithdrawals[participant] += credit;
        emit RewardCredited(participant, credit, reason);
    }

    function _slashBond(address participant, uint256 amount, string memory reason) internal {
        if (participant == address(0) || amount == 0) {
            return;
        }

        uint256 bond = depositedBonds[participant];
        uint256 slashAmount = amount > bond ? bond : amount;
        if (slashAmount == 0) {
            return;
        }

        depositedBonds[participant] = bond - slashAmount;
        penaltyPool += slashAmount;
        emit BondSlashed(participant, slashAmount, reason);
    }

    function _hashOperationProof(AtomTypes.OperationProof memory proof) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                proof.invokeId,
                proof.operationId,
                proof.chainId,
                proof.lockDoBlockNumber,
                proof.lockDoTxHash,
                proof.unlockBlockNumber,
                proof.unlockTxHash,
                proof.undoBlockNumber,
                proof.undoTxHash,
                proof.readBlockNumber,
                proof.readTxHash,
                proof.dependencyHash
            )
        );
    }

    function _recoverProofSigner(bytes32 proofHash, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "Invalid signature v");
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", proofHash));
        return ecrecover(digest, v, r, s);
    }
}
