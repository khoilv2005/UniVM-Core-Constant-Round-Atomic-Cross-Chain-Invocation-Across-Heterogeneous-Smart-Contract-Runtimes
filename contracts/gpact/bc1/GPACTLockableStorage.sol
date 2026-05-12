// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract GPACTLockableStorage {
    struct LockRecord {
        bool locked;
        bytes provisionalData;
        uint256 lockBlock;
        uint256 timeoutBlocks;
    }

    mapping(bytes32 => LockRecord) internal _lockRecords;

    event LockTimedOut(bytes32 indexed crosschainTxId);

    function _lockForTx(bytes32 crosschainTxId, uint256 timeoutBlocks) internal {
        require(!_lockRecords[crosschainTxId].locked, "Already locked");
        _lockRecords[crosschainTxId].locked = true;
        _lockRecords[crosschainTxId].lockBlock = block.number;
        _lockRecords[crosschainTxId].timeoutBlocks = timeoutBlocks;
    }

    function _storeProvisional(bytes32 crosschainTxId, bytes memory provisionalData) internal {
        require(_lockRecords[crosschainTxId].locked, "Not locked");
        _lockRecords[crosschainTxId].provisionalData = provisionalData;
    }

    function _loadProvisional(bytes32 crosschainTxId) internal view returns (bytes memory) {
        require(_lockRecords[crosschainTxId].locked, "Not locked");
        return _lockRecords[crosschainTxId].provisionalData;
    }

    function _clearLock(bytes32 crosschainTxId) internal {
        delete _lockRecords[crosschainTxId];
    }

    /**
     * @notice Timeout a lock that has exceeded its deadline.
     *         Anyone can call this to free a stuck lock after timeout.
     *         Concrete apps SHOULD wrap this in `gpactTimeoutUnlock(bytes32)`
     *         (IGPACTApp) so that they can also release any app-specific state
     *         (e.g. restoring `remain` counters) before clearing the lock.
     */
    function _timeoutLock(bytes32 crosschainTxId) internal {
        LockRecord storage record = _lockRecords[crosschainTxId];
        require(record.locked, "Not locked");
        require(block.number > record.lockBlock + record.timeoutBlocks, "Not timed out");
        delete _lockRecords[crosschainTxId];
        emit LockTimedOut(crosschainTxId);
    }

    function isLocked(bytes32 crosschainTxId) public view returns (bool) {
        return _lockRecords[crosschainTxId].locked;
    }

    function hasTimedOut(bytes32 crosschainTxId) public view returns (bool) {
        LockRecord storage record = _lockRecords[crosschainTxId];
        if (!record.locked) return false;
        return block.number > record.lockBlock + record.timeoutBlocks;
    }
}
