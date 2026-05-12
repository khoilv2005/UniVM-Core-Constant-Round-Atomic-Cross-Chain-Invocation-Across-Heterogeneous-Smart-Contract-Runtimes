package evm

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

const OutboundMode = "evm_update_production"

type Validator struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	Weight    uint64 `json:"weight"`
}

type FinalitySignature struct {
	ValidatorID string `json:"validator_id"`
	Signature   string `json:"signature"`
}

type OutboundUpdateProof struct {
	Version            int                 `json:"version"`
	Mode               string              `json:"mode"`
	SourceChainID      string              `json:"source_chain_id"`
	SourceBridge       string              `json:"source_bridge"`
	BlockNumber        uint64              `json:"block_number"`
	BlockHash          string              `json:"block_hash"`
	ReceiptsRoot       string              `json:"receipts_root"`
	StateRoot          string              `json:"state_root"`
	ValidatorSetHash   string              `json:"validator_set_hash"`
	Validators         []Validator         `json:"validators"`
	FinalitySignatures []FinalitySignature `json:"finality_signatures"`
	ReceiptHash        string              `json:"receipt_hash"`
	ReceiptProof       []string            `json:"receipt_proof"`
	EventName          string              `json:"event_name"`
	DestFamily         string              `json:"dest_family"`
	DestChain          string              `json:"dest_chain"`
	DestChainID        uint64              `json:"dest_chain_id"`
	Endpoint           string              `json:"endpoint"`
	Message            string              `json:"message"`
	OpID               string              `json:"op_id"`
	StateVersion       string              `json:"state_version"`
	UpdatePayloadHash  string              `json:"update_payload_hash"`
	HashAlgorithm      string              `json:"hash_algorithm"`
}

type VerificationResult struct {
	SignedWeight    uint64 `json:"signed_weight"`
	TotalWeight     uint64 `json:"total_weight"`
	PublicInputHash string `json:"public_input_hash"`
}

type finalityPayload struct {
	SourceChainID    string `json:"source_chain_id"`
	SourceBridge     string `json:"source_bridge"`
	BlockNumber      uint64 `json:"block_number"`
	BlockHash        string `json:"block_hash"`
	ReceiptsRoot     string `json:"receipts_root"`
	StateRoot        string `json:"state_root"`
	ValidatorSetHash string `json:"validator_set_hash"`
}

func VerifyOutboundUpdateProof(proof OutboundUpdateProof, updatePayload []byte) (VerificationResult, error) {
	if err := validateStaticFields(proof); err != nil {
		return VerificationResult{}, err
	}
	if err := verifyUpdatePayloadHash(proof, updatePayload); err != nil {
		return VerificationResult{}, err
	}
	if !verifyMerkleProof(proof.ReceiptHash, proof.ReceiptProof, proof.ReceiptsRoot) {
		return VerificationResult{}, errors.New("evm outbound proof receipt proof rejected")
	}

	validators := make(map[string]Validator, len(proof.Validators))
	var totalWeight uint64
	for _, validator := range proof.Validators {
		id := strings.TrimSpace(validator.ID)
		if id == "" {
			return VerificationResult{}, errors.New("evm outbound proof validator id is empty")
		}
		if validator.Weight == 0 {
			return VerificationResult{}, fmt.Errorf("evm outbound proof validator %q has zero weight", id)
		}
		if _, exists := validators[id]; exists {
			return VerificationResult{}, fmt.Errorf("evm outbound proof duplicate validator %q", id)
		}
		if _, err := decodeFixedHex(validator.PublicKey, 65, "validator public key"); err != nil {
			return VerificationResult{}, err
		}
		next := totalWeight + validator.Weight
		if next < totalWeight {
			return VerificationResult{}, errors.New("evm outbound proof validator weight overflow")
		}
		totalWeight = next
		validator.ID = id
		validators[id] = validator
	}
	if totalWeight == 0 {
		return VerificationResult{}, errors.New("evm outbound proof validator weight is zero")
	}

	payload, err := FinalitySigningPayload(proof)
	if err != nil {
		return VerificationResult{}, err
	}
	digest := crypto.Keccak256(payload)
	seen := make(map[string]struct{}, len(proof.FinalitySignatures))
	var signedWeight uint64
	for _, signature := range proof.FinalitySignatures {
		id := strings.TrimSpace(signature.ValidatorID)
		if id == "" {
			return VerificationResult{}, errors.New("evm outbound proof signature validator id is empty")
		}
		if _, exists := seen[id]; exists {
			return VerificationResult{}, fmt.Errorf("evm outbound proof duplicate signature from validator %q", id)
		}
		validator, ok := validators[id]
		if !ok {
			return VerificationResult{}, fmt.Errorf("evm outbound proof signature from unknown validator %q", id)
		}
		pub, _ := decodeFixedHex(validator.PublicKey, 65, "validator public key")
		sig, err := decodeFixedHex(signature.Signature, 65, "validator signature")
		if err != nil {
			return VerificationResult{}, err
		}
		if !crypto.VerifySignature(pub, digest, sig[:64]) {
			return VerificationResult{}, fmt.Errorf("evm outbound proof invalid signature from validator %q", id)
		}
		next := signedWeight + validator.Weight
		if next < signedWeight {
			return VerificationResult{}, errors.New("evm outbound proof signed weight overflow")
		}
		signedWeight = next
		seen[id] = struct{}{}
	}
	if !hasSupermajority(signedWeight, totalWeight) {
		return VerificationResult{}, fmt.Errorf("evm outbound proof signed weight %d does not exceed two thirds of total weight %d", signedWeight, totalWeight)
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

func FinalitySigningPayload(proof OutboundUpdateProof) ([]byte, error) {
	return json.Marshal(finalityPayload{
		SourceChainID:    strings.TrimSpace(proof.SourceChainID),
		SourceBridge:     strings.TrimSpace(proof.SourceBridge),
		BlockNumber:      proof.BlockNumber,
		BlockHash:        normalizeHex(proof.BlockHash),
		ReceiptsRoot:     normalizeHex(proof.ReceiptsRoot),
		StateRoot:        normalizeHex(proof.StateRoot),
		ValidatorSetHash: normalizeHex(proof.ValidatorSetHash),
	})
}

func PublicInputHash(proof OutboundUpdateProof) (string, error) {
	input := proof
	input.Validators = nil
	input.FinalitySignatures = nil
	raw, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	digest := crypto.Keccak256Hash(raw)
	return hex.EncodeToString(digest.Bytes()), nil
}

func validateStaticFields(proof OutboundUpdateProof) error {
	if proof.Version != 1 || proof.Mode != OutboundMode {
		return fmt.Errorf("evm outbound proof unsupported mode/version %q/%d", proof.Mode, proof.Version)
	}
	if strings.TrimSpace(proof.SourceChainID) == "" {
		return errors.New("evm outbound proof source_chain_id is empty")
	}
	if strings.TrimSpace(proof.SourceBridge) == "" {
		return errors.New("evm outbound proof source_bridge is empty")
	}
	if proof.BlockNumber == 0 {
		return errors.New("evm outbound proof block_number is zero")
	}
	for name, value := range map[string]string{
		"block hash":          proof.BlockHash,
		"receipts root":       proof.ReceiptsRoot,
		"state root":          proof.StateRoot,
		"validator set hash":  proof.ValidatorSetHash,
		"receipt hash":        proof.ReceiptHash,
		"update payload hash": proof.UpdatePayloadHash,
	} {
		if _, err := decodeFixedHex(value, 32, name); err != nil {
			return err
		}
	}
	if len(proof.Validators) == 0 {
		return errors.New("evm outbound proof validator set is empty")
	}
	if len(proof.FinalitySignatures) == 0 {
		return errors.New("evm outbound proof finality signatures are empty")
	}
	if strings.TrimSpace(proof.EventName) == "" || strings.TrimSpace(proof.Endpoint) == "" || strings.TrimSpace(proof.Message) == "" {
		return errors.New("evm outbound proof event/endpoint/message binding is incomplete")
	}
	if strings.TrimSpace(proof.DestFamily) == "" || strings.TrimSpace(proof.DestChain) == "" || proof.DestChainID == 0 {
		return errors.New("evm outbound proof destination binding is incomplete")
	}
	if strings.TrimSpace(proof.OpID) == "" || strings.TrimSpace(proof.StateVersion) == "" {
		return errors.New("evm outbound proof operation binding is incomplete")
	}
	switch strings.ToLower(strings.TrimSpace(proof.HashAlgorithm)) {
	case "sha256", "keccak256":
		return nil
	default:
		return fmt.Errorf("evm outbound proof unsupported hash algorithm %q", proof.HashAlgorithm)
	}
}

func verifyUpdatePayloadHash(proof OutboundUpdateProof, updatePayload []byte) error {
	var actual string
	switch strings.ToLower(strings.TrimSpace(proof.HashAlgorithm)) {
	case "sha256":
		digest := sha256.Sum256(updatePayload)
		actual = hex.EncodeToString(digest[:])
	case "keccak256":
		digest := crypto.Keccak256Hash(updatePayload)
		actual = hex.EncodeToString(digest.Bytes())
	default:
		return fmt.Errorf("evm outbound proof unsupported hash algorithm %q", proof.HashAlgorithm)
	}
	if normalizeHex(proof.UpdatePayloadHash) != actual {
		return fmt.Errorf("evm outbound proof update payload hash mismatch: expected %s got %s", normalizeHex(proof.UpdatePayloadHash), actual)
	}
	return nil
}

func verifyMerkleProof(leaf string, proof []string, root string) bool {
	computed, err := decodeFixedHex(leaf, 32, "receipt hash")
	if err != nil {
		return false
	}
	for _, sibling := range proof {
		peer, err := decodeFixedHex(sibling, 32, "receipt proof element")
		if err != nil {
			return false
		}
		if bytesLessOrEqual(computed, peer) {
			computed = crypto.Keccak256(computed, peer)
		} else {
			computed = crypto.Keccak256(peer, computed)
		}
	}
	expected, err := decodeFixedHex(root, 32, "receipts root")
	return err == nil && hex.EncodeToString(computed) == hex.EncodeToString(expected)
}

func hasSupermajority(signedWeight, totalWeight uint64) bool {
	left := new(big.Int).SetUint64(signedWeight)
	left.Mul(left, big.NewInt(3))
	right := new(big.Int).SetUint64(totalWeight)
	right.Mul(right, big.NewInt(2))
	return left.Cmp(right) == 1
}

func bytesLessOrEqual(a, b []byte) bool {
	return strings.Compare(hex.EncodeToString(a), hex.EncodeToString(b)) <= 0
}

func decodeFixedHex(value string, size int, name string) ([]byte, error) {
	decoded, err := hex.DecodeString(normalizeHex(value))
	if err != nil {
		return nil, fmt.Errorf("evm outbound proof invalid %s hex: %w", name, err)
	}
	if len(decoded) != size {
		return nil, fmt.Errorf("evm outbound proof invalid %s length: got %d want %d", name, len(decoded), size)
	}
	return decoded, nil
}

func normalizeHex(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "0x")
	return value
}
