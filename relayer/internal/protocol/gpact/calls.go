package gpact

import (
	"encoding/json"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

type wasmInvokeEnvelope struct {
	Version  int            `json:"version"`
	Contract string         `json:"contract"`
	Message  string         `json:"message"`
	Args     map[string]any `json:"args"`
}

type fabricInvokeEnvelope struct {
	Version  int            `json:"version"`
	Endpoint string         `json:"endpoint"`
	Message  string         `json:"message"`
	Args     map[string]any `json:"args"`
}

var controlABI = mustABI(`[
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"},{"internalType":"uint256","name":"segmentId","type":"uint256"},{"internalType":"uint256","name":"rootChainId","type":"uint256"},{"internalType":"bytes32","name":"callTreeHash","type":"bytes32"},{"internalType":"address","name":"app","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"},{"internalType":"uint256","name":"segmentTimeoutBlocks","type":"uint256"}],"name":"segment","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"},{"internalType":"uint256","name":"rootChainId","type":"uint256"},{"internalType":"bytes32","name":"callTreeHash","type":"bytes32"},{"internalType":"address","name":"app","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"},{"internalType":"uint256[]","name":"segmentIds","type":"uint256[]"},{"internalType":"uint256[]","name":"segmentChainIds","type":"uint256[]"},{"internalType":"bytes32[]","name":"segmentResultHashes","type":"bytes32[]"},{"internalType":"bytes[][]","name":"segmentSignatures","type":"bytes[][]"}],"name":"root","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"},{"internalType":"uint256","name":"segmentId","type":"uint256"},{"internalType":"bytes32","name":"callTreeHash","type":"bytes32"},{"internalType":"address","name":"app","type":"address"},{"internalType":"bool","name":"commit","type":"bool"},{"internalType":"bool","name":"abortTx","type":"bool"},{"internalType":"bytes[]","name":"rootEventSignatures","type":"bytes[]"}],"name":"signalling","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"}],"name":"abortOnTimeout","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"},{"internalType":"address","name":"app","type":"address"}],"name":"gpactTimeoutUnlock","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"}],"name":"completeExecution","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

func NewCallSegment(txID [32]byte, segmentID uint64, rootChainID uint64, callTreeHash [32]byte, app common.Address, callData []byte, timeoutBlocks uint64) ([]byte, error) {
	return controlABI.Pack("segment", txID, u(segmentID), u(rootChainID), callTreeHash, app, callData, u(timeoutBlocks))
}

func NewCallRoot(txID [32]byte, rootChainID uint64, callTreeHash [32]byte, app common.Address, callData []byte, segmentIDs []uint64, segmentChainIDs []uint64, segmentResultHashes []common.Hash, segmentSignatures [][][]byte) ([]byte, error) {
	signatures := make([][][]byte, len(segmentSignatures))
	copy(signatures, segmentSignatures)
	ids := make([]*big.Int, 0, len(segmentIDs))
	for _, segmentID := range segmentIDs {
		ids = append(ids, u(segmentID))
	}
	chainIDs := make([]*big.Int, 0, len(segmentChainIDs))
	for _, chainID := range segmentChainIDs {
		chainIDs = append(chainIDs, u(chainID))
	}
	return controlABI.Pack("root", txID, u(rootChainID), callTreeHash, app, callData, ids, chainIDs, segmentResultHashes, signatures)
}

func NewCallSignalling(txID [32]byte, segmentID uint64, callTreeHash [32]byte, app common.Address, commit bool, abortTx bool, rootEventSignatures [][]byte) ([]byte, error) {
	signatures := make([][]byte, len(rootEventSignatures))
	copy(signatures, rootEventSignatures)
	return controlABI.Pack("signalling", txID, u(segmentID), callTreeHash, app, commit, abortTx, signatures)
}

func NewCallAbortOnTimeout(txID [32]byte) ([]byte, error) {
	return controlABI.Pack("abortOnTimeout", txID)
}

func NewCallGpactTimeoutUnlock(txID [32]byte, app common.Address) ([]byte, error) {
	return controlABI.Pack("gpactTimeoutUnlock", txID, app)
}

func NewCallCompleteExecution(txID [32]byte) ([]byte, error) {
	return controlABI.Pack("completeExecution", txID)
}

func NewWASMCallSegment(contract string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, timeoutBlocks uint64) ([]byte, error) {
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "gpact_segment",
		Args: map[string]any{
			"tx_id":          hashHex(txID),
			"call_tree_hash": hashHex(callTreeHash),
			"chain_id":       chainID,
			"segment_id":     segmentID,
			"app":            app,
			"timeout_blocks": timeoutBlocks,
		},
	})
}

func NewFabricCallSegment(endpoint string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, timeoutBlocks uint64) ([]byte, error) {
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "gpact_segment",
		Args: map[string]any{
			"tx_id":          hashHex(txID),
			"call_tree_hash": hashHex(callTreeHash),
			"chain_id":       chainID,
			"segment_id":     segmentID,
			"app":            app,
			"timeout_blocks": timeoutBlocks,
		},
	})
}

func NewWASMCallSignalling(contract string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, commit bool, abortTx bool) ([]byte, error) {
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "gpact_signalling",
		Args: map[string]any{
			"tx_id":          hashHex(txID),
			"call_tree_hash": hashHex(callTreeHash),
			"chain_id":       chainID,
			"segment_id":     segmentID,
			"app":            app,
			"commit":         commit,
			"abort_tx":       abortTx,
		},
	})
}

func NewFabricCallSignalling(endpoint string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, commit bool, abortTx bool) ([]byte, error) {
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "gpact_signalling",
		Args: map[string]any{
			"tx_id":          hashHex(txID),
			"call_tree_hash": hashHex(callTreeHash),
			"chain_id":       chainID,
			"segment_id":     segmentID,
			"app":            app,
			"commit":         commit,
			"abort_tx":       abortTx,
		},
	})
}

func NewWASMCallTimeoutUnlock(contract string, txID [32]byte, segmentID uint64, chainID uint64) ([]byte, error) {
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "gpact_timeout_unlock",
		Args: map[string]any{
			"tx_id":      hashHex(txID),
			"chain_id":   chainID,
			"segment_id": segmentID,
		},
	})
}

func NewFabricCallTimeoutUnlock(endpoint string, txID [32]byte, segmentID uint64, chainID uint64) ([]byte, error) {
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "gpact_timeout_unlock",
		Args: map[string]any{
			"tx_id":      hashHex(txID),
			"chain_id":   chainID,
			"segment_id": segmentID,
		},
	})
}

func mustABI(raw string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(raw))
	if err != nil {
		panic(err)
	}
	return parsed
}

func u(v uint64) *big.Int {
	return new(big.Int).SetUint64(v)
}

func hashHex(value [32]byte) string {
	return "0x" + common.Bytes2Hex(value[:])
}
