package atom

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
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

var serviceABI = mustABI(`[
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"uint256","name":"operationId","type":"uint256"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"uint256","name":"lockDoBlockNumber","type":"uint256"},{"internalType":"bytes32","name":"lockDoTxHash","type":"bytes32"},{"internalType":"uint256","name":"unlockBlockNumber","type":"uint256"},{"internalType":"bytes32","name":"unlockTxHash","type":"bytes32"},{"internalType":"uint256","name":"undoBlockNumber","type":"uint256"},{"internalType":"bytes32","name":"undoTxHash","type":"bytes32"},{"internalType":"uint256","name":"readBlockNumber","type":"uint256"},{"internalType":"bytes32","name":"readTxHash","type":"bytes32"},{"internalType":"bytes32","name":"dependencyHash","type":"bytes32"},{"internalType":"bytes","name":"signature","type":"bytes"}],"name":"submitOperationProofFlat","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"}],"name":"markProofSubmissionComplete","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bool","name":"valid","type":"bool"},{"internalType":"bytes32","name":"auditHash","type":"bytes32"}],"name":"submitJudgeVote","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"}],"name":"finalizeInvocation","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"}],"name":"extendInvocation","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"}],"name":"forceSettle","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

var hotelABI = mustABI(`[
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes32","name":"lockHash","type":"bytes32"},{"internalType":"address","name":"user","type":"address"},{"internalType":"uint256","name":"rooms","type":"uint256"}],"name":"book_lock_do","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes","name":"hashKey","type":"bytes"}],"name":"book_unlock","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes","name":"hashKey","type":"bytes"}],"name":"book_undo_unlock","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

var trainABI = mustABI(`[
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes32","name":"lockHash","type":"bytes32"},{"internalType":"address","name":"user","type":"address"},{"internalType":"uint256","name":"outboundTickets","type":"uint256"},{"internalType":"uint256","name":"returnTickets","type":"uint256"}],"name":"book_lock_do","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes","name":"hashKey","type":"bytes"}],"name":"book_unlock","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"},{"internalType":"bytes","name":"hashKey","type":"bytes"}],"name":"book_undo_unlock","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

func NewCallSubmitOperationProofFlat(invokeID [32]byte, operationID, chainID uint64, lockDoBlock uint64, lockDoTx [32]byte, unlockBlock uint64, unlockTx [32]byte, undoBlock uint64, undoTx [32]byte, readBlock uint64, readTx [32]byte, dependencyHash [32]byte, signature []byte) ([]byte, error) {
	return serviceABI.Pack("submitOperationProofFlat", invokeID, u(operationID), u(chainID), u(lockDoBlock), lockDoTx, u(unlockBlock), unlockTx, u(undoBlock), undoTx, u(readBlock), readTx, dependencyHash, signature)
}

func NewCallMarkProofSubmissionComplete(invokeID [32]byte) ([]byte, error) {
	return serviceABI.Pack("markProofSubmissionComplete", invokeID)
}

func NewCallSubmitJudgeVote(invokeID [32]byte, valid bool, auditHash [32]byte) ([]byte, error) {
	return serviceABI.Pack("submitJudgeVote", invokeID, valid, auditHash)
}

func NewCallFinalizeInvocation(invokeID [32]byte) ([]byte, error) {
	return serviceABI.Pack("finalizeInvocation", invokeID)
}

func NewCallExtendInvocation(invokeID [32]byte) ([]byte, error) {
	return serviceABI.Pack("extendInvocation", invokeID)
}

func NewCallForceSettle(invokeID [32]byte) ([]byte, error) {
	return serviceABI.Pack("forceSettle", invokeID)
}

func NewCallBookHotelLockDo(invokeID, lockHash [32]byte, user string, rooms uint64) ([]byte, error) {
	return hotelABI.Pack("book_lock_do", invokeID, lockHash, common.HexToAddress(user), u(rooms))
}

func NewCallBookTrainLockDo(invokeID, lockHash [32]byte, user string, outboundTickets, returnTickets uint64) ([]byte, error) {
	return trainABI.Pack("book_lock_do", invokeID, lockHash, common.HexToAddress(user), u(outboundTickets), u(returnTickets))
}

func NewCallBookUnitLockDo(invokeID, lockHash [32]byte, user string, units uint64) ([]byte, error) {
	return hotelABI.Pack("book_lock_do", invokeID, lockHash, common.HexToAddress(user), u(units))
}

func NewCallBookUnlock(invokeID [32]byte, hashKey []byte) ([]byte, error) {
	return hotelABI.Pack("book_unlock", invokeID, hashKey)
}

func NewCallBookUndoUnlock(invokeID [32]byte, hashKey []byte) ([]byte, error) {
	return hotelABI.Pack("book_undo_unlock", invokeID, hashKey)
}

func NewWASMCallBookLockDo(contract string, invokeID [32]byte, lockHash common.Hash, kind string, user string, amountA uint64, amountB uint64) ([]byte, error) {
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "atom_lock_do",
		Args: map[string]any{
			"invoke_id": invokeIDHex(invokeID),
			"lock_hash": lockHash.Hex(),
			"kind":      strings.ToLower(strings.TrimSpace(kind)),
			"user":      user,
			"amount_a":  amountA,
			"amount_b":  amountB,
		},
	})
}

func NewFabricCallBookLockDo(endpoint string, invokeID [32]byte, lockHash common.Hash, kind string, user string, amountA uint64, amountB uint64) ([]byte, error) {
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "atom_lock_do",
		Args: map[string]any{
			"invoke_id": invokeIDHex(invokeID),
			"lock_hash": lockHash.Hex(),
			"kind":      strings.ToLower(strings.TrimSpace(kind)),
			"user":      user,
			"amount_a":  amountA,
			"amount_b":  amountB,
		},
	})
}

func NewWASMCallBookUnlock(contract string, invokeID [32]byte, hashKey []byte, kind string, undo bool) ([]byte, error) {
	message := "atom_unlock"
	if undo {
		message = "atom_undo_unlock"
	}
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  message,
		Args: map[string]any{
			"invoke_id":    invokeIDHex(invokeID),
			"hash_key_hex": "0x" + hex.EncodeToString(hashKey),
			"kind":         strings.ToLower(strings.TrimSpace(kind)),
		},
	})
}

func NewFabricCallBookUnlock(endpoint string, invokeID [32]byte, hashKey []byte, kind string, undo bool) ([]byte, error) {
	message := "atom_unlock"
	if undo {
		message = "atom_undo_unlock"
	}
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  message,
		Args: map[string]any{
			"invoke_id":    invokeIDHex(invokeID),
			"hash_key_hex": "0x" + hex.EncodeToString(hashKey),
			"kind":         strings.ToLower(strings.TrimSpace(kind)),
		},
	})
}

func HashOperationProofFlat(invokeID [32]byte, operationID, chainID uint64, lockDoBlock uint64, lockDoTx [32]byte, unlockBlock uint64, unlockTx [32]byte, undoBlock uint64, undoTx [32]byte, readBlock uint64, readTx [32]byte, dependencyHash [32]byte) ([32]byte, error) {
	args := abi.Arguments{
		{Type: mustSimpleType("bytes32")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("bytes32")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("bytes32")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("bytes32")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("bytes32")},
		{Type: mustSimpleType("bytes32")},
	}
	packed, err := args.Pack(
		invokeID,
		u(operationID),
		u(chainID),
		u(lockDoBlock),
		lockDoTx,
		u(unlockBlock),
		unlockTx,
		u(undoBlock),
		undoTx,
		u(readBlock),
		readTx,
		dependencyHash,
	)
	if err != nil {
		return [32]byte{}, err
	}
	hash := crypto.Keccak256Hash(packed)
	var out [32]byte
	copy(out[:], hash.Bytes())
	return out, nil
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

func invokeIDHex(value [32]byte) string {
	return "0x" + common.Bytes2Hex(value[:])
}

func mustSimpleType(raw string) abi.Type {
	typ, err := abi.NewType(raw, "", nil)
	if err != nil {
		panic(err)
	}
	return typ
}
