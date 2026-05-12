// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice RQ3d synthetic translation-overhead benchmark targets.
 *
 * These contracts implement the same deterministic safe-subset transition:
 * update N logical storage slots with integer arithmetic and bounded loops.
 *
 * - RQ3DHandwritten uses direct Solidity storage.
 * - RQ3DTranslatedNaive models a literal cross-VM translation that stores
 *   canonical bytes and decodes/encodes every slot on every access.
 * - RQ3DTranslatedOptimized models the UBTL optimizer after canonical slot
 *   coalescing and typed storage lowering.
 */

contract RQ3DHandwritten {
    uint256[] private slots_;
    uint256 public checksum;

    constructor(uint256 slotCount) {
        require(slotCount > 0 && slotCount <= 64, "slotCount");
        for (uint256 i = 0; i < slotCount; i++) {
            slots_.push(i + 1);
        }
    }

    function slotCount() external view returns (uint256) {
        return slots_.length;
    }

    function execute(uint256 input, uint256 rounds) external returns (uint256) {
        require(rounds > 0 && rounds <= 8, "rounds");
        uint256 acc = input;
        uint256 len = slots_.length;
        for (uint256 r = 0; r < rounds; r++) {
            for (uint256 i = 0; i < len; i++) {
                uint256 value = slots_[i];
                if (((acc + i + r) & 1) == 0) {
                    value = value + acc + i + r;
                } else {
                    value = value > i ? value - i : value + 1;
                }
                slots_[i] = value;
                acc = uint256(keccak256(abi.encodePacked(acc, value, i, r)));
            }
        }
        checksum = acc;
        return acc;
    }

    function readSlot(uint256 index) external view returns (uint256) {
        return slots_[index];
    }
}

contract RQ3DTranslatedNaive {
    mapping(bytes32 => bytes) private kv;
    uint256 public immutable slotCountValue;
    bytes32 private constant CHECKSUM_SLOT = keccak256("rq3d.checksum");

    constructor(uint256 slotCount) {
        require(slotCount > 0 && slotCount <= 64, "slotCount");
        slotCountValue = slotCount;
        for (uint256 i = 0; i < slotCount; i++) {
            _writeUint(_slotKey(i), i + 1);
        }
    }

    function slotCount() external view returns (uint256) {
        return slotCountValue;
    }

    function execute(bytes calldata encodedInput) external returns (bytes memory) {
        (uint256 input, uint256 rounds) = abi.decode(encodedInput, (uint256, uint256));
        require(rounds > 0 && rounds <= 8, "rounds");
        uint256 acc = input;
        for (uint256 r = 0; r < rounds; r++) {
            for (uint256 i = 0; i < slotCountValue; i++) {
                bytes32 key = _slotKey(i);
                uint256 value = _readUint(key);
                if (((acc + i + r) & 1) == 0) {
                    value = value + acc + i + r;
                } else {
                    value = value > i ? value - i : value + 1;
                }
                _writeUint(key, value);
                acc = uint256(keccak256(abi.encodePacked(acc, value, i, r)));
            }
        }
        _writeUint(CHECKSUM_SLOT, acc);
        return abi.encode(acc);
    }

    function checksum() external view returns (uint256) {
        return _readUint(CHECKSUM_SLOT);
    }

    function readSlot(uint256 index) external view returns (uint256) {
        return _readUint(_slotKey(index));
    }

    function _slotKey(uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("rq3d.slot.", index));
    }

    function _readUint(bytes32 key) private view returns (uint256) {
        bytes storage raw = kv[key];
        if (raw.length == 0) return 0;
        return abi.decode(raw, (uint256));
    }

    function _writeUint(bytes32 key, uint256 value) private {
        kv[key] = abi.encode(value);
    }
}

contract RQ3DTranslatedOptimized {
    mapping(bytes32 => uint256) private kv;
    uint256 public immutable slotCountValue;
    uint256 public checksum;

    constructor(uint256 slotCount) {
        require(slotCount > 0 && slotCount <= 64, "slotCount");
        slotCountValue = slotCount;
        for (uint256 i = 0; i < slotCount; i++) {
            kv[_slotKey(i)] = i + 1;
        }
    }

    function slotCount() external view returns (uint256) {
        return slotCountValue;
    }

    function execute(uint256 input, uint256 rounds) external returns (uint256) {
        require(rounds > 0 && rounds <= 8, "rounds");
        uint256 acc = input;
        for (uint256 r = 0; r < rounds; r++) {
            for (uint256 i = 0; i < slotCountValue; i++) {
                bytes32 key = _slotKey(i);
                uint256 value = kv[key];
                if (((acc + i + r) & 1) == 0) {
                    value = value + acc + i + r;
                } else {
                    value = value > i ? value - i : value + 1;
                }
                kv[key] = value;
                acc = uint256(keccak256(abi.encodePacked(acc, value, i, r)));
            }
        }
        checksum = acc;
        return acc;
    }

    function readSlot(uint256 index) external view returns (uint256) {
        return kv[_slotKey(index)];
    }

    function _slotKey(uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("rq3d.slot.", index));
    }
}
