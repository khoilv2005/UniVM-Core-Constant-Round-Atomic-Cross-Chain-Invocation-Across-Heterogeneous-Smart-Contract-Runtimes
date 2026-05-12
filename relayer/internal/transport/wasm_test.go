package transport

import (
	"context"
	"encoding/json"
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

func TestWASMPrototypeEnvelopeGeneratesSyntheticLockResponse(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	sink := make(chan NormalizedEvent, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Subscribe(ctx, SubscribeFilter{ChainName: "bc2", ChainID: 1338}, sink); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	payload, err := json.Marshal(map[string]any{
		"version":  1,
		"contract": "xbridge_bc2",
		"message":  "receive_lock_request",
		"args": map[string]any{
			"cross_chain_tx_id": 7,
			"num":               1,
			"timeout_blocks":    30,
		},
	})
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	txHash, err := client.SendEndpoint(context.Background(), "5FTestAccount", payload)
	if err != nil {
		t.Fatalf("SendEndpoint failed: %v", err)
	}
	receipt, err := client.WaitReceipt(context.Background(), txHash)
	if err != nil {
		t.Fatalf("WaitReceipt failed: %v", err)
	}
	if !receipt.Success {
		t.Fatalf("expected synthetic success receipt")
	}

	select {
	case ev := <-sink:
		if ev.Name != "CrossChainLockResponse" {
			t.Fatalf("unexpected event name %q", ev.Name)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for synthetic event")
	}
}

func TestWASMPrototypeEnvelopeGeneratesSyntheticUpdateAck(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	sink := make(chan NormalizedEvent, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Subscribe(ctx, SubscribeFilter{ChainName: "bc2", ChainID: 1338}, sink); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	payload, err := json.Marshal(map[string]any{
		"version":  1,
		"contract": "xbridge_bc2",
		"message":  "receive_update_request",
		"args": map[string]any{
			"cross_chain_tx_id": 9,
			"new_remain":        95,
			"user":              "0x0000000000000000000000000000000000000000",
			"num":               1,
			"total_cost":        100,
		},
	})
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	txHash, err := client.SendEndpoint(context.Background(), "5FTestAccount", payload)
	if err != nil {
		t.Fatalf("SendEndpoint failed: %v", err)
	}
	if _, err := client.WaitReceipt(context.Background(), txHash); err != nil {
		t.Fatalf("WaitReceipt failed: %v", err)
	}

	select {
	case ev := <-sink:
		if ev.Name != "CrossChainUpdateAck" {
			t.Fatalf("unexpected event name %q", ev.Name)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for synthetic event")
	}
}

func TestWASMOutboundEVMUpdateProof(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("zk_substrate", false)

	payload, err := json.Marshal(map[string]any{
		"version":  1,
		"contract": "xbridge_bc2",
		"message":  "receive_update_request",
		"args": map[string]any{
			"cross_chain_tx_id": 9,
			"new_remain":        95,
			"user":              "0x0000000000000000000000000000000000000000",
			"num":               1,
			"total_cost":        100,
		},
	})
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	withProof, err := AttachOutboundEVMUpdateProof(payload, "WASM_SUBSTRATE", "bc2", 1338, "5FTestAccount", "CrossChainUpdateRequested", "tx-proof", 12, common.HexToHash("0x1234"))
	if err != nil {
		t.Fatalf("AttachOutboundEVMUpdateProof failed: %v", err)
	}
	var envelope wasmInvokeEnvelope
	if err := json.Unmarshal(withProof, &envelope); err != nil {
		t.Fatalf("proof envelope decode failed: %v", err)
	}
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err != nil {
		t.Fatalf("valid outbound proof rejected: %v", err)
	}

	envelope.Args["new_remain"] = float64(94)
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err == nil {
		t.Fatalf("tampered update payload must be rejected")
	}
}

func TestWASMOutboundEVMUpdateProofRequired(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("zk_substrate", false)
	envelope := wasmInvokeEnvelope{
		Version:  1,
		Contract: "xbridge_bc2",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": 9,
			"new_remain":        95,
			"user":              "0x0000000000000000000000000000000000000000",
			"num":               1,
			"total_cost":        100,
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err == nil {
		t.Fatalf("missing outbound proof must be rejected")
	}
}

func TestWASMZKBothModeRequiresOutboundProof(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("zk-both", false)
	if client.EvidenceMode != "zk_both" || !client.RequireProof {
		t.Fatalf("expected zk_both mode to require proof, got mode=%q require=%v", client.EvidenceMode, client.RequireProof)
	}
	envelope := wasmInvokeEnvelope{
		Version:  1,
		Contract: "xbridge_bc2",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": 9,
			"new_remain":        95,
			"user":              "0x0000000000000000000000000000000000000000",
			"num":               1,
			"total_cost":        100,
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err == nil {
		t.Fatalf("zk_both missing outbound proof must be rejected")
	}
}

func TestWASMProductionProofModeRequiresOutboundProof(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("production-proof", false)
	if client.EvidenceMode != "production_proof" || !client.RequireProof {
		t.Fatalf("expected production_proof mode to require proof, got mode=%q require=%v", client.EvidenceMode, client.RequireProof)
	}
	envelope := wasmInvokeEnvelope{
		Version:  1,
		Contract: "xbridge_bc2",
		Message:  "receive_update_request",
		Args: map[string]any{
			"cross_chain_tx_id": 9,
			"new_remain":        95,
			"user":              "0x0000000000000000000000000000000000000000",
			"num":               1,
			"total_cost":        100,
		},
	}
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err == nil || !strings.Contains(err.Error(), "proof is missing") {
		t.Fatalf("expected production proof missing error, got %v", err)
	}
}

func TestWASMDockerCargoArgsUsesExplicitDockerNetwork(t *testing.T) {
	t.Setenv("XSMART_BC2_DOCKER_NETWORK", "container:xsmart-bc2-rpc-proxy")
	t.Setenv("XSMART_BC2_NODE_CONTAINER", "")

	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	got := client.dockerCargoArgs("D:/tmp/bc2", []string{"cargo", "contract", "call"})
	wantPrefix := []string{
		"run", "--rm",
		"--network", "container:xsmart-bc2-rpc-proxy",
		"-v", "D:/tmp/bc2:/work",
		"-w", "/work",
		"xsmart-ink-builder:local",
	}
	if !reflect.DeepEqual(got[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("unexpected docker args prefix:\nwant=%v\ngot=%v", wantPrefix, got)
	}
}

func TestWASMDockerCargoArgsSkipsStoppedDefaultContainerNetwork(t *testing.T) {
	t.Setenv("XSMART_BC2_DOCKER_NETWORK", "")
	t.Setenv("XSMART_BC2_NODE_CONTAINER", "xsmart-bc2-container-that-should-not-exist")

	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	got := client.dockerCargoArgs("D:/tmp/bc2", []string{"cargo", "contract", "call"})
	wantPrefix := []string{
		"run", "--rm",
		"-v", "D:/tmp/bc2:/work",
		"-w", "/work",
		"xsmart-ink-builder:local",
	}
	if !reflect.DeepEqual(got[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("unexpected docker args prefix:\nwant=%v\ngot=%v", wantPrefix, got)
	}
}

func TestWASMCargoContractURLUsesConfiguredDockerURL(t *testing.T) {
	t.Setenv("XSMART_WASM_RUNNER", "docker")
	t.Setenv("XSMART_BC2_DEPLOY_MODE", "local")
	t.Setenv("XSMART_BC2_DOCKER_WS_URL", "ws://127.0.0.1:9944")
	t.Setenv("XSMART_BC2_DOCKER_NETWORK", "")
	t.Setenv("XSMART_BC2_NODE_CONTAINER", "")

	client := NewWASMClient("bc2", 1338, "http://127.0.0.1:18545", "ws://127.0.0.1:18545", "", "5FTestAccount", "//Alice", 1)
	if got := client.cargoContractURL(); got != "ws://127.0.0.1:9944" {
		t.Fatalf("unexpected docker cargo ws url %q", got)
	}
}

func TestWASMCargoContractURLKeepsRemoteWSInProdMode(t *testing.T) {
	t.Setenv("XSMART_WASM_RUNNER", "docker")
	t.Setenv("XSMART_BC2_DEPLOY_MODE", "prod")
	t.Setenv("XSMART_BC2_DOCKER_WS_URL", "")
	t.Setenv("XSMART_BC2_DOCKER_NETWORK", "")
	t.Setenv("XSMART_BC2_NODE_CONTAINER", "")
	t.Setenv("XSMART_BC2_WS_URL", "ws://170.64.194.4:18546")

	client := NewWASMClient("bc2", 1338, "http://170.64.194.4:18545", "ws://170.64.194.4:18546", "", "5FTestAccount", "//Alice", 1)
	if got := client.cargoContractURL(); got != "ws://170.64.194.4:18546" {
		t.Fatalf("unexpected prod cargo ws url %q", got)
	}
}

func TestWASMCargoContractURLKeepsLoopbackWSInProdMode(t *testing.T) {
	t.Setenv("XSMART_WASM_RUNNER", "docker")
	t.Setenv("XSMART_BC2_DEPLOY_MODE", "prod")
	t.Setenv("XSMART_BC2_DOCKER_WS_URL", "ws://127.0.0.1:9944")

	client := NewWASMClient("bc2", 1338, "http://209.38.21.129:18545", "ws://209.38.21.129:18545", "", "5FTestAccount", "//Alice", 1)
	if got := client.cargoContractURL(); got != "ws://127.0.0.1:9944" {
		t.Fatalf("unexpected loopback cargo ws url %q", got)
	}
}

func TestParseWASMExecutionMetaFromJSON(t *testing.T) {
	raw := []byte(`{"extrinsicHash":"0x1111111111111111111111111111111111111111111111111111111111111111","blockNumber":"0x2a"}`)
	txRef, block := parseWASMExecutionMeta(raw)
	if txRef != "0x1111111111111111111111111111111111111111111111111111111111111111" {
		t.Fatalf("unexpected tx ref %q", txRef)
	}
	if block != 42 {
		t.Fatalf("unexpected block %d", block)
	}
}

func TestParseWASMExecutionMetaFromTextFallback(t *testing.T) {
	raw := []byte("submitted extrinsic 0x2222222222222222222222222222222222222222222222222222222222222222 at block 19")
	txRef, block := parseWASMExecutionMeta(raw)
	if txRef != "0x2222222222222222222222222222222222222222222222222222222222222222" {
		t.Fatalf("unexpected tx ref %q", txRef)
	}
	if block != 19 {
		t.Fatalf("unexpected block %d", block)
	}
}

func TestTxHashFromRefUsesHexDirectlyAndHashesOpaqueRefs(t *testing.T) {
	hexRef := "0x3333333333333333333333333333333333333333333333333333333333333333"
	hash, ok := txHashFromRef(hexRef)
	if !ok || hash.Hex() != strings.ToLower(hexRef) {
		t.Fatalf("expected direct hash conversion, got ok=%v hash=%s", ok, hash.Hex())
	}

	opaqueHash, ok := txHashFromRef("bc2#block=7#idx=1")
	if !ok {
		t.Fatalf("expected opaque ref to hash")
	}
	if opaqueHash == hash {
		t.Fatalf("expected distinct opaque hash surrogate")
	}
}

func TestSyntheticEventFromEnvelopeLockFallback(t *testing.T) {
	event, err := syntheticEventFromEnvelope("5FTestAccount", wasmInvokeEnvelope{
		Version:  1,
		Contract: "xbridge_bc2",
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(11),
			"num":               uint64(1),
			"timeout_blocks":    uint64(30),
		},
	})
	if err != nil {
		t.Fatalf("syntheticEventFromEnvelope failed: %v", err)
	}
	if event.Name != "CrossChainLockResponse" {
		t.Fatalf("unexpected event name %q", event.Name)
	}
	txID, ok := event.Args["crossChainTxId"].(*big.Int)
	if !ok || txID == nil || txID.Uint64() != 11 {
		t.Fatalf("unexpected tx id payload: %#v", event.Args["crossChainTxId"])
	}
	if lockedState, ok := event.Args["lockedState"].([]byte); !ok || len(lockedState) != 0 {
		t.Fatalf("expected empty lockedState fallback, got %#v", event.Args["lockedState"])
	}
}

func TestWASMProductionProofModeBuildsHostFixtureForInboundBenchmark(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("production-proof", false)
	event, err := client.eventFromEnvelope("5FTestAccount", wasmInvokeEnvelope{
		Version:  1,
		Contract: "xbridge_bc2",
		Message:  "receive_lock_request",
		Args: map[string]any{
			"cross_chain_tx_id": uint64(11),
			"num":               uint64(1),
			"timeout_blocks":    uint64(30),
		},
	})
	if err != nil {
		t.Fatalf("expected host fixture proof to verify, got %v", err)
	}
	if event.Args["verificationMode"] != "production_proof" || event.Args["productionProofSource"] != "host_production_fixture" {
		t.Fatalf("unexpected production metadata: %#v", event.Args)
	}
}
