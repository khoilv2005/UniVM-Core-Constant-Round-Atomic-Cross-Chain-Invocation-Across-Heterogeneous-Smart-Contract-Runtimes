// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title CrossChainErrors
 * @notice Custom errors for IntegrateX — covers all failure modes described in the paper.
 */
library CrossChainErrors {
    error NotBridgingContract();
    error AlreadyRegistered();
    error NotVerified();
    error AlreadyVerified();
    error BytecodeMismatch();
    error StateAlreadyLocked();
    error StateNotLocked();
    error InvalidLockAmount();
    error InsufficientState();
    error InvalidTimeout();
    error ExecutionFailed();
    error CrossChainCallFailed();
    error NotContractOwner();
    error InvalidCrossChainTx();
    error DuplicateCrossChainTx();
    error VerificationFailed();
    error LockBagNotFound();
    error TimeoutExceeded();
    error NotRelayer();
    error InsufficientStake();
    error NotAuthorizedProvider();
    error BlockNotFinalized();
    error InvalidBlockHeader();
    error InvalidMerkleProof();
    error FeeNotPaid();
    error NotRegisteredRelayer();
    error RelayerAlreadyRegistered();
    error InvalidMessageSender();
    error CrossChainMessageAlreadyProcessed();
    error ContractNotVerifiedForExecution();
}