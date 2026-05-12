package substrate

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

type MetadataBinding struct {
	ChainID          string `json:"chain_id"`
	ContractID       string `json:"contract_id"`
	SchemaHash       string `json:"schema_hash"`
	OpID             string `json:"op_id"`
	LockEpoch        uint64 `json:"lock_epoch"`
	StateVersion     uint64 `json:"state_version"`
	StatePayloadHash string `json:"state_payload_hash"`
	HashAlgorithm    string `json:"hash_algorithm"`
}

type Authority struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	Weight    uint64 `json:"weight"`
}

type Signature struct {
	AuthorityID string `json:"authority_id"`
	Signature   string `json:"signature"`
}

type FinalityProof struct {
	SetID                uint64          `json:"set_id"`
	Round                uint64          `json:"round"`
	FinalizedBlockNumber uint64          `json:"finalized_block_number"`
	FinalizedBlockHash   string          `json:"finalized_block_hash"`
	StateRoot            string          `json:"state_root"`
	StorageProofHash     string          `json:"storage_proof_hash"`
	Authorities          []Authority     `json:"authorities"`
	Signatures           []Signature     `json:"signatures"`
	Binding              MetadataBinding `json:"binding"`
}

type VerificationResult struct {
	SignedWeight    uint64 `json:"signed_weight"`
	TotalWeight     uint64 `json:"total_weight"`
	PublicInputHash string `json:"public_input_hash"`
}

type signingPayload struct {
	SetID                uint64          `json:"set_id"`
	Round                uint64          `json:"round"`
	FinalizedBlockNumber uint64          `json:"finalized_block_number"`
	FinalizedBlockHash   string          `json:"finalized_block_hash"`
	StateRoot            string          `json:"state_root"`
	StorageProofHash     string          `json:"storage_proof_hash"`
	Binding              MetadataBinding `json:"binding"`
}

func VerifyFinalityProof(proof FinalityProof, encodedState []byte) (VerificationResult, error) {
	if err := validateStaticFields(proof); err != nil {
		return VerificationResult{}, err
	}
	if err := verifyStatePayloadHash(proof.Binding, encodedState); err != nil {
		return VerificationResult{}, err
	}

	authorities := make(map[string]Authority, len(proof.Authorities))
	var totalWeight uint64
	for _, authority := range proof.Authorities {
		id := strings.TrimSpace(authority.ID)
		if id == "" {
			return VerificationResult{}, errors.New("substrate proof authority id is empty")
		}
		if authority.Weight == 0 {
			return VerificationResult{}, fmt.Errorf("substrate proof authority %q has zero weight", id)
		}
		if _, exists := authorities[id]; exists {
			return VerificationResult{}, fmt.Errorf("substrate proof authority %q is duplicated", id)
		}
		if _, err := decodeFixedHex(authority.PublicKey, ed25519.PublicKeySize, "authority public key"); err != nil {
			return VerificationResult{}, err
		}
		next := totalWeight + authority.Weight
		if next < totalWeight {
			return VerificationResult{}, errors.New("substrate proof authority weight overflow")
		}
		totalWeight = next
		authority.ID = id
		authorities[id] = authority
	}
	if totalWeight == 0 {
		return VerificationResult{}, errors.New("substrate proof total authority weight is zero")
	}

	payload, err := SigningPayload(proof)
	if err != nil {
		return VerificationResult{}, err
	}
	seen := make(map[string]struct{}, len(proof.Signatures))
	var signedWeight uint64
	for _, vote := range proof.Signatures {
		id := strings.TrimSpace(vote.AuthorityID)
		if id == "" {
			return VerificationResult{}, errors.New("substrate proof signature authority id is empty")
		}
		if _, exists := seen[id]; exists {
			return VerificationResult{}, fmt.Errorf("substrate proof duplicate signature from authority %q", id)
		}
		authority, ok := authorities[id]
		if !ok {
			return VerificationResult{}, fmt.Errorf("substrate proof signature from unknown authority %q", id)
		}
		pub, _ := decodeFixedHex(authority.PublicKey, ed25519.PublicKeySize, "authority public key")
		sig, err := decodeFixedHex(vote.Signature, ed25519.SignatureSize, "authority signature")
		if err != nil {
			return VerificationResult{}, err
		}
		if !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
			return VerificationResult{}, fmt.Errorf("substrate proof invalid signature from authority %q", id)
		}
		next := signedWeight + authority.Weight
		if next < signedWeight {
			return VerificationResult{}, errors.New("substrate proof signed weight overflow")
		}
		signedWeight = next
		seen[id] = struct{}{}
	}
	if !hasGrandpaSupermajority(signedWeight, totalWeight) {
		return VerificationResult{}, fmt.Errorf("substrate proof signed weight %d does not exceed two thirds of total weight %d", signedWeight, totalWeight)
	}

	publicInputHash, err := PublicInputHash(proof)
	if err != nil {
		return VerificationResult{}, err
	}
	return VerificationResult{
		SignedWeight:    signedWeight,
		TotalWeight:     totalWeight,
		PublicInputHash: publicInputHash,
	}, nil
}

func SigningPayload(proof FinalityProof) ([]byte, error) {
	payload := signingPayload{
		SetID:                proof.SetID,
		Round:                proof.Round,
		FinalizedBlockNumber: proof.FinalizedBlockNumber,
		FinalizedBlockHash:   normalizeHex(proof.FinalizedBlockHash),
		StateRoot:            normalizeHex(proof.StateRoot),
		StorageProofHash:     normalizeHex(proof.StorageProofHash),
		Binding:              normalizeBinding(proof.Binding),
	}
	return json.Marshal(payload)
}

func PublicInputHash(proof FinalityProof) (string, error) {
	payload, err := SigningPayload(proof)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func validateStaticFields(proof FinalityProof) error {
	if proof.Round == 0 {
		return errors.New("substrate proof round is zero")
	}
	if proof.FinalizedBlockNumber == 0 {
		return errors.New("substrate proof finalized block number is zero")
	}
	if _, err := decodeFixedHex(proof.FinalizedBlockHash, 32, "finalized block hash"); err != nil {
		return err
	}
	if _, err := decodeFixedHex(proof.StateRoot, 32, "state root"); err != nil {
		return err
	}
	if _, err := decodeFixedHex(proof.StorageProofHash, 32, "storage proof hash"); err != nil {
		return err
	}
	if len(proof.Authorities) == 0 {
		return errors.New("substrate proof authority set is empty")
	}
	if len(proof.Signatures) == 0 {
		return errors.New("substrate proof signature set is empty")
	}
	if err := validateBinding(proof.Binding); err != nil {
		return err
	}
	return nil
}

func validateBinding(binding MetadataBinding) error {
	if strings.TrimSpace(binding.ChainID) == "" {
		return errors.New("substrate proof binding chain_id is empty")
	}
	if strings.TrimSpace(binding.ContractID) == "" {
		return errors.New("substrate proof binding contract_id is empty")
	}
	if strings.TrimSpace(binding.OpID) == "" {
		return errors.New("substrate proof binding op_id is empty")
	}
	if binding.LockEpoch == 0 {
		return errors.New("substrate proof binding lock_epoch is zero")
	}
	if binding.StateVersion == 0 {
		return errors.New("substrate proof binding state_version is zero")
	}
	if _, err := decodeFixedHex(binding.SchemaHash, 32, "schema hash"); err != nil {
		return err
	}
	if _, err := decodeFixedHex(binding.StatePayloadHash, 32, "state payload hash"); err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(binding.HashAlgorithm)) {
	case "sha256", "keccak256":
		return nil
	default:
		return fmt.Errorf("substrate proof unsupported state hash algorithm %q", binding.HashAlgorithm)
	}
}

func verifyStatePayloadHash(binding MetadataBinding, encodedState []byte) error {
	var sum []byte
	switch strings.ToLower(strings.TrimSpace(binding.HashAlgorithm)) {
	case "sha256":
		digest := sha256.Sum256(encodedState)
		sum = digest[:]
	case "keccak256":
		digest := crypto.Keccak256Hash(encodedState)
		sum = digest.Bytes()
	default:
		return fmt.Errorf("substrate proof unsupported state hash algorithm %q", binding.HashAlgorithm)
	}
	expected := normalizeHex(binding.StatePayloadHash)
	actual := hex.EncodeToString(sum)
	if actual != expected {
		return fmt.Errorf("substrate proof state payload hash mismatch: expected %s got %s", expected, actual)
	}
	return nil
}

func hasGrandpaSupermajority(signedWeight, totalWeight uint64) bool {
	left := new(big.Int).SetUint64(signedWeight)
	left.Mul(left, big.NewInt(3))
	right := new(big.Int).SetUint64(totalWeight)
	right.Mul(right, big.NewInt(2))
	return left.Cmp(right) == 1
}

func normalizeBinding(binding MetadataBinding) MetadataBinding {
	binding.ChainID = strings.TrimSpace(binding.ChainID)
	binding.ContractID = strings.TrimSpace(binding.ContractID)
	binding.SchemaHash = normalizeHex(binding.SchemaHash)
	binding.OpID = strings.TrimSpace(binding.OpID)
	binding.StatePayloadHash = normalizeHex(binding.StatePayloadHash)
	binding.HashAlgorithm = strings.ToLower(strings.TrimSpace(binding.HashAlgorithm))
	return binding
}

func decodeFixedHex(value string, size int, name string) ([]byte, error) {
	decoded, err := hex.DecodeString(normalizeHex(value))
	if err != nil {
		return nil, fmt.Errorf("substrate proof invalid %s hex: %w", name, err)
	}
	if len(decoded) != size {
		return nil, fmt.Errorf("substrate proof invalid %s length: got %d want %d", name, len(decoded), size)
	}
	return decoded, nil
}

func normalizeHex(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "0x")
	return value
}
