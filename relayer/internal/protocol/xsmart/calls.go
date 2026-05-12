package xsmart

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

var bridgeABI = mustABI(`[
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"bytes[]","name":"lockArgs","type":"bytes[]"},{"internalType":"uint256","name":"timeoutBlocks","type":"uint256"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveLockRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"bytes[]","name":"updateData","type":"bytes[]"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveUpdateRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveRollbackRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"string","name":"serviceId","type":"string"},{"internalType":"bytes[]","name":"lockedStates","type":"bytes[]"},{"components":[{"internalType":"bytes32","name":"chainId","type":"bytes32"},{"internalType":"bytes32","name":"contractId","type":"bytes32"},{"internalType":"bytes32","name":"schemaHash","type":"bytes32"},{"internalType":"bytes32","name":"opId","type":"bytes32"},{"internalType":"uint64","name":"lockEpoch","type":"uint64"},{"internalType":"uint64","name":"stateVersion","type":"uint64"},{"internalType":"bytes","name":"proof","type":"bytes"}],"internalType":"struct XBridgingContract.StateImportProof[]","name":"importProofs","type":"tuple[]"}],"name":"executeIntegratedLogicWithProofs","outputs":[{"internalType":"address[]","name":"destContracts","type":"address[]"},{"internalType":"bytes[]","name":"updateData","type":"bytes[]"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"string","name":"serviceId","type":"string"},{"internalType":"bytes","name":"callTreeBlob","type":"bytes"},{"internalType":"bytes32[]","name":"translationKeys","type":"bytes32[]"},{"internalType":"bytes32[]","name":"peerIrHashes","type":"bytes32[]"}],"name":"executeIntegratedCallTree","outputs":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"rootResult","type":"bytes"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"bytes32","name":"ackKey","type":"bytes32"},{"internalType":"bool","name":"success","type":"bool"},{"internalType":"uint256","name":"invokedChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"recordUpdateAckAndMaybeComplete","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"completeExecution","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"timeoutExecution","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"_ubtlRegistry","type":"address"}],"name":"setUBTLRegistry","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"target","type":"address"},{"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"retryUnlock","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

var registryABI = mustABI(`[
  {"inputs":[{"internalType":"uint256","name":"sourceChainId","type":"uint256"},{"internalType":"bytes32","name":"sourceContractHash","type":"bytes32"},{"internalType":"bytes32","name":"irHash","type":"bytes32"},{"internalType":"address","name":"translated","type":"address"},{"internalType":"bytes32","name":"storageMapRoot","type":"bytes32"}],"name":"register","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"key","type":"bytes32"},{"internalType":"bytes32","name":"peerIrHash","type":"bytes32"},{"internalType":"bytes","name":"merkleProof","type":"bytes"}],"name":"verify","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
]`)

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

type wasmTrainUpdate struct {
	CrossChainTxID uint64
	NewRemain      uint64
	User           common.Address
	Num            uint64
	TotalCost      uint64
}

type wasmUpdateTemplate struct {
	Kind      string
	User      string
	Num       uint64
	TotalCost uint64
}

type StateImportProof struct {
	ChainId      [32]byte
	ContractId   [32]byte
	SchemaHash   [32]byte
	OpId         [32]byte
	LockEpoch    uint64
	StateVersion uint64
	Proof        []byte
}

var hotelUpdateArgs = abi.Arguments{
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
	{Type: mustType("address")},
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
}

var trainUpdateArgs = abi.Arguments{
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
	{Type: mustType("address")},
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
}

var evmTrainUpdateArgs = abi.Arguments{
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
	{Type: mustType("address")},
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
	{Type: mustType("uint256")},
}

func NewCallRetryUnlock(target common.Address, txID uint64) ([]byte, error) {
	return bridgeABI.Pack("retryUnlock", target, u(txID))
}

func NewCallReceiveLockRequest(txID uint64, stateContracts []common.Address, lockArgs [][]byte, timeoutBlocks uint64) ([]byte, error) {
	return bridgeABI.Pack("receiveLockRequest", u(txID), stateContracts, lockArgs, u(timeoutBlocks), u(0), [][32]byte{}, [32]byte{})
}

func NewCallReceiveUpdateRequest(txID uint64, stateContracts []common.Address, updateData [][]byte) ([]byte, error) {
	return bridgeABI.Pack("receiveUpdateRequest", u(txID), stateContracts, updateData, u(0), [][32]byte{}, [32]byte{})
}

func NewCallReceiveRollbackRequest(txID uint64, stateContracts []common.Address) ([]byte, error) {
	return bridgeABI.Pack("receiveRollbackRequest", u(txID), stateContracts, u(0), [][32]byte{}, [32]byte{})
}

func NewEVMCallReceiveUpdateRequestFromRootResult(stateContracts []common.Address, txID uint64, rootResult []byte, template wasmUpdateTemplate) ([]byte, error) {
	return NewEVMCallReceiveUpdateRequestFromRootResultBatch(stateContracts, txID, rootResult, []wasmUpdateTemplate{template})
}

func NewEVMCallReceiveUpdateRequestFromRootResultBatch(stateContracts []common.Address, txID uint64, rootResult []byte, templates []wasmUpdateTemplate) ([]byte, error) {
	newRemain, err := DecodeUint256Result(rootResult)
	if err != nil {
		return nil, err
	}
	if len(stateContracts) == 0 {
		return nil, fmt.Errorf("empty evm state contracts for root-result update")
	}
	if len(stateContracts) != len(templates) {
		return nil, fmt.Errorf("stateContracts/templates length mismatch: %d/%d", len(stateContracts), len(templates))
	}

	updatePayloads := make([][]byte, 0, len(templates))
	for _, template := range templates {
		if !common.IsHexAddress(template.User) {
			return nil, fmt.Errorf("evm update template user is not a hex address: %q", template.User)
		}
		user := common.HexToAddress(template.User)
		updateKind := strings.ToLower(strings.TrimSpace(template.Kind))
		if updateKind == "" {
			updateKind = "train"
		}

		var payload []byte
		switch updateKind {
		case "hotel":
			payload, err = hotelUpdateArgs.Pack(u(txID), u(newRemain), user, u(template.Num), u(template.TotalCost))
		case "flight":
			payload, err = hotelUpdateArgs.Pack(u(txID), u(newRemain), user, u(template.Num), u(template.TotalCost))
		case "taxi":
			payload, err = hotelUpdateArgs.Pack(u(txID), u(newRemain), user, u(template.Num), u(template.TotalCost))
		case "train":
			payload, err = evmTrainUpdateArgs.Pack(u(txID), u(newRemain), user, u(template.Num), u(0), u(template.TotalCost))
		default:
			return nil, fmt.Errorf("unsupported evm root-result update kind %q", template.Kind)
		}
		if err != nil {
			return nil, err
		}
		updatePayloads = append(updatePayloads, payload)
	}
	return NewCallReceiveUpdateRequest(txID, stateContracts, updatePayloads)
}

func NewCallCompleteExecution(txID uint64) ([]byte, error) {
	return bridgeABI.Pack("completeExecution", u(txID))
}

func NewCallRecordUpdateAckAndMaybeComplete(txID uint64, ackKey common.Hash, success bool, receiptHash common.Hash) ([]byte, error) {
	return bridgeABI.Pack("recordUpdateAckAndMaybeComplete", u(txID), ackKey, success, u(0), [][32]byte{}, receiptHash)
}

func NewCallExecuteIntegratedCallTree(txID uint64, serviceID string, callTreeBlob []byte, translationKeys []common.Hash, peerIRHashes []common.Hash) ([]byte, error) {
	return bridgeABI.Pack("executeIntegratedCallTree", u(txID), serviceID, callTreeBlob, translationKeys, peerIRHashes)
}

func NewCallExecuteIntegratedLogicWithProofs(txID uint64, serviceID string, lockedStates [][]byte, importProofs []StateImportProof) ([]byte, error) {
	return bridgeABI.Pack("executeIntegratedLogicWithProofs", u(txID), serviceID, lockedStates, importProofs)
}

func NewCallTimeoutExecution(txID uint64) ([]byte, error) {
	return bridgeABI.Pack("timeoutExecution", u(txID))
}

func NewCallSetUBTLRegistry(addr common.Address) ([]byte, error) {
	return bridgeABI.Pack("setUBTLRegistry", addr)
}

func NewCallRegisterTranslation(sourceChainID uint64, sourceContractHash [32]byte, irHash [32]byte, translated common.Address, storageMapRoot [32]byte) ([]byte, error) {
	return registryABI.Pack("register", u(sourceChainID), sourceContractHash, irHash, translated, storageMapRoot)
}

func NewCallVerifyTranslation(key [32]byte, peerIRHash [32]byte, merkleProof []byte) ([]byte, error) {
	return registryABI.Pack("verify", key, peerIRHash, merkleProof)
}

func NewWASMCallReceiveLockRequest(contract string, txID uint64, num uint64, timeoutBlocks uint64) ([]byte, error) {
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": txID,
			"num":               num,
			"timeout_blocks":    timeoutBlocks,
		},
	})
}

func NewWASMCallReceiveRollbackRequest(contract string, txID uint64, timeout bool) ([]byte, error) {
	message := "receive_rollback_request"
	if timeout {
		message = "receive_timeout_rollback"
	}
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  message,
		Args: map[string]any{
			"cross_chain_tx_id": txID,
		},
	})
}

func NewWASMCallReceiveUpdateRequestFromEVM(contract string, updateData []byte) ([]byte, error) {
	payload, err := DecodeTrainUpdateData(updateData)
	if err != nil {
		return nil, err
	}
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": payload.CrossChainTxID,
			"new_remain":        payload.NewRemain,
			"user":              payload.User.Hex(),
			"num":               payload.Num,
			"total_cost":        payload.TotalCost,
		},
	})
}

func NewWASMCallReceiveUpdateRequestFromRootResult(contract string, txID uint64, rootResult []byte, template wasmUpdateTemplate) ([]byte, error) {
	newRemain, err := DecodeUint256Result(rootResult)
	if err != nil {
		return nil, err
	}
	return json.Marshal(wasmInvokeEnvelope{
		Version:  1,
		Contract: contract,
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": txID,
			"new_remain":        newRemain,
			"user":              template.User,
			"num":               template.Num,
			"total_cost":        template.TotalCost,
		},
	})
}

func NewFabricCallReceiveLockRequest(endpoint string, txID uint64, num uint64, timeoutBlocks uint64) ([]byte, error) {
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": txID,
			"num":               num,
			"timeout_blocks":    timeoutBlocks,
		},
	})
}

func NewFabricCallReceiveRollbackRequest(endpoint string, txID uint64, timeout bool) ([]byte, error) {
	message := "receive_rollback_request"
	if timeout {
		message = "receive_timeout_rollback"
	}
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  message,
		Args: map[string]any{
			"cross_chain_tx_id": txID,
		},
	})
}

func NewFabricCallReceiveUpdateRequestFromEVM(endpoint string, updateData []byte) ([]byte, error) {
	payload, err := DecodeTrainUpdateData(updateData)
	if err != nil {
		return nil, err
	}
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": payload.CrossChainTxID,
			"new_remain":        payload.NewRemain,
			"user":              payload.User.Hex(),
			"num":               payload.Num,
			"total_cost":        payload.TotalCost,
		},
	})
}

func NewFabricCallReceiveUpdateRequestFromRootResult(endpoint string, txID uint64, rootResult []byte, template wasmUpdateTemplate) ([]byte, error) {
	newRemain, err := DecodeUint256Result(rootResult)
	if err != nil {
		return nil, err
	}
	return json.Marshal(fabricInvokeEnvelope{
		Version:  1,
		Endpoint: endpoint,
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": txID,
			"new_remain":        newRemain,
			"user":              template.User,
			"num":               template.Num,
			"total_cost":        template.TotalCost,
		},
	})
}

func DecodeTrainUpdateData(updateData []byte) (wasmTrainUpdate, error) {
	values, err := trainUpdateArgs.Unpack(updateData)
	if err != nil {
		return wasmTrainUpdate{}, err
	}
	if len(values) != 5 {
		return wasmTrainUpdate{}, fmt.Errorf("unexpected update tuple len %d", len(values))
	}
	txID, ok := values[0].(*big.Int)
	if !ok || txID == nil {
		return wasmTrainUpdate{}, fmt.Errorf("update tx id type %T", values[0])
	}
	newRemain, ok := values[1].(*big.Int)
	if !ok || newRemain == nil {
		return wasmTrainUpdate{}, fmt.Errorf("update new_remain type %T", values[1])
	}
	user, ok := values[2].(common.Address)
	if !ok {
		return wasmTrainUpdate{}, fmt.Errorf("update user type %T", values[2])
	}
	num, ok := values[3].(*big.Int)
	if !ok || num == nil {
		return wasmTrainUpdate{}, fmt.Errorf("update num type %T", values[3])
	}
	totalCost, ok := values[4].(*big.Int)
	if !ok || totalCost == nil {
		return wasmTrainUpdate{}, fmt.Errorf("update total_cost type %T", values[4])
	}
	return wasmTrainUpdate{
		CrossChainTxID: txID.Uint64(),
		NewRemain:      newRemain.Uint64(),
		User:           user,
		Num:            num.Uint64(),
		TotalCost:      totalCost.Uint64(),
	}, nil
}

func DecodeUint256Result(raw []byte) (uint64, error) {
	values, err := abi.Arguments{{Type: mustType("uint256")}}.Unpack(raw)
	if err != nil {
		return 0, err
	}
	if len(values) != 1 {
		return 0, fmt.Errorf("unexpected uint256 result len %d", len(values))
	}
	value, ok := values[0].(*big.Int)
	if !ok || value == nil {
		return 0, fmt.Errorf("unexpected uint256 result type %T", values[0])
	}
	return value.Uint64(), nil
}

func encodeStandardLockArgs(txID, lockNum, timeoutBlocks uint64) []byte {
	data, err := abi.Arguments{
		{Type: mustType("uint256")},
		{Type: mustType("uint256")},
		{Type: mustType("uint256")},
	}.Pack(u(txID), u(lockNum), u(timeoutBlocks))
	if err != nil {
		panic(err)
	}
	return data
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

func mustType(kind string) abi.Type {
	typ, err := abi.NewType(kind, "", nil)
	if err != nil {
		panic(err)
	}
	return typ
}
