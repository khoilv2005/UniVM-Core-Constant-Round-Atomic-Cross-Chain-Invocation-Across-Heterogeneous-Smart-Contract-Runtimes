// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GPACTSigLib} from "./GPACTSigLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract GPACTEventSignerRegistry is Ownable {
    mapping(address => bool) public activeSigners;
    uint256 public quorum;
    uint256 public activeSignerCount;

    event SignerRegistered(address indexed signer, bool active);
    event QuorumUpdated(uint256 quorum);

    constructor(uint256 quorum_) Ownable(msg.sender) {
        require(quorum_ > 0, "Zero quorum");
        quorum = quorum_;
    }

    function registerSigner(address signer) external onlyOwner {
        require(signer != address(0), "Zero signer");
        if (!activeSigners[signer]) {
            activeSigners[signer] = true;
            activeSignerCount += 1;
        }
        emit SignerRegistered(signer, true);
    }

    function revokeSigner(address signer) external onlyOwner {
        if (activeSigners[signer]) {
            activeSigners[signer] = false;
            activeSignerCount -= 1;
        }
        emit SignerRegistered(signer, false);
    }

    function setQuorum(uint256 quorum_) external onlyOwner {
        require(quorum_ > 0, "Zero quorum");
        require(quorum_ <= activeSignerCount, "Quorum exceeds active signers");
        quorum = quorum_;
        emit QuorumUpdated(quorum_);
    }

    function verifySignedEvent(bytes32 digest, bytes[] calldata signatures) external view returns (bool) {
        uint256 validCount;
        bytes32 ethSigned = GPACTSigLib.ethSignedMessageHash(digest);
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = GPACTSigLib.recover(ethSigned, signatures[i]);
            if (!activeSigners[signer]) {
                continue;
            }
            bool duplicate;
            for (uint256 j = 0; j < seenCount; j++) {
                if (seen[j] == signer) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) {
                continue;
            }

            seen[seenCount] = signer;
            seenCount += 1;
            validCount += 1;
            if (validCount >= quorum) {
                return true;
            }
        }

        return false;
    }
}
