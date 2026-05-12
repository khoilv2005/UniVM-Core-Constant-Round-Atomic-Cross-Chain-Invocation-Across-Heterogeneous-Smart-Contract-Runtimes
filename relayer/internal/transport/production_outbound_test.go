package transport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	evmproof "github.com/xsmart/relayer/internal/proof/evm"
)

func TestWASMProductionOutboundEVMUpdateProof(t *testing.T) {
	client := NewWASMClient("bc2", 1338, "", "", "", "5FTestAccount", "//Alice", 1)
	client.SetEvidenceMode("production-proof", false)
	args := map[string]any{
		"cross_chain_tx_id": uint64(9),
		"new_remain":        uint64(95),
		"user":              "0x0000000000000000000000000000000000000000",
		"num":               uint64(1),
		"total_cost":        uint64(100),
	}
	args["evm_update_proof"] = makeProductionOutboundProof(t, "WASM_SUBSTRATE", "bc2", 1338, "5FTestAccount", args)
	envelope := wasmInvokeEnvelope{Version: 1, Contract: "xbridge_bc2", Message: "receive_update_request", Args: args}

	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err != nil {
		t.Fatalf("valid production proof rejected: %v", err)
	}
	envelope.Args["new_remain"] = uint64(94)
	if err := client.verifyOutboundEVMUpdateProof("5FTestAccount", envelope); err == nil {
		t.Fatalf("tampered production update payload must be rejected")
	}
}

func TestFabricProductionOutboundEVMUpdateProof(t *testing.T) {
	client := NewFabricClient("bc3", 3, "", nil)
	client.SetEvidenceMode("production-proof", false)
	args := map[string]any{
		"cross_chain_tx_id": uint64(77),
		"new_remain":        uint64(1999),
		"user":              "fabric-user",
		"num":               uint64(1),
		"total_cost":        uint64(100),
	}
	args["evm_update_proof"] = makeProductionOutboundProof(t, "FABRIC", "bc3", 3, "xbridge_bc3", args)
	envelope := fabricInvokeRequest{Endpoint: "xbridge_bc3", Message: "receive_update_request", Args: args}

	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err != nil {
		t.Fatalf("valid production proof rejected: %v", err)
	}
	envelope.Args["total_cost"] = uint64(101)
	if err := client.verifyOutboundEVMUpdateProof("xbridge_bc3", envelope); err == nil {
		t.Fatalf("tampered production update payload must be rejected")
	}
}

func makeProductionOutboundProof(t *testing.T, destFamily, destChain string, destChainID uint64, endpoint string, args map[string]any) string {
	t.Helper()
	type keypair struct {
		privateHex string
		publicHex  string
	}
	keys := make([]keypair, 4)
	validators := make([]evmproof.Validator, 4)
	for i := range keys {
		key, err := crypto.GenerateKey()
		if err != nil {
			t.Fatalf("generate validator key: %v", err)
		}
		keys[i] = keypair{
			privateHex: hex.EncodeToString(crypto.FromECDSA(key)),
			publicHex:  hex.EncodeToString(crypto.FromECDSAPub(&key.PublicKey)),
		}
		validators[i] = evmproof.Validator{
			ID:        string(rune('a' + i)),
			PublicKey: keys[i].publicHex,
			Weight:    1,
		}
	}

	updatePayload, err := json.Marshal(argsExcluding(args, "evm_update_proof", "evm_update_verification_mode"))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadHash := sha256.Sum256(updatePayload)
	receiptHash := productionFixedHex("receipt")
	sibling := productionFixedHex("sibling")
	proof := evmproof.OutboundUpdateProof{
		Version:           1,
		Mode:              evmproof.OutboundMode,
		SourceChainID:     "bc1",
		SourceBridge:      "0x0000000000000000000000000000000000000001",
		BlockNumber:       44,
		BlockHash:         productionFixedHex("block"),
		ReceiptsRoot:      productionMerkleRoot(receiptHash, sibling),
		StateRoot:         productionFixedHex("state"),
		ValidatorSetHash:  productionFixedHex("validators"),
		Validators:        validators,
		ReceiptHash:       receiptHash,
		ReceiptProof:      []string{sibling},
		EventName:         "CrossChainUpdateRequested",
		DestFamily:        destFamily,
		DestChain:         destChain,
		DestChainID:       destChainID,
		Endpoint:          endpoint,
		Message:           "receive_update_request",
		OpID:              stringFromArgs(args, "cross_chain_tx_id", "crossChainTxId"),
		StateVersion:      "44",
		UpdatePayloadHash: hex.EncodeToString(payloadHash[:]),
		HashAlgorithm:     "sha256",
	}
	payload, err := evmproof.FinalitySigningPayload(proof)
	if err != nil {
		t.Fatalf("signing payload: %v", err)
	}
	digest := crypto.Keccak256(payload)
	for i := 0; i < 3; i++ {
		key, err := crypto.HexToECDSA(keys[i].privateHex)
		if err != nil {
			t.Fatalf("decode validator key: %v", err)
		}
		sig, err := crypto.Sign(digest, key)
		if err != nil {
			t.Fatalf("sign finality payload: %v", err)
		}
		proof.FinalitySignatures = append(proof.FinalitySignatures, evmproof.FinalitySignature{
			ValidatorID: validators[i].ID,
			Signature:   hex.EncodeToString(sig),
		})
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatalf("marshal proof: %v", err)
	}
	return "0x" + hex.EncodeToString(raw)
}

func productionMerkleRoot(leftHex, rightHex string) string {
	left, _ := hex.DecodeString(leftHex)
	right, _ := hex.DecodeString(rightHex)
	if hex.EncodeToString(left) <= hex.EncodeToString(right) {
		return hex.EncodeToString(crypto.Keccak256(left, right))
	}
	return hex.EncodeToString(crypto.Keccak256(right, left))
}

func productionFixedHex(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}
