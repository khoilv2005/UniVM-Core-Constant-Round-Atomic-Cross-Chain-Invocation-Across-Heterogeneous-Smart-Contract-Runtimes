package evm

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestVerifyOutboundUpdateProofAcceptsSupermajority(t *testing.T) {
	payload := []byte("update-payload")
	proof := makeOutboundProof(t, payload, []int{0, 1, 2})

	result, err := VerifyOutboundUpdateProof(proof, payload)
	if err != nil {
		t.Fatalf("VerifyOutboundUpdateProof returned error: %v", err)
	}
	if result.SignedWeight != 3 || result.TotalWeight != 4 {
		t.Fatalf("unexpected weights: %+v", result)
	}
	if result.PublicInputHash == "" {
		t.Fatalf("public input hash is empty")
	}
}

func TestVerifyOutboundUpdateProofRejectsInsufficientThreshold(t *testing.T) {
	payload := []byte("update-payload")
	proof := makeOutboundProof(t, payload, []int{0, 1})

	_, err := VerifyOutboundUpdateProof(proof, payload)
	if err == nil || !strings.Contains(err.Error(), "two thirds") {
		t.Fatalf("expected threshold error, got %v", err)
	}
}

func TestVerifyOutboundUpdateProofRejectsPayloadMismatch(t *testing.T) {
	payload := []byte("update-payload")
	proof := makeOutboundProof(t, payload, []int{0, 1, 2})

	_, err := VerifyOutboundUpdateProof(proof, []byte("tampered"))
	if err == nil || !strings.Contains(err.Error(), "update payload hash mismatch") {
		t.Fatalf("expected payload mismatch, got %v", err)
	}
}

func TestVerifyOutboundUpdateProofRejectsBadSignature(t *testing.T) {
	payload := []byte("update-payload")
	proof := makeOutboundProof(t, payload, []int{0, 1, 2})
	proof.FinalitySignatures[1].Signature = proof.FinalitySignatures[0].Signature

	_, err := VerifyOutboundUpdateProof(proof, payload)
	if err == nil || !strings.Contains(err.Error(), "invalid signature") {
		t.Fatalf("expected invalid signature, got %v", err)
	}
}

func TestVerifyOutboundUpdateProofRejectsBadReceiptProof(t *testing.T) {
	payload := []byte("update-payload")
	proof := makeOutboundProof(t, payload, []int{0, 1, 2})
	proof.ReceiptProof = []string{fixedHex("wrong-sibling")}

	_, err := VerifyOutboundUpdateProof(proof, payload)
	if err == nil || !strings.Contains(err.Error(), "receipt proof rejected") {
		t.Fatalf("expected receipt proof error, got %v", err)
	}
}

func makeOutboundProof(t *testing.T, payload []byte, signerIndexes []int) OutboundUpdateProof {
	t.Helper()
	type keypair struct {
		privateHex string
		publicHex  string
	}
	keys := make([]keypair, 4)
	validators := make([]Validator, 4)
	for i := range keys {
		key, err := crypto.GenerateKey()
		if err != nil {
			t.Fatalf("generate validator key: %v", err)
		}
		keys[i] = keypair{
			privateHex: hex.EncodeToString(crypto.FromECDSA(key)),
			publicHex:  hex.EncodeToString(crypto.FromECDSAPub(&key.PublicKey)),
		}
		validators[i] = Validator{
			ID:        string(rune('a' + i)),
			PublicKey: keys[i].publicHex,
			Weight:    1,
		}
	}
	payloadHash := sha256.Sum256(payload)
	receiptHash := fixedHex("receipt")
	sibling := fixedHex("sibling")
	root := merkleRoot(receiptHash, sibling)
	proof := OutboundUpdateProof{
		Version:           1,
		Mode:              OutboundMode,
		SourceChainID:     "bc1",
		SourceBridge:      "0x0000000000000000000000000000000000000001",
		BlockNumber:       44,
		BlockHash:         fixedHex("block"),
		ReceiptsRoot:      root,
		StateRoot:         fixedHex("state"),
		ValidatorSetHash:  fixedHex("validators"),
		Validators:        validators,
		ReceiptHash:       receiptHash,
		ReceiptProof:      []string{sibling},
		EventName:         "CrossChainUpdateRequested",
		DestFamily:        "WASM_SUBSTRATE",
		DestChain:         "bc2",
		DestChainID:       1338,
		Endpoint:          "5FTestAccount",
		Message:           "receive_update_request",
		OpID:              "9",
		StateVersion:      "44",
		UpdatePayloadHash: hex.EncodeToString(payloadHash[:]),
		HashAlgorithm:     "sha256",
	}
	signingPayload, err := FinalitySigningPayload(proof)
	if err != nil {
		t.Fatalf("signing payload: %v", err)
	}
	digest := crypto.Keccak256(signingPayload)
	for _, idx := range signerIndexes {
		key, err := crypto.HexToECDSA(keys[idx].privateHex)
		if err != nil {
			t.Fatalf("decode key: %v", err)
		}
		sig, err := crypto.Sign(digest, key)
		if err != nil {
			t.Fatalf("sign finality payload: %v", err)
		}
		proof.FinalitySignatures = append(proof.FinalitySignatures, FinalitySignature{
			ValidatorID: validators[idx].ID,
			Signature:   hex.EncodeToString(sig),
		})
	}
	return proof
}

func merkleRoot(leftHex, rightHex string) string {
	left, _ := hex.DecodeString(leftHex)
	right, _ := hex.DecodeString(rightHex)
	if bytesLessOrEqual(left, right) {
		return hex.EncodeToString(crypto.Keccak256(left, right))
	}
	return hex.EncodeToString(crypto.Keccak256(right, left))
}

func fixedHex(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}
