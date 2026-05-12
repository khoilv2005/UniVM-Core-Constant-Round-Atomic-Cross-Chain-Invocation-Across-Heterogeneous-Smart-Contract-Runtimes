// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title LockPoolLib
 * @notice Implements the fine-grained state lock pool mechanism from IntegrateX (Section V-C).
 *         Allows partial locking of uint256 variables so unrelated transactions can proceed
 *         concurrently on the unlocked portion. "lock_size" determines the fixed-size
 *         incremental lock granularity for dynamically-used states.
 */
library LockPoolLib {
    struct LockBag {
        uint256 amount;
        uint256 crossChainTxId;
        uint256 lockBlockNumber;
        uint256 timeoutBlocks;
    }

    struct LockPool {
        mapping(uint256 => LockBag) bags;
        uint256 lockedTotal;
        uint256 bagCount;
    }

    event StateLocked(uint256 indexed crossChainTxId, uint256 amount);
    event StateUnlocked(uint256 indexed crossChainTxId, uint256 amount);

    function lock(
        LockPool storage pool,
        uint256 crossChainTxId,
        uint256 amount,
        uint256 timeoutBlocks
    ) internal returns (bool) {
        require(amount > 0, "LockPool: zero amount");
        require(pool.bags[crossChainTxId].amount == 0, "LockPool: tx already locked");

        pool.bags[crossChainTxId] = LockBag({
            amount: amount,
            crossChainTxId: crossChainTxId,
            lockBlockNumber: block.number,
            timeoutBlocks: timeoutBlocks
        });
        pool.lockedTotal += amount;
        pool.bagCount++;

        emit StateLocked(crossChainTxId, amount);
        return true;
    }

    function unlock(LockPool storage pool, uint256 crossChainTxId) internal returns (uint256) {
        LockBag storage bag = pool.bags[crossChainTxId];
        require(bag.amount > 0, "LockPool: bag not found");

        uint256 amount = bag.amount;
        pool.lockedTotal -= amount;
        pool.bagCount--;

        delete pool.bags[crossChainTxId];

        emit StateUnlocked(crossChainTxId, amount);
        return amount;
    }

    function unlockOnTimeout(LockPool storage pool, uint256 crossChainTxId) internal returns (uint256) {
        LockBag storage bag = pool.bags[crossChainTxId];
        require(bag.amount > 0, "LockPool: bag not found");
        require(hasTimedOut(pool, crossChainTxId), "LockPool: not timed out");

        return unlock(pool, crossChainTxId);
    }

    function isLocked(LockPool storage pool, uint256 crossChainTxId) internal view returns (bool) {
        return pool.bags[crossChainTxId].amount > 0;
    }

    function getLockedAmount(LockPool storage pool, uint256 crossChainTxId) internal view returns (uint256) {
        return pool.bags[crossChainTxId].amount;
    }

    function getLockedTotal(LockPool storage pool) internal view returns (uint256) {
        return pool.lockedTotal;
    }

    function hasTimedOut(LockPool storage pool, uint256 crossChainTxId) internal view returns (bool) {
        LockBag storage bag = pool.bags[crossChainTxId];
        if (bag.amount == 0) return false;
        return (block.number - bag.lockBlockNumber) > bag.timeoutBlocks;
    }

    function getEffectiveTimeout(uint256 dappTimeout, uint256 bridgeTimeout) internal pure returns (uint256) {
        return dappTimeout < bridgeTimeout ? dappTimeout : bridgeTimeout;
    }

    function availableAfterLock(uint256 totalValue, uint256 lockedTotal) internal pure returns (uint256) {
        require(totalValue >= lockedTotal, "LockPool: underflow");
        return totalValue - lockedTotal;
    }
}