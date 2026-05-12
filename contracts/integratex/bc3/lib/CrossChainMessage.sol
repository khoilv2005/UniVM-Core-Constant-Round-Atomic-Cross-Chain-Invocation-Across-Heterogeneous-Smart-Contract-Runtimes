// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title CrossChainMessage
 * @notice Structured cross-chain message format for IntegrateX.
 *         Encodes the message type, source/destination chains, nonce, and payload
 *         so that the bridging contract can verify authenticity via Merkle proof
 *         and dedup via nonce (Section IV-C, Section V-A, Section VI-B Verifiability).
 */
library CrossChainMessage {
    enum MessageType {
        DEPLOY_REQUEST,
        DEPLOY_CLONE,
        VERIFICATION_REQUEST,
        VERIFICATION_RESULT,
        LOCK_REQUEST,
        LOCK_RESPONSE,
        INTEGRATED_EXECUTION_RESULT,
        UPDATE_REQUEST,
        UPDATE_ACK,
        ROLLBACK_REQUEST,
        STATE_RESPONSE
    }

    struct Message {
        MessageType msgType;
        uint256 sourceChainId;
        uint256 destChainId;
        uint256 nonce;
        address sender;
        bytes payload;
    }

    function encode(Message memory msg_) internal pure returns (bytes memory) {
        return abi.encode(
            msg_.msgType,
            msg_.sourceChainId,
            msg_.destChainId,
            msg_.nonce,
            msg_.sender,
            msg_.payload
        );
    }

    function decode(bytes memory data) internal pure returns (Message memory) {
        (
            MessageType msgType,
            uint256 sourceChainId,
            uint256 destChainId,
            uint256 nonce,
            address sender,
            bytes memory payload
        ) = abi.decode(data, (MessageType, uint256, uint256, uint256, address, bytes));

        return Message({
            msgType: msgType,
            sourceChainId: sourceChainId,
            destChainId: destChainId,
            nonce: nonce,
            sender: sender,
            payload: payload
        });
    }

    function computeHash(Message memory msg_) internal pure returns (bytes32) {
        return keccak256(encode(msg_));
    }

    function computeReceiptHash(Message memory msg_) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            bytes1(0x00),
            encode(msg_)
        ));
    }
}