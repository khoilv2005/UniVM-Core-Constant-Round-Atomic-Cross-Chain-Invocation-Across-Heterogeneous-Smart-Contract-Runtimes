// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LockPoolLib} from "./lib/LockPoolLib.sol";
import {CrossChainErrors} from "./lib/CrossChainErrors.sol";

/**
 * @title StateContractBase
 * @notice Full implementation per IntegrateX paper:
 *   - Section IV-A: Logic-State Decoupling pattern (bridging contract access control)
 *   - Section V-C: Fine-grained lock pool via LockPoolLib
 *   - Section V-A: Bridge-only lock/unlock/update authorization
 *   - Section VIII: Authorized provider whitelist support
 */
abstract contract StateContractBase {
    address public bridgingContract;
    uint256 public lockSize;

    using LockPoolLib for LockPoolLib.LockPool;
    LockPoolLib.LockPool internal _lockPool;

    mapping(address => bool) public authorizedProviders;

    event BridgingContractSet(address indexed bridgingContract);
    event LockSizeSet(uint256 lockSize);
    event ProviderAuthorized(address indexed provider, bool authorized);

    modifier onlyBridgingContract() {
        if (msg.sender != bridgingContract) revert CrossChainErrors.NotBridgingContract();
        _;
    }

    modifier onlyAuthorizedOrBridge() {
        require(
            msg.sender == bridgingContract || authorizedProviders[msg.sender],
            "Not authorized"
        );
        _;
    }

    function setBridgingContract(address _bridgingContract) external virtual {
        require(bridgingContract == address(0) || msg.sender == bridgingContract, "Not authorized");
        require(_bridgingContract != address(0), "Zero address");
        bridgingContract = _bridgingContract;
        emit BridgingContractSet(_bridgingContract);
    }

    function setLockSize(uint256 _lockSize) external virtual onlyBridgingContract {
        require(_lockSize > 0, "Zero lock size");
        lockSize = _lockSize;
        emit LockSizeSet(_lockSize);
    }

    function authorizeProvider(address provider, bool authorized) external onlyBridgingContract {
        authorizedProviders[provider] = authorized;
        emit ProviderAuthorized(provider, authorized);
    }

    // ===== Abstract: must be implemented by state contracts =====
    function lockState(bytes calldata args) external virtual returns (uint256, uint256);
    function updateState(bytes calldata args) external virtual;

    // ===== Section V-A: Only bridge can unlock =====
    function unlockState(uint256 crossChainTxId) external virtual onlyBridgingContract {
        LockPoolLib.unlock(_lockPool, crossChainTxId);
    }

    // ===== Query functions =====
    function isStateLocked(uint256 crossChainTxId) external view returns (bool) {
        return LockPoolLib.isLocked(_lockPool, crossChainTxId);
    }

    function getLockedAmount(uint256 crossChainTxId) external view returns (uint256) {
        return LockPoolLib.getLockedAmount(_lockPool, crossChainTxId);
    }

    function getLockedTotal() external view returns (uint256) {
        return LockPoolLib.getLockedTotal(_lockPool);
    }

    function isTimedOut(uint256 crossChainTxId) external view returns (bool) {
        return LockPoolLib.hasTimedOut(_lockPool, crossChainTxId);
    }

    function unlockOnTimeout(uint256 crossChainTxId) external onlyBridgingContract {
        LockPoolLib.unlockOnTimeout(_lockPool, crossChainTxId);
    }

    function _lockState(uint256 crossChainTxId, uint256 amount, uint256 timeoutBlocks) internal {
        LockPoolLib.lock(_lockPool, crossChainTxId, amount, timeoutBlocks);
    }

    function _unlockState(uint256 crossChainTxId) internal returns (uint256) {
        return LockPoolLib.unlock(_lockPool, crossChainTxId);
    }
}
