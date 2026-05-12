package substrate

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestVerifyFinalityProofAcceptsSupermajority(t *testing.T) {
	state := []byte("vassp-state")
	proof := makeFinalityProof(t, state, []int{0, 1, 2})

	result, err := VerifyFinalityProof(proof, state)
	if err != nil {
		t.Fatalf("VerifyFinalityProof returned error: %v", err)
	}
	if result.SignedWeight != 3 || result.TotalWeight != 4 {
		t.Fatalf("unexpected weights: %+v", result)
	}
	if result.PublicInputHash == "" {
		t.Fatalf("public input hash is empty")
	}
}

func TestVerifyFinalityProofRejectsInsufficientThreshold(t *testing.T) {
	state := []byte("vassp-state")
	proof := makeFinalityProof(t, state, []int{0, 1})

	_, err := VerifyFinalityProof(proof, state)
	if err == nil || !strings.Contains(err.Error(), "two thirds") {
		t.Fatalf("expected threshold error, got %v", err)
	}
}

func TestVerifyFinalityProofRejectsBadSignature(t *testing.T) {
	state := []byte("vassp-state")
	proof := makeFinalityProof(t, state, []int{0, 1, 2})
	proof.Signatures[1].Signature = proof.Signatures[0].Signature

	_, err := VerifyFinalityProof(proof, state)
	if err == nil || !strings.Contains(err.Error(), "invalid signature") {
		t.Fatalf("expected invalid signature error, got %v", err)
	}
}

func TestVerifyFinalityProofRejectsPayloadHashMismatch(t *testing.T) {
	state := []byte("vassp-state")
	proof := makeFinalityProof(t, state, []int{0, 1, 2})

	_, err := VerifyFinalityProof(proof, []byte("tampered-state"))
	if err == nil || !strings.Contains(err.Error(), "state payload hash mismatch") {
		t.Fatalf("expected payload hash mismatch, got %v", err)
	}
}

func makeFinalityProof(t *testing.T, state []byte, signerIndexes []int) FinalityProof {
	t.Helper()

	type keypair struct {
		public  ed25519.PublicKey
		private ed25519.PrivateKey
	}

	keys := make([]keypair, 4)
	authorities := make([]Authority, 4)
	for i := range keys {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("generate key %d: %v", i, err)
		}
		keys[i] = keypair{public: pub, private: priv}
		authorities[i] = Authority{
			ID:        string(rune('a' + i)),
			PublicKey: hex.EncodeToString(pub),
			Weight:    1,
		}
	}

	stateHash := sha256.Sum256(state)
	proof := FinalityProof{
		SetID:                7,
		Round:                11,
		FinalizedBlockNumber: 42,
		FinalizedBlockHash:   fixedHex("block", 32),
		StateRoot:            fixedHex("state-root", 32),
		StorageProofHash:     fixedHex("storage-proof", 32),
		Authorities:          authorities,
		Binding: MetadataBinding{
			ChainID:          "substrate-testnet",
			ContractID:       "train-booking",
			SchemaHash:       fixedHex("schema", 32),
			OpID:             "op-42",
			LockEpoch:        9,
			StateVersion:     42,
			StatePayloadHash: hex.EncodeToString(stateHash[:]),
			HashAlgorithm:    "sha256",
		},
	}

	payload, err := SigningPayload(proof)
	if err != nil {
		t.Fatalf("signing payload: %v", err)
	}
	for _, idx := range signerIndexes {
		proof.Signatures = append(proof.Signatures, Signature{
			AuthorityID: authorities[idx].ID,
			Signature:   hex.EncodeToString(ed25519.Sign(keys[idx].private, payload)),
		})
	}
	return proof
}

func fixedHex(label string, size int) string {
	sum := sha256.Sum256([]byte(label))
	value := hex.EncodeToString(sum[:])
	for len(value) < size*2 {
		value += value
	}
	return value[:size*2]
}
