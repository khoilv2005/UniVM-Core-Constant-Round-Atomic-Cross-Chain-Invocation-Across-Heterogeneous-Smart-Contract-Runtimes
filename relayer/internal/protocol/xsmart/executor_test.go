package xsmart

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

func testConfig() *config.Config {
	return &config.Config{
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1, VM: "evm"},
			"bc2": {ChainID: 1338, VM: "wasm", AccountEndpoint: "5FTestAccount"},
			"bc3": {ChainID: 3, VM: "fabric", AccountEndpoint: "xbridge_bc3", RPCURL: "http://127.0.0.1:18645"},
		},
		Contracts: config.ContractsConfig{
			XSmart: map[string]config.XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1000000000000000000000000000000000000001",
					UBTLRegistry:      "0x1000000000000000000000000000000000000002",
				},
			},
		},
		XSmart: config.XSmartConfig{
			ServiceID:         "travel",
			WASMLockNum:       2,
			WASMTimeoutBlocks: 30,
		},
		Proof: config.ProofConfig{MaxRetry: 3},
	}
}

func testConfigWithManifest(t *testing.T) *config.Config {
	t.Helper()
	cfg := testConfig()
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "xsmart-manifest.json")
	raw := `{
  "workflow_id": "xsmart-train-wasm",
  "service_id": "travel",
  "root_chain": "bc1",
  "root_chain_id": 1,
  "root_node_index": 0,
  "execute_threshold": 2,
  "update_ack_threshold": 2,
  "call_tree_blob": "0x1234",
  "translation_keys": ["0x1000000000000000000000000000000000000000000000000000000000000001"],
  "peer_ir_hashes": ["0x2000000000000000000000000000000000000000000000000000000000000002"],
  "wasm": {
    "chain": "bc2",
    "contract": "xbridge_bc2",
    "state_contract": "train_booking",
    "lock_num": 2,
    "timeout_blocks": 30,
    "update": {
      "user": "5FTestUser",
      "num": 2,
      "total_cost": 200
    }
  },
  "fabric": {
    "chain": "bc3",
    "contract": "xbridge_bc3",
    "state_contract": "hotel_booking",
    "lock_num": 1,
    "timeout_blocks": 30,
    "update": {
      "user": "fabric-user",
      "num": 1,
      "total_cost": 100
    }
  }
}`
	if err := os.WriteFile(manifestPath, []byte(raw), 0o644); err != nil {
		t.Fatalf("write manifest failed: %v", err)
	}
	cfg.XSmart.Manifest = manifestPath
	return cfg
}

func testConfigWithEVMManifest(t *testing.T) *config.Config {
	t.Helper()
	cfg := &config.Config{
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1, VM: "evm"},
			"bc2": {ChainID: 2, VM: "evm"},
			"bc3": {ChainID: 3, VM: "evm"},
		},
		Contracts: config.ContractsConfig{
			XSmart: map[string]config.XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1000000000000000000000000000000000000001",
				},
			},
		},
		XSmart: config.XSmartConfig{
			ServiceID:         "travel",
			WASMLockNum:       1,
			WASMTimeoutBlocks: 30,
		},
		Proof: config.ProofConfig{MaxRetry: 3},
	}
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "xsmart-evm-manifest.json")
	raw := `{
  "workflow_id": "xsmart-travel-evm",
  "service_id": "travel",
  "root_chain": "bc1",
  "root_chain_id": 1,
  "root_node_index": 0,
  "execute_threshold": 2,
  "update_ack_threshold": 2,
  "call_tree_blob": "0x1234",
  "translation_keys": ["0x1000000000000000000000000000000000000000000000000000000000000001"],
  "peer_ir_hashes": ["0x2000000000000000000000000000000000000000000000000000000000000002"],
  "targets": [
    {
      "vm": "evm",
      "chain": "bc2",
      "bridge_contract": "0x2000000000000000000000000000000000000002",
      "state_contracts": ["0x2200000000000000000000000000000000000002"],
      "lock_num": 1,
      "timeout_blocks": 30,
      "update": {
        "kind": "hotel",
        "user": "0x4000000000000000000000000000000000000004",
        "num": 1,
        "total_cost": 100
      }
    },
    {
      "vm": "evm",
      "chain": "bc3",
      "bridge_contract": "0x3000000000000000000000000000000000000003",
      "state_contracts": ["0x3300000000000000000000000000000000000003"],
      "lock_num": 1,
      "timeout_blocks": 30,
      "update": {
        "kind": "train",
        "user": "0x5000000000000000000000000000000000000005",
        "num": 1,
        "total_cost": 50
      }
    }
  ]
}`
	if err := os.WriteFile(manifestPath, []byte(raw), 0o644); err != nil {
		t.Fatalf("write evm manifest failed: %v", err)
	}
	cfg.XSmart.Manifest = manifestPath
	return cfg
}

func testConfigWithDuplicateChainEVMManifest(t *testing.T) *config.Config {
	t.Helper()
	cfg := &config.Config{
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1, VM: "evm"},
			"bc2": {ChainID: 2, VM: "evm"},
			"bc3": {ChainID: 3, VM: "evm"},
		},
		Contracts: config.ContractsConfig{
			XSmart: map[string]config.XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1000000000000000000000000000000000000001",
				},
			},
		},
		XSmart: config.XSmartConfig{
			ServiceID:         "travel",
			WASMLockNum:       1,
			WASMTimeoutBlocks: 30,
		},
		Proof: config.ProofConfig{MaxRetry: 3},
	}
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "xsmart-evm-dup-manifest.json")
	raw := `{
  "workflow_id": "xsmart-travel-evm-d4",
  "service_id": "travel",
  "root_chain": "bc1",
  "root_chain_id": 1,
  "root_node_index": 0,
  "execute_threshold": 3,
  "update_ack_threshold": 3,
  "call_tree_blob": "0x1234",
  "translation_keys": ["0x1000000000000000000000000000000000000000000000000000000000000001"],
  "peer_ir_hashes": ["0x2000000000000000000000000000000000000000000000000000000000000002"],
  "targets": [
    {
      "vm": "evm",
      "chain": "bc2",
      "bridge_contract": "0x2000000000000000000000000000000000000002",
      "state_contracts": ["0x2200000000000000000000000000000000000002"],
      "lock_num": 1,
      "timeout_blocks": 30,
      "update": {
        "kind": "hotel",
        "user": "0x4000000000000000000000000000000000000004",
        "num": 1,
        "total_cost": 100
      }
    },
    {
      "vm": "evm",
      "chain": "bc3",
      "bridge_contract": "0x3000000000000000000000000000000000000003",
      "state_contracts": ["0x3300000000000000000000000000000000000003"],
      "lock_num": 1,
      "timeout_blocks": 30,
      "update": {
        "kind": "train",
        "user": "0x5000000000000000000000000000000000000005",
        "num": 1,
        "total_cost": 50
      }
    },
    {
      "vm": "evm",
      "chain": "bc2",
      "bridge_contract": "0x2000000000000000000000000000000000000002",
      "state_contracts": ["0x4400000000000000000000000000000000000004"],
      "lock_num": 1,
      "timeout_blocks": 30,
      "update": {
        "kind": "flight",
        "user": "0x4000000000000000000000000000000000000004",
        "num": 1,
        "total_cost": 200
      }
    }
  ]
}`
	if err := os.WriteFile(manifestPath, []byte(raw), 0o644); err != nil {
		t.Fatalf("write duplicate-chain evm manifest failed: %v", err)
	}
	cfg.XSmart.Manifest = manifestPath
	return cfg
}

func TestHandleUnlockFailedBuildsRetryAction(t *testing.T) {
	exec, err := NewExecutor(testConfig(), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	target := common.HexToAddress("0x2000000000000000000000000000000000000002")
	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolXSmart,
		Name:     "UnlockFailed",
		TxID:     "tx-1",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(11),
			"target":         target,
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(actions))
	}
	if actions[0].DestContract != common.HexToAddress(testConfig().Contracts.XSmart["bc1"].XBridgingContract) {
		t.Fatalf("unexpected destination contract %s", actions[0].DestContract.Hex())
	}
	if len(actions[0].Calldata) == 0 {
		t.Fatalf("empty calldata")
	}
}

func TestHandleCrossChainLockRequestedBuildsWASMAction(t *testing.T) {
	exec, err := NewExecutor(testConfig(), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainLockRequested",
		TxID:      "tx-lock",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(9),
			"serviceId":      "travel",
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMWASM {
		t.Fatalf("expected first action wasm dest vm, got %s", actions[0].DestVM)
	}
	if actions[1].DestVM != protocolcommon.DestVMFabric {
		t.Fatalf("expected second action fabric dest vm, got %s", actions[1].DestVM)
	}
	if actions[0].DestEndpoint != "5FTestAccount" || actions[1].DestEndpoint != "xbridge_bc3" {
		t.Fatalf("unexpected endpoints %q / %q", actions[0].DestEndpoint, actions[1].DestEndpoint)
	}
	if len(actions[0].Calldata) == 0 || len(actions[1].Calldata) == 0 {
		t.Fatalf("empty endpoint calldata")
	}
}

func TestHandleCrossChainLockResponseBuildsExecuteAction(t *testing.T) {
	exec, err := NewExecutor(testConfigWithManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc2",
		Name:      "CrossChainLockResponse",
		TxID:      "tx-lock-response",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(21),
			"stateContract":  common.HexToAddress("0x5000000000000000000000000000000000000005"),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 0 {
		t.Fatalf("expected 0 actions after first response, got %d", len(actions))
	}
	actions, err = exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc3",
		Name:      "CrossChainLockResponse",
		TxID:      "tx-lock-response-fabric",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(21),
			"stateContract":  "hotel_booking",
		},
	})
	if err != nil {
		t.Fatalf("Handle second response failed: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 action after second response, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMEVM {
		t.Fatalf("expected evm dest vm, got %s", actions[0].DestVM)
	}
	if actions[0].DestContract != common.HexToAddress(testConfig().Contracts.XSmart["bc1"].XBridgingContract) {
		t.Fatalf("unexpected destination contract %s", actions[0].DestContract.Hex())
	}
	if len(actions[0].Calldata) == 0 {
		t.Fatalf("empty calldata")
	}
}

func TestHandleCrossChainUpdateRequestedBuildsWASMAction(t *testing.T) {
	exec, err := NewExecutor(testConfig(), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	updateData, err := encodeTrainUpdateData(11, 95, common.HexToAddress("0x3000000000000000000000000000000000000003"), 2, 200)
	if err != nil {
		t.Fatalf("encodeTrainUpdateData failed: %v", err)
	}
	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainUpdateRequested",
		TxID:      "tx-update",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(11),
			"updateData":     [][]byte{updateData},
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMWASM || actions[1].DestVM != protocolcommon.DestVMFabric {
		t.Fatalf("expected wasm+fabric actions, got %s and %s", actions[0].DestVM, actions[1].DestVM)
	}
}

func TestHandleCrossChainUpdateAckRecordsAckAndCompletesOnThreshold(t *testing.T) {
	exec, err := NewExecutor(testConfigWithManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc2",
		Name:      "CrossChainUpdateAck",
		TxID:      "tx-update-ack",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(22),
			"stateContract":  common.HexToAddress("0x6000000000000000000000000000000000000006"),
			"success":        true,
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 record-ack action after first ack, got %d", len(actions))
	}
	if actions[0].DestContract != common.HexToAddress(testConfig().Contracts.XSmart["bc1"].XBridgingContract) {
		t.Fatalf("unexpected destination contract %s", actions[0].DestContract.Hex())
	}
	actions, err = exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc3",
		Name:      "CrossChainUpdateAck",
		TxID:      "tx-update-ack-fabric",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(22),
			"stateContract":  "hotel_booking",
			"success":        true,
		},
	})
	if err != nil {
		t.Fatalf("Handle second ack failed: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 record-ack+maybe-complete action after second ack, got %d", len(actions))
	}
	if actions[0].DestContract != common.HexToAddress(testConfig().Contracts.XSmart["bc1"].XBridgingContract) {
		t.Fatalf("unexpected destination contract %s", actions[0].DestContract.Hex())
	}
}

func TestHandleCrossChainLockRequestedBuildsEVMActionsFromManifest(t *testing.T) {
	exec, err := NewExecutor(testConfigWithEVMManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainLockRequested",
		TxID:      "tx-lock-evm",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(31),
			"serviceId":      "travel",
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMEVM || actions[1].DestVM != protocolcommon.DestVMEVM {
		t.Fatalf("expected evm actions, got %s and %s", actions[0].DestVM, actions[1].DestVM)
	}
	if actions[0].DestContract != common.HexToAddress("0x2000000000000000000000000000000000000002") {
		t.Fatalf("unexpected bc2 bridge %s", actions[0].DestContract.Hex())
	}
	if actions[1].DestContract != common.HexToAddress("0x3000000000000000000000000000000000000003") {
		t.Fatalf("unexpected bc3 bridge %s", actions[1].DestContract.Hex())
	}
}

func TestHandleCrossChainUpdateRequestedBuildsFilteredEVMActions(t *testing.T) {
	exec, err := NewExecutor(testConfigWithEVMManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	hotelState := common.HexToAddress("0x2200000000000000000000000000000000000002")
	trainState := common.HexToAddress("0x3300000000000000000000000000000000000003")
	updateHotel, err := encodeTrainUpdateData(41, 99, common.HexToAddress("0x4000000000000000000000000000000000000004"), 1, 100)
	if err != nil {
		t.Fatalf("encode hotel update failed: %v", err)
	}
	updateTrain, err := encodeTrainUpdateData(41, 98, common.HexToAddress("0x5000000000000000000000000000000000000005"), 1, 50)
	if err != nil {
		t.Fatalf("encode train update failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainUpdateRequested",
		TxID:      "tx-update-evm",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(41),
			"stateContracts": []common.Address{hotelState, trainState},
			"updateData":     [][]byte{updateHotel, updateTrain},
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestContract != common.HexToAddress("0x2000000000000000000000000000000000000002") {
		t.Fatalf("unexpected bc2 destination %s", actions[0].DestContract.Hex())
	}
	if actions[1].DestContract != common.HexToAddress("0x3000000000000000000000000000000000000003") {
		t.Fatalf("unexpected bc3 destination %s", actions[1].DestContract.Hex())
	}
}

func TestHandleCallTreeNodeExecutedBuildsWASMUpdateAction(t *testing.T) {
	exec, err := NewExecutor(testConfigWithManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CallTreeNodeExecuted",
		TxID:      "tx-node",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(23),
			"nodeIndex":      new(big.Int).SetUint64(0),
			"result":         encodeUint256Result(t, 97),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMWASM || actions[1].DestVM != protocolcommon.DestVMFabric {
		t.Fatalf("expected wasm+fabric actions, got %s and %s", actions[0].DestVM, actions[1].DestVM)
	}
}

func TestHandleCallTreeNodeExecutedAttachesWASMOutboundProof(t *testing.T) {
	cfg := testConfigWithManifest(t)
	cfg.Proof.Mode = "zk_substrate"
	exec, err := NewExecutor(cfg, nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:    protocolcommon.ProtocolXSmart,
		ChainName:   "bc1",
		Name:        "CallTreeNodeExecuted",
		TxID:        "tx-node-proof",
		BlockNumber: 22,
		TxHash:      common.HexToHash("0x1234"),
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(23),
			"nodeIndex":      new(big.Int).SetUint64(0),
			"result":         encodeUint256Result(t, 97),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) == 0 {
		t.Fatalf("expected actions")
	}
	var wasmAction *protocolcommon.Action
	for idx := range actions {
		if actions[idx].DestVM == protocolcommon.DestVMWASM {
			wasmAction = &actions[idx]
			break
		}
	}
	if wasmAction == nil {
		t.Fatalf("expected wasm action")
	}
	var envelope map[string]any
	if err := json.Unmarshal(wasmAction.Calldata, &envelope); err != nil {
		t.Fatalf("decode wasm calldata failed: %v", err)
	}
	args, ok := envelope["args"].(map[string]any)
	if !ok {
		t.Fatalf("missing args in wasm calldata")
	}
	if proof, ok := args["evm_update_proof"].(string); !ok || proof == "" {
		t.Fatalf("expected outbound EVM update proof in wasm calldata")
	}
}

func TestHandleCallTreeNodeExecutedAttachesBothOutboundProofs(t *testing.T) {
	cfg := testConfigWithManifest(t)
	cfg.Proof.Mode = "zk_both"
	exec, err := NewExecutor(cfg, nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:    protocolcommon.ProtocolXSmart,
		ChainName:   "bc1",
		Name:        "CallTreeNodeExecuted",
		TxID:        "tx-node-both-proof",
		BlockNumber: 23,
		TxHash:      common.HexToHash("0x5678"),
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(24),
			"nodeIndex":      new(big.Int).SetUint64(0),
			"result":         encodeUint256Result(t, 97),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	seen := map[protocolcommon.DestinationVM]bool{}
	for _, action := range actions {
		var envelope map[string]any
		if err := json.Unmarshal(action.Calldata, &envelope); err != nil {
			t.Fatalf("decode calldata for %s failed: %v", action.DestVM, err)
		}
		args, ok := envelope["args"].(map[string]any)
		if !ok {
			t.Fatalf("missing args for %s", action.DestVM)
		}
		if proof, ok := args["evm_update_proof"].(string); !ok || proof == "" {
			t.Fatalf("expected outbound EVM update proof for %s", action.DestVM)
		}
		seen[action.DestVM] = true
	}
	if !seen[protocolcommon.DestVMWASM] || !seen[protocolcommon.DestVMFabric] {
		t.Fatalf("expected wasm and fabric proof actions, got %#v", seen)
	}
}

func TestHandleCallTreeNodeExecutedBuildsEVMUpdateAction(t *testing.T) {
	exec, err := NewExecutor(testConfigWithEVMManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CallTreeNodeExecuted",
		TxID:      "tx-node-evm",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(51),
			"nodeIndex":      new(big.Int).SetUint64(0),
			"result":         encodeUint256Result(t, 97),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMEVM || actions[1].DestVM != protocolcommon.DestVMEVM {
		t.Fatalf("expected evm+evm actions, got %s and %s", actions[0].DestVM, actions[1].DestVM)
	}
}

func TestHandleCrossChainLockRequestedAggregatesDuplicateEVMChainTargets(t *testing.T) {
	exec, err := NewExecutor(testConfigWithDuplicateChainEVMManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainLockRequested",
		TxID:      "tx-lock-d4",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(61),
			"serviceId":      "travel",
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 aggregated lock actions, got %d", len(actions))
	}
	if actions[0].DestChain != "bc2" || actions[1].DestChain != "bc3" {
		t.Fatalf("unexpected destination chains %s/%s", actions[0].DestChain, actions[1].DestChain)
	}
}

func TestHandleCallTreeNodeExecutedAggregatesDuplicateEVMChainTargets(t *testing.T) {
	exec, err := NewExecutor(testConfigWithDuplicateChainEVMManifest(t), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CallTreeNodeExecuted",
		TxID:      "tx-node-d4",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(62),
			"nodeIndex":      new(big.Int).SetUint64(0),
			"result":         encodeUint256Result(t, 97),
		},
	})
	if err != nil {
		t.Fatalf("Handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 aggregated update actions, got %d", len(actions))
	}
	if actions[0].DestChain != "bc2" || actions[1].DestChain != "bc3" {
		t.Fatalf("unexpected destination chains %s/%s", actions[0].DestChain, actions[1].DestChain)
	}
}

func TestHandleRollbackBuildsWASMAction(t *testing.T) {
	exec, err := NewExecutor(testConfig(), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	_, err = exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "CrossChainLockRequested",
		TxID:      "tx-roll",
		Args: map[string]any{
			"crossChainTxId": new(big.Int).SetUint64(15),
			"serviceId":      "travel",
		},
	})
	if err != nil {
		t.Fatalf("seed lock handle failed: %v", err)
	}

	actions, err := exec.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:  protocolcommon.ProtocolXSmart,
		ChainName: "bc1",
		Name:      "IntegratedExecutionFailed",
		TxID:      "tx-roll",
	})
	if err != nil {
		t.Fatalf("rollback handle failed: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].DestVM != protocolcommon.DestVMWASM || actions[1].DestVM != protocolcommon.DestVMFabric {
		t.Fatalf("expected wasm+fabric rollback actions, got %s and %s", actions[0].DestVM, actions[1].DestVM)
	}
}

func TestTranslationEventsUpdateCache(t *testing.T) {
	exec, err := NewExecutor(testConfig(), nil)
	if err != nil {
		t.Fatalf("NewExecutor failed: %v", err)
	}

	key := common.HexToHash("0x3000000000000000000000000000000000000000000000000000000000000003")
	translated := common.HexToAddress("0x4000000000000000000000000000000000000004")
	err = exec.handleTranslationRegistered(protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolXSmart,
		Name:     "TranslationRegistered",
		Args: map[string]any{
			"key":                key,
			"sourceChainId":      new(big.Int).SetUint64(3),
			"sourceContractHash": common.HexToHash("0x5000000000000000000000000000000000000000000000000000000000000005"),
			"irHash":             common.HexToHash("0x6000000000000000000000000000000000000000000000000000000000000006"),
			"translated":         translated,
			"storageMapRoot":     common.HexToHash("0x7000000000000000000000000000000000000000000000000000000000000007"),
		},
	})
	if err != nil {
		t.Fatalf("handleTranslationRegistered failed: %v", err)
	}

	entry, ok := exec.translationForKey(key)
	if !ok {
		t.Fatalf("expected cached translation")
	}
	if entry.SourceChainID != 3 {
		t.Fatalf("unexpected source chain id %d", entry.SourceChainID)
	}
	if entry.Translated != translated {
		t.Fatalf("unexpected translated address %s", entry.Translated.Hex())
	}

	err = exec.handleTranslationVerified(protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolXSmart,
		Name:     "TranslationVerified",
		Args: map[string]any{
			"key": key,
			"ok":  true,
		},
	})
	if err != nil {
		t.Fatalf("handleTranslationVerified failed: %v", err)
	}

	entry, ok = exec.translationForKey(key)
	if !ok {
		t.Fatalf("expected cached translation after verification")
	}
	if !entry.Verified {
		t.Fatalf("expected verified=true")
	}
	if entry.LastVerifyOK == nil || !*entry.LastVerifyOK {
		t.Fatalf("expected LastVerifyOK=true")
	}
}

func encodeUint256Result(t *testing.T, value uint64) []byte {
	t.Helper()
	typ := mustType("uint256")
	data, err := abi.Arguments{{Type: typ}}.Pack(u(value))
	if err != nil {
		t.Fatalf("pack uint256 result failed: %v", err)
	}
	return data
}
