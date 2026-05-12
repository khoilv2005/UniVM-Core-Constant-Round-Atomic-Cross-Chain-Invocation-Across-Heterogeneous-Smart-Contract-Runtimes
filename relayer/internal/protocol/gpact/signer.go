package gpact

import (
	"crypto/ecdsa"
	"encoding/hex"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var (
	segmentEventTag = crypto.Keccak256Hash([]byte("GPACT_SEGMENT_EVENT"))
	rootEventTag    = crypto.Keccak256Hash([]byte("GPACT_ROOT_EVENT"))
	hashABI         = mustHashArgs("bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32")
	hashRootABI     = mustHashArgs("bytes32", "bytes32", "uint256", "bytes32", "bool", "bool")
)

func ParseSignerKeys(hexKeys []string) ([]*ecdsa.PrivateKey, error) {
	keys := make([]*ecdsa.PrivateKey, 0, len(hexKeys))
	for _, raw := range hexKeys {
		keyHex := strings.TrimPrefix(strings.TrimSpace(raw), "0x")
		keyBytes, err := hex.DecodeString(keyHex)
		if err != nil {
			return nil, err
		}
		key, err := crypto.ToECDSA(keyBytes)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, nil
}

func SignSegmentEvent(keys []*ecdsa.PrivateKey, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, segmentResultHash [32]byte) ([][]byte, error) {
	packed, err := hashABI.Pack(segmentEventTag, txID, big.NewInt(int64(segmentID)), big.NewInt(int64(chainID)), callTreeHash, segmentResultHash)
	if err != nil {
		return nil, err
	}
	digest := crypto.Keccak256Hash(packed)
	return signAll(keys, digest)
}

func SignRootEvent(keys []*ecdsa.PrivateKey, txID [32]byte, rootChainID uint64, callTreeHash [32]byte, commit bool, abortTx bool) ([][]byte, error) {
	packed, err := hashRootABI.Pack(rootEventTag, txID, big.NewInt(int64(rootChainID)), callTreeHash, commit, abortTx)
	if err != nil {
		return nil, err
	}
	digest := crypto.Keccak256Hash(packed)
	return signAll(keys, digest)
}

func signAll(keys []*ecdsa.PrivateKey, digest common.Hash) ([][]byte, error) {
	signatures := make([][]byte, 0, len(keys))
	prefix := []byte("\x19Ethereum Signed Message:\n32")
	ethSigned := crypto.Keccak256Hash(prefix, digest.Bytes())
	for _, key := range keys {
		sig, err := crypto.Sign(ethSigned.Bytes(), key)
		if err != nil {
			return nil, err
		}
		sig[64] += 27
		signatures = append(signatures, sig)
	}
	return signatures, nil
}

func mustHashArgs(kinds ...string) abi.Arguments {
	args := make(abi.Arguments, 0, len(kinds))
	for _, kind := range kinds {
		typ, err := abi.NewType(kind, "", nil)
		if err != nil {
			panic(err)
		}
		args = append(args, abi.Argument{Type: typ})
	}
	return args
}
