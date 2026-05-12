package transport

import (
	"encoding/json"
	"testing"
)

func TestComponentEvidenceAcceptsValidWASMEnvelope(t *testing.T) {
	args := map[string]any{
		"cross_chain_tx_id": uint64(42),
		"num":               uint64(1),
	}
	proof, err := buildComponentEvidence("WASM_SUBSTRATE", "bc2", 1338, "wasm-contract", "receive_lock_request", args, 99, "0xabc")
	if err != nil {
		t.Fatalf("buildComponentEvidence failed: %v", err)
	}
	if len(proof) == 0 {
		t.Fatalf("expected non-empty proof")
	}
	if !verifyComponentEvidence(proof, "WASM_SUBSTRATE", "bc2", 1338, "wasm-contract") {
		t.Fatalf("expected valid component evidence")
	}
}

func TestComponentEvidenceRejectsEmptyProof(t *testing.T) {
	if verifyComponentEvidence(nil, "WASM_SUBSTRATE", "bc2", 1338, "wasm-contract") {
		t.Fatalf("empty proof must be rejected")
	}
}

func TestComponentEvidenceRejectsWrongChainID(t *testing.T) {
	proof, err := buildComponentEvidence("WASM_SUBSTRATE", "bc2", 1338, "wasm-contract", "receive_lock_request", map[string]any{"cross_chain_tx_id": 7}, 10, "0xtx")
	if err != nil {
		t.Fatalf("buildComponentEvidence failed: %v", err)
	}
	if verifyComponentEvidence(proof, "WASM_SUBSTRATE", "bc2", 1339, "wasm-contract") {
		t.Fatalf("wrong chain_id must be rejected")
	}
}

func TestComponentEvidenceRejectsWrongContractID(t *testing.T) {
	proof, err := buildComponentEvidence("FABRIC", "bc3", 3, "HotelBooking", "receive_lock_request", map[string]any{"cross_chain_tx_id": 7}, 10, "fabric-tx")
	if err != nil {
		t.Fatalf("buildComponentEvidence failed: %v", err)
	}
	if verifyComponentEvidence(proof, "FABRIC", "bc3", 3, "OtherChaincode") {
		t.Fatalf("wrong contract_id must be rejected")
	}
}

func TestComponentEvidenceRejectsTamperedPayloadHash(t *testing.T) {
	proof, err := buildComponentEvidence("FABRIC", "bc3", 3, "HotelBooking", "receive_lock_request", map[string]any{"cross_chain_tx_id": 7}, 10, "fabric-tx")
	if err != nil {
		t.Fatalf("buildComponentEvidence failed: %v", err)
	}
	var ev componentEvidence
	if err := json.Unmarshal(proof, &ev); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	ev.StatePayloadHash = "tampered"
	tampered, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if verifyComponentEvidence(tampered, "FABRIC", "bc3", 3, "HotelBooking") {
		t.Fatalf("tampered payload hash must be rejected")
	}
}

func TestComponentEvidenceRejectsReplayOpIDChange(t *testing.T) {
	proof, err := buildComponentEvidence("WASM_SUBSTRATE", "bc2", 1338, "TrainBooking", "receive_lock_request", map[string]any{"cross_chain_tx_id": 7}, 10, "wasm-tx")
	if err != nil {
		t.Fatalf("buildComponentEvidence failed: %v", err)
	}
	var ev componentEvidence
	if err := json.Unmarshal(proof, &ev); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	ev.OpID = "8"
	replayed, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if verifyComponentEvidence(replayed, "WASM_SUBSTRATE", "bc2", 1338, "TrainBooking") {
		t.Fatalf("op_id replay/tamper must be rejected")
	}
}
