// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title UBTLRegistry
 * @notice Stores translation commitments for XSmartContract.
 *         The registry binds a source-chain contract hash to:
 *         - the semantic IR hash (`irHash`)
 *         - the translated EVM contract on bc1
 *         - the committed storage-map root used by VASSP application.
 *
 *         In the current prototype, `verify` is a commitment check:
 *         it compares the peer-reported IR hash against the registered one.
 *         `merkleProof` is reserved for the later proof-aware verifier.
 */
contract UBTLRegistry {
    struct Translation {
        uint256 sourceChainId;
        bytes32 sourceContractHash;
        bytes32 irHash;
        address translated;
        bytes32 storageMapRoot;
        address dAppProvider;
        uint256 registeredAt;
    }

    error ZeroAddress();
    error NotContract(address translated);
    error TranslationAlreadyRegistered(bytes32 key);
    error TranslatedAddressAlreadyBound(address translated, bytes32 key);
    error UnknownTranslation(bytes32 key);
    error NotOwner();

    address public owner;
    bool public proofAwareVerificationRequired;
    mapping(bytes32 => Translation) public translations;
    mapping(address => bytes32) public byTranslated;
    mapping(bytes32 => bool) public verified;

    event TranslationRegistered(
        bytes32 indexed key,
        uint256 indexed sourceChainId,
        bytes32 indexed sourceContractHash,
        bytes32 irHash,
        address translated,
        bytes32 storageMapRoot,
        address dAppProvider,
        uint256 registeredAt
    );
    event TranslationVerified(bytes32 indexed key, bool ok);
    event ProofAwareVerificationModeSet(bool required);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function keyFor(uint256 sourceChainId, bytes32 sourceContractHash) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceContractHash));
    }

    function register(
        uint256 sourceChainId,
        bytes32 sourceContractHash,
        bytes32 irHash,
        address translated,
        bytes32 storageMapRoot
    ) external {
        if (translated == address(0)) revert ZeroAddress();
        if (translated.code.length == 0) revert NotContract(translated);

        bytes32 key = keyFor(sourceChainId, sourceContractHash);
        if (translations[key].translated != address(0)) {
            revert TranslationAlreadyRegistered(key);
        }

        bytes32 existingKey = byTranslated[translated];
        if (existingKey != bytes32(0)) {
            revert TranslatedAddressAlreadyBound(translated, existingKey);
        }

        translations[key] = Translation({
            sourceChainId: sourceChainId,
            sourceContractHash: sourceContractHash,
            irHash: irHash,
            translated: translated,
            storageMapRoot: storageMapRoot,
            dAppProvider: msg.sender,
            registeredAt: block.timestamp
        });
        byTranslated[translated] = key;

        emit TranslationRegistered(
            key,
            sourceChainId,
            sourceContractHash,
            irHash,
            translated,
            storageMapRoot,
            msg.sender,
            block.timestamp
        );
    }

    function setProofAwareVerificationRequired(bool required) external onlyOwner {
        proofAwareVerificationRequired = required;
        emit ProofAwareVerificationModeSet(required);
    }

    /**
     * @notice Verifies that the peer-reported IR hash matches the registered commitment.
     * @dev If `merkleProof` is supplied, it must ABI-decode as
     *      `(bytes32 leaf, bytes32[] proof)` and verify under the registered
     *      `storageMapRoot`. If `proofAwareVerificationRequired` is true,
     *      omitting this proof makes verification fail.
     */
    function verify(
        bytes32 key,
        bytes32 peerIrHash,
        bytes calldata merkleProof
    ) external returns (bool) {
        Translation memory translation = translations[key];
        if (translation.translated == address(0)) revert UnknownTranslation(key);

        if (verified[key]) {
            emit TranslationVerified(key, true);
            return true;
        }

        bool ok = peerIrHash == translation.irHash && peerIrHash != bytes32(0);
        if (ok && (proofAwareVerificationRequired || merkleProof.length > 0)) {
            ok = _verifyStorageMapProof(translation.storageMapRoot, merkleProof);
        }
        if (ok) {
            verified[key] = true;
        }

        emit TranslationVerified(key, ok);
        return ok;
    }

    function _verifyStorageMapProof(bytes32 storageMapRoot, bytes calldata merkleProof)
        private
        pure
        returns (bool)
    {
        if (storageMapRoot == bytes32(0) || merkleProof.length == 0) {
            return false;
        }
        (bytes32 leaf, bytes32[] memory proof) = abi.decode(merkleProof, (bytes32, bytes32[]));
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == storageMapRoot;
    }
}
