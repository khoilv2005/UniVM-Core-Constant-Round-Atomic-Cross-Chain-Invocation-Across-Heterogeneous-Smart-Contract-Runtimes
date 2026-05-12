package succinct

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestBuildProofEnvelopeBindsStateImportPublicValues(t *testing.T) {
	binding := StateImportBinding{
		ChainID:          crypto.Keccak256Hash([]byte("WASM_SUBSTRATE:bc2")),
		ContractID:       crypto.Keccak256Hash([]byte("contract:xbridge_bc2")),
		SchemaHash:       crypto.Keccak256Hash([]byte("schema:TrainBooking:v1")),
		OpID:             common.BigToHash(big.NewInt(1)),
		LockEpoch:        7,
		StateVersion:     8,
		EncodedStateHash: crypto.Keccak256Hash([]byte("encoded-state")),
	}
	envelope, publicValues, err := BuildProofEnvelope(binding, []byte("sp1-proof"))
	if err != nil {
		t.Fatalf("BuildProofEnvelope failed: %v", err)
	}
	if len(envelope) == 0 || len(publicValues) == 0 {
		t.Fatalf("expected non-empty envelope/public values")
	}

	values, err := proofEnvelopeArgs.Unpack(envelope)
	if err != nil {
		t.Fatalf("unpack envelope: %v", err)
	}
	if string(values[1].([]byte)) != "sp1-proof" {
		t.Fatalf("proof bytes mismatch")
	}

	decoded, err := publicValueArgs.Unpack(values[0].([]byte))
	if err != nil {
		t.Fatalf("unpack public values: %v", err)
	}
	if decoded[0].([32]byte) != PublicValuesDomain {
		t.Fatalf("domain mismatch")
	}
	if decoded[1].([32]byte) != binding.ChainID {
		t.Fatalf("chain binding mismatch")
	}
	if decoded[7].([32]byte) != binding.EncodedStateHash {
		t.Fatalf("state hash binding mismatch")
	}
}

func TestBuildProofEnvelopeRejectsEmptyProof(t *testing.T) {
	_, _, err := BuildProofEnvelope(StateImportBinding{}, nil)
	if err == nil {
		t.Fatalf("empty succinct proof must be rejected")
	}
}
