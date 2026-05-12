package xsmart

import (
	"encoding/json"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

func TestNewCallBuilders(t *testing.T) {
	addr := common.HexToAddress("0x1111111111111111111111111111111111111111")
	txID := uint64(7)

	if data, err := NewCallRetryUnlock(addr, txID); err != nil || len(data) == 0 {
		t.Fatalf("retryUnlock calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallCompleteExecution(txID); err != nil || len(data) == 0 {
		t.Fatalf("completeExecution calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallRecordUpdateAckAndMaybeComplete(txID, common.HexToHash("0x01"), true, common.Hash{}); err != nil || len(data) == 0 {
		t.Fatalf("recordUpdateAckAndMaybeComplete calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallExecuteIntegratedCallTree(txID, "travel", []byte{0x12, 0x34}, []common.Hash{common.HexToHash("0x1000000000000000000000000000000000000000000000000000000000000001")}, []common.Hash{common.HexToHash("0x2000000000000000000000000000000000000000000000000000000000000002")}); err != nil || len(data) == 0 {
		t.Fatalf("executeIntegratedCallTree calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallExecuteIntegratedLogicWithProofs(txID, "travel", [][]byte{{0x12, 0x34}}, []StateImportProof{{
		ChainId:      common.HexToHash("0x3000000000000000000000000000000000000000000000000000000000000003"),
		ContractId:   common.HexToHash("0x4000000000000000000000000000000000000000000000000000000000000004"),
		SchemaHash:   common.HexToHash("0x5000000000000000000000000000000000000000000000000000000000000005"),
		OpId:         common.HexToHash("0x6000000000000000000000000000000000000000000000000000000000000006"),
		LockEpoch:    1,
		StateVersion: 2,
		Proof:        []byte{0x99},
	}}); err != nil || len(data) == 0 {
		t.Fatalf("executeIntegratedLogicWithProofs calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallTimeoutExecution(txID); err != nil || len(data) == 0 {
		t.Fatalf("timeoutExecution calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallSetUBTLRegistry(addr); err != nil || len(data) == 0 {
		t.Fatalf("setUBTLRegistry calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallReceiveRollbackRequest(txID, []common.Address{addr}); err != nil || len(data) == 0 {
		t.Fatalf("receiveRollbackRequest calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallReceiveLockRequest(txID, []common.Address{addr}, [][]byte{{0x01, 0x02}}, 30); err != nil || len(data) == 0 {
		t.Fatalf("receiveLockRequest calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallReceiveUpdateRequest(txID, []common.Address{addr}, [][]byte{{0x03}}); err != nil || len(data) == 0 {
		t.Fatalf("receiveUpdateRequest calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewEVMCallReceiveUpdateRequestFromRootResult(
		[]common.Address{addr},
		txID,
		dataOrPanic(t, func() ([]byte, error) {
			return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
		}),
		wasmUpdateTemplate{Kind: "hotel", User: addr.Hex(), Num: 1, TotalCost: 100},
	); err != nil || len(data) == 0 {
		t.Fatalf("evm hotel update-from-root payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewEVMCallReceiveUpdateRequestFromRootResult(
		[]common.Address{addr},
		txID,
		dataOrPanic(t, func() ([]byte, error) {
			return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
		}),
		wasmUpdateTemplate{Kind: "train", User: addr.Hex(), Num: 1, TotalCost: 50},
	); err != nil || len(data) == 0 {
		t.Fatalf("evm train update-from-root payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewEVMCallReceiveUpdateRequestFromRootResultBatch(
		[]common.Address{addr, common.HexToAddress("0x2222222222222222222222222222222222222222")},
		txID,
		dataOrPanic(t, func() ([]byte, error) {
			return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
		}),
		[]wasmUpdateTemplate{
			{Kind: "hotel", User: addr.Hex(), Num: 1, TotalCost: 100},
			{Kind: "flight", User: addr.Hex(), Num: 1, TotalCost: 200},
		},
	); err != nil || len(data) == 0 {
		t.Fatalf("evm batch update-from-root payload invalid: len=%d err=%v", len(data), err)
	}

	var key [32]byte
	key[0] = 1
	var ir [32]byte
	ir[0] = 2
	var storage [32]byte
	storage[0] = 3
	if data, err := NewCallRegisterTranslation(3, key, ir, addr, storage); err != nil || len(data) == 0 {
		t.Fatalf("register calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewCallVerifyTranslation(key, ir, []byte{0x55}); err != nil || len(data) == 0 {
		t.Fatalf("verify calldata invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewWASMCallReceiveLockRequest("xbridge_bc2", txID, 2, 30); err != nil || len(data) == 0 {
		t.Fatalf("wasm lock payload invalid: len=%d err=%v", len(data), err)
	}
	updateRaw, err := encodeTrainUpdateData(txID, 95, addr, 2, 200)
	if err != nil {
		t.Fatalf("encode train update failed: %v", err)
	}
	if data, err := NewWASMCallReceiveUpdateRequestFromEVM("xbridge_bc2", updateRaw); err != nil || len(data) == 0 {
		t.Fatalf("wasm update payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewWASMCallReceiveUpdateRequestFromRootResult("xbridge_bc2", txID, dataOrPanic(t, func() ([]byte, error) {
		return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
	}), wasmUpdateTemplate{Kind: "train", User: "5FTestUser", Num: 2, TotalCost: 200}); err != nil || len(data) == 0 {
		t.Fatalf("wasm update-from-root payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewWASMCallReceiveRollbackRequest("xbridge_bc2", txID, false); err != nil || len(data) == 0 {
		t.Fatalf("wasm rollback payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewFabricCallReceiveLockRequest("xbridge_bc3", txID, 2, 30); err != nil || len(data) == 0 {
		t.Fatalf("fabric lock payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewFabricCallReceiveUpdateRequestFromEVM("xbridge_bc3", updateRaw); err != nil || len(data) == 0 {
		t.Fatalf("fabric update payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewFabricCallReceiveUpdateRequestFromRootResult("xbridge_bc3", txID, dataOrPanic(t, func() ([]byte, error) {
		return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
	}), wasmUpdateTemplate{Kind: "hotel", User: "fabric-user", Num: 2, TotalCost: 200}); err != nil || len(data) == 0 {
		t.Fatalf("fabric update-from-root payload invalid: len=%d err=%v", len(data), err)
	}
	if data, err := NewFabricCallReceiveRollbackRequest("xbridge_bc3", txID, true); err != nil || len(data) == 0 {
		t.Fatalf("fabric rollback payload invalid: len=%d err=%v", len(data), err)
	}
	decoded, err := DecodeTrainUpdateData(updateRaw)
	if err != nil {
		t.Fatalf("decode train update failed: %v", err)
	}
	if decoded.CrossChainTxID != txID || decoded.NewRemain != 95 || decoded.Num != 2 || decoded.TotalCost != 200 || decoded.User != addr {
		t.Fatalf("unexpected decoded update payload: %+v", decoded)
	}
	rootRemain, err := DecodeUint256Result(dataOrPanic(t, func() ([]byte, error) {
		return abi.Arguments{{Type: mustType("uint256")}}.Pack(u(91))
	}))
	if err != nil || rootRemain != 91 {
		t.Fatalf("unexpected decoded uint256 root result: %d err=%v", rootRemain, err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(dataOrPanic(t, func() ([]byte, error) { return NewWASMCallReceiveRollbackRequest("xbridge_bc2", txID, true) }), &envelope); err != nil {
		t.Fatalf("rollback payload is not valid json: %v", err)
	}
}

func encodeTrainUpdateData(txID, newRemain uint64, user common.Address, num, totalCost uint64) ([]byte, error) {
	return trainUpdateArgs.Pack(u(txID), u(newRemain), user, u(num), u(totalCost))
}

func dataOrPanic(t *testing.T, fn func() ([]byte, error)) []byte {
	t.Helper()
	data, err := fn()
	if err != nil {
		t.Fatalf("payload generation failed: %v", err)
	}
	return data
}
