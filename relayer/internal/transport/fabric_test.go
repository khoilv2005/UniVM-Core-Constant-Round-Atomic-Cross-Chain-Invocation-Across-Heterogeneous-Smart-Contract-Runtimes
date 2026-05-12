package transport

import (
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestFabricMethodName(t *testing.T) {
	cases := map[string]string{
		"receive_lock_request":     "ReceiveLockRequest",
		"receive_update_request":   "ReceiveUpdateRequest",
		"receive_rollback_request": "ReceiveRollbackRequest",
		"receive_timeout_rollback": "ReceiveTimeoutRollback",
	}
	for input, want := range cases {
		got, err := fabricMethodName(input)
		if err != nil {
			t.Fatalf("fabricMethodName(%q) unexpected error: %v", input, err)
		}
		if got != want {
			t.Fatalf("fabricMethodName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestFabricArgsForUpdateRequest(t *testing.T) {
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(77),
			"new_remain":        uint64(1999),
			"user":              "fabric-user",
			"num":               uint64(1),
			"total_cost":        uint64(100),
		},
	}
	got, err := fabricArgs(envelope)
	if err != nil {
		t.Fatalf("fabricArgs unexpected error: %v", err)
	}
	want := []string{"77", "1999", "fabric-user", "1", "100"}
	if len(got) != len(want) {
		t.Fatalf("fabricArgs len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("fabricArgs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestFabricOutboundEVMUpdateProof(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("zk_fabric", false)

	payload, err := json.Marshal(map[string]any{
		"endpoint": "xbridge_bc3",
		"message":  "receive_update_request",
		"args": map[string]any{
			"cross_chain_tx_id": uint64(77),
			"new_remain":        uint64(1999),
			"user":              "fabric-user",
			"num":               uint64(1),
			"total_cost":        uint64(100),
		},
	})
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	withProof, err := AttachOutboundEVMUpdateProof(payload, "FABRIC", "bc3", 3, "xbridge_bc3", "CrossChainUpdateRequested", "tx-proof", 15, common.HexToHash("0x5678"))
	if err != nil {
		t.Fatalf("AttachOutboundEVMUpdateProof failed: %v", err)
	}
	var envelope fabricInvokeRequest
	if err := json.Unmarshal(withProof, &envelope); err != nil {
		t.Fatalf("proof envelope decode failed: %v", err)
	}
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err != nil {
		t.Fatalf("valid outbound proof rejected: %v", err)
	}

	envelope.Args["total_cost"] = float64(101)
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err == nil {
		t.Fatalf("tampered update payload must be rejected")
	}
}

func TestFabricOutboundEVMUpdateProofRequired(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("zk_fabric", false)
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(77),
			"new_remain":        uint64(1999),
			"user":              "fabric-user",
			"num":               uint64(1),
			"total_cost":        uint64(100),
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err == nil {
		t.Fatalf("missing outbound proof must be rejected")
	}
}

func TestFabricZKBothModeRequiresOutboundProof(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("zk-both", false)
	if client.EvidenceMode != "zk_both" || !client.RequireProof {
		t.Fatalf("expected zk_both mode to require proof, got mode=%q require=%v", client.EvidenceMode, client.RequireProof)
	}
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(77),
			"new_remain":        uint64(1999),
			"user":              "fabric-user",
			"num":               uint64(1),
			"total_cost":        uint64(100),
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err == nil {
		t.Fatalf("zk_both missing outbound proof must be rejected")
	}
}

func TestFabricProductionProofModeRequiresOutboundProof(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("production-proof", false)
	if client.EvidenceMode != "production_proof" || !client.RequireProof {
		t.Fatalf("expected production_proof mode to require proof, got mode=%q require=%v", client.EvidenceMode, client.RequireProof)
	}
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(77),
			"new_remain":        uint64(1999),
			"user":              "fabric-user",
			"num":               uint64(1),
			"total_cost":        uint64(100),
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err == nil || !strings.Contains(err.Error(), "proof is missing") {
		t.Fatalf("expected production proof missing error, got %v", err)
	}
}

func TestFabricProductionProofModeBuildsHostFixtureForInboundBenchmark(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("production-proof", false)
	event := fabricSyntheticEvent{
		Endpoint: "xbridge_bc3",
		Name:     "CrossChainLockResponse",
		Args: map[string]any{
			"crossChainTxId": big.NewInt(88),
		},
	}
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(88),
		},
	}
	err := client.attachAndVerifyComponentEvidence(&event, "xbridge_bc3", envelope, 10, "tx-88")
	if err != nil {
		t.Fatalf("expected host fixture proof to verify, got %v", err)
	}
	if event.Args["verificationMode"] != "production_proof" || event.Args["productionProofSource"] != "host_production_fixture" {
		t.Fatalf("unexpected production metadata: %#v", event.Args)
	}
}

func TestFabricSyntheticGatewayEventLockResponse(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", &FabricGatewayConfig{
		Endpoint:  "peer0.org1.example.com:7051",
		Channel:   "mychannel",
		Chaincode: "xsmart-bc3",
	})
	envelope := fabricInvokeRequest{
		Endpoint: "xbridge_bc3",
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": json.Number("88"),
			"num":               1,
			"timeout_blocks":    30,
		},
	}
	ev, err := client.syntheticGatewayEvent("xbridge_bc3", envelope, nil)
	if err != nil {
		t.Fatalf("syntheticGatewayEvent unexpected error: %v", err)
	}
	if ev.Name != "CrossChainLockResponse" {
		t.Fatalf("unexpected event name %q", ev.Name)
	}
	txID, ok := ev.Args["crossChainTxId"].(*big.Int)
	if !ok || txID == nil || txID.Uint64() != 88 {
		t.Fatalf("unexpected crossChainTxId %#v", ev.Args["crossChainTxId"])
	}
}
