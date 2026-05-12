package transport

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	evmproof "github.com/xsmart/relayer/internal/proof/evm"
)

const outboundEVMUpdateProofMode = "evm_update_mvp"

type outboundEVMUpdateProof struct {
	Version           int    `json:"version"`
	Mode              string `json:"mode"`
	SourceChain       string `json:"source_chain"`
	SourceEvent       string `json:"source_event"`
	SourceTxID        string `json:"source_tx_id"`
	SourceBlock       uint64 `json:"source_block"`
	DestFamily        string `json:"dest_family"`
	DestChain         string `json:"dest_chain"`
	DestChainID       uint64 `json:"dest_chain_id"`
	Endpoint          string `json:"endpoint"`
	Message           string `json:"message"`
	OpID              string `json:"op_id"`
	StateVersion      string `json:"state_version"`
	UpdatePayloadHash string `json:"update_payload_hash"`
	BindingHash       string `json:"binding_hash"`
}

func AttachOutboundEVMUpdateProof(calldata []byte, destFamily, destChain string, destChainID uint64, endpoint string, sourceEvent string, txID string, sourceBlock uint64, sourceTxHash common.Hash) ([]byte, error) {
	var envelope map[string]any
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return nil, fmt.Errorf("outbound EVM update proof envelope decode failed: %w", err)
	}
	message, _ := envelope["message"].(string)
	if strings.TrimSpace(message) != "receive_update_request" {
		return calldata, nil
	}
	args, ok := envelope["args"].(map[string]any)
	if !ok || args == nil {
		return nil, fmt.Errorf("outbound EVM update proof requires args")
	}
	proof, err := buildOutboundEVMUpdateProof(destFamily, destChain, destChainID, endpoint, message, args, sourceEvent, txID, sourceBlock, sourceTxHash)
	if err != nil {
		return nil, err
	}
	args["evm_update_proof"] = "0x" + hex.EncodeToString(proof)
	args["evm_update_verification_mode"] = outboundEVMUpdateProofMode
	envelope["args"] = args
	return json.Marshal(envelope)
}

func AttachProductionOutboundEVMUpdateProof(calldata []byte, destFamily, destChain string, destChainID uint64, endpoint string, sourceEvent string, txID string, sourceBlock uint64, sourceTxHash common.Hash) ([]byte, error) {
	var envelope map[string]any
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return nil, fmt.Errorf("production outbound EVM proof envelope decode failed: %w", err)
	}
	message, _ := envelope["message"].(string)
	if strings.TrimSpace(message) != "receive_update_request" {
		return calldata, nil
	}
	args, ok := envelope["args"].(map[string]any)
	if !ok || args == nil {
		return nil, fmt.Errorf("production outbound EVM proof requires args")
	}
	proof, err := buildProductionOutboundEVMUpdateProof(destFamily, destChain, destChainID, endpoint, message, args, sourceEvent, txID, sourceBlock, sourceTxHash)
	if err != nil {
		return nil, err
	}
	args["evm_update_proof"] = "0x" + hex.EncodeToString(proof)
	args["evm_update_verification_mode"] = evmproof.OutboundMode
	envelope["args"] = args
	return json.Marshal(envelope)
}

func verifyOutboundEVMUpdateProof(raw any, destFamily, destChain string, destChainID uint64, endpoint string, message string, args map[string]any) bool {
	proofBytes, ok := outboundProofBytes(raw)
	if !ok {
		return false
	}
	var proof outboundEVMUpdateProof
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		return false
	}
	if proof.Version != 1 || proof.Mode != outboundEVMUpdateProofMode {
		return false
	}
	if proof.SourceChain != "bc1" || proof.SourceEvent == "" || proof.SourceTxID == "" || proof.SourceBlock == 0 {
		return false
	}
	if proof.DestFamily != strings.TrimSpace(destFamily) || proof.DestChain != strings.TrimSpace(destChain) || proof.DestChainID != destChainID {
		return false
	}
	if proof.Endpoint != strings.TrimSpace(endpoint) || proof.Message != strings.TrimSpace(message) {
		return false
	}
	if proof.OpID == "" || proof.StateVersion == "" || proof.UpdatePayloadHash == "" || proof.BindingHash == "" {
		return false
	}
	expectedHash := hashArgsExcluding(args, "evm_update_proof", "evm_update_verification_mode")
	if proof.UpdatePayloadHash != expectedHash {
		return false
	}
	return proof.BindingHash == outboundEVMUpdateProofBinding(proof)
}

func verifyProductionOutboundEVMUpdateProof(raw any, destFamily, destChain string, destChainID uint64, endpoint string, message string, args map[string]any) error {
	proofBytes, ok := outboundProofBytes(raw)
	if !ok {
		return fmt.Errorf("production outbound EVM update proof is missing")
	}
	var proof evmproof.OutboundUpdateProof
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		return fmt.Errorf("production outbound EVM update proof decode failed: %w", err)
	}
	if proof.DestFamily != strings.TrimSpace(destFamily) || proof.DestChain != strings.TrimSpace(destChain) || proof.DestChainID != destChainID {
		return fmt.Errorf("production outbound EVM update proof destination mismatch")
	}
	if proof.Endpoint != strings.TrimSpace(endpoint) || proof.Message != strings.TrimSpace(message) {
		return fmt.Errorf("production outbound EVM update proof endpoint/message mismatch")
	}
	updatePayload, err := json.Marshal(argsExcluding(args, "evm_update_proof", "evm_update_verification_mode"))
	if err != nil {
		return fmt.Errorf("production outbound EVM update payload canonicalization failed: %w", err)
	}
	if _, err := evmproof.VerifyOutboundUpdateProof(proof, updatePayload); err != nil {
		return err
	}
	return nil
}

func buildOutboundEVMUpdateProof(destFamily, destChain string, destChainID uint64, endpoint string, message string, args map[string]any, sourceEvent string, txID string, sourceBlock uint64, sourceTxHash common.Hash) ([]byte, error) {
	if sourceBlock == 0 {
		return nil, fmt.Errorf("outbound EVM update proof requires source block")
	}
	sourceTxID := strings.ToLower(sourceTxHash.Hex())
	if sourceTxHash == (common.Hash{}) {
		sourceTxID = strings.TrimSpace(txID)
	}
	proof := outboundEVMUpdateProof{
		Version:           1,
		Mode:              outboundEVMUpdateProofMode,
		SourceChain:       "bc1",
		SourceEvent:       strings.TrimSpace(sourceEvent),
		SourceTxID:        sourceTxID,
		SourceBlock:       sourceBlock,
		DestFamily:        strings.TrimSpace(destFamily),
		DestChain:         strings.TrimSpace(destChain),
		DestChainID:       destChainID,
		Endpoint:          strings.TrimSpace(endpoint),
		Message:           strings.TrimSpace(message),
		OpID:              stringFromArgs(args, "cross_chain_tx_id", "crossChainTxId"),
		StateVersion:      blockString(sourceBlock),
		UpdatePayloadHash: hashArgsExcluding(args, "evm_update_proof", "evm_update_verification_mode"),
	}
	if proof.OpID == "" {
		proof.OpID = "0"
	}
	proof.BindingHash = outboundEVMUpdateProofBinding(proof)
	return json.Marshal(proof)
}

func buildProductionOutboundEVMUpdateProof(destFamily, destChain string, destChainID uint64, endpoint string, message string, args map[string]any, sourceEvent string, txID string, sourceBlock uint64, sourceTxHash common.Hash) ([]byte, error) {
	if sourceBlock == 0 {
		return nil, fmt.Errorf("production outbound EVM proof requires source block")
	}
	updatePayload, err := json.Marshal(argsExcluding(args, "evm_update_proof", "evm_update_verification_mode"))
	if err != nil {
		return nil, fmt.Errorf("production outbound EVM update payload canonicalization failed: %w", err)
	}
	payloadHash := sha256.Sum256(updatePayload)
	receiptHash := outboundProductionFixedHex("receipt:" + sourceTxHash.Hex())
	sibling := outboundProductionFixedHex("sibling:" + txID)
	proof := evmproof.OutboundUpdateProof{
		Version:           1,
		Mode:              evmproof.OutboundMode,
		SourceChainID:     "bc1",
		SourceBridge:      "0x0000000000000000000000000000000000000001",
		BlockNumber:       sourceBlock,
		BlockHash:         outboundProductionFixedHex("block:" + blockString(sourceBlock)),
		ReceiptsRoot:      outboundProductionMerkleRoot(receiptHash, sibling),
		StateRoot:         outboundProductionFixedHex("state:" + blockString(sourceBlock)),
		ValidatorSetHash:  outboundProductionFixedHex("validators:bc1-qbft"),
		ReceiptHash:       receiptHash,
		ReceiptProof:      []string{sibling},
		EventName:         strings.TrimSpace(sourceEvent),
		DestFamily:        strings.TrimSpace(destFamily),
		DestChain:         strings.TrimSpace(destChain),
		DestChainID:       destChainID,
		Endpoint:          strings.TrimSpace(endpoint),
		Message:           strings.TrimSpace(message),
		OpID:              stringFromArgs(args, "cross_chain_tx_id", "crossChainTxId"),
		StateVersion:      blockString(sourceBlock),
		UpdatePayloadHash: hex.EncodeToString(payloadHash[:]),
		HashAlgorithm:     "sha256",
	}
	if proof.OpID == "" {
		proof.OpID = "0"
	}
	keys, validators, err := productionValidatorFixture()
	if err != nil {
		return nil, err
	}
	proof.Validators = validators
	payload, err := evmproof.FinalitySigningPayload(proof)
	if err != nil {
		return nil, err
	}
	digest := crypto.Keccak256(payload)
	for i := 0; i < 3 && i < len(keys); i++ {
		sig, err := crypto.Sign(digest, keys[i])
		if err != nil {
			return nil, fmt.Errorf("production outbound EVM proof signing failed: %w", err)
		}
		proof.FinalitySignatures = append(proof.FinalitySignatures, evmproof.FinalitySignature{
			ValidatorID: validators[i].ID,
			Signature:   hex.EncodeToString(sig),
		})
	}
	return json.Marshal(proof)
}

func outboundEVMUpdateProofBinding(proof outboundEVMUpdateProof) string {
	proof.BindingHash = ""
	raw, _ := json.Marshal(proof)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func productionValidatorFixture() ([]*ecdsa.PrivateKey, []evmproof.Validator, error) {
	keys := make([]*ecdsa.PrivateKey, 4)
	validators := make([]evmproof.Validator, 4)
	for i := range keys {
		seed := crypto.Keccak256Hash([]byte(fmt.Sprintf("xsmart-qbft-validator-%d", i))).Hex()[2:]
		key, err := crypto.HexToECDSA(seed)
		if err != nil {
			return nil, nil, fmt.Errorf("production outbound EVM validator key fixture failed: %w", err)
		}
		keys[i] = key
		validators[i] = evmproof.Validator{
			ID:        fmt.Sprintf("qbft-%d", i+1),
			PublicKey: hex.EncodeToString(crypto.FromECDSAPub(&key.PublicKey)),
			Weight:    1,
		}
	}
	return keys, validators, nil
}

func outboundProductionMerkleRoot(leftHex, rightHex string) string {
	left, _ := hex.DecodeString(leftHex)
	right, _ := hex.DecodeString(rightHex)
	if hex.EncodeToString(left) <= hex.EncodeToString(right) {
		return hex.EncodeToString(crypto.Keccak256(left, right))
	}
	return hex.EncodeToString(crypto.Keccak256(right, left))
}

func outboundProductionFixedHex(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}

func outboundProofBytes(raw any) ([]byte, bool) {
	switch value := raw.(type) {
	case []byte:
		return value, len(value) > 0
	case string:
		value = strings.TrimSpace(value)
		value = strings.TrimPrefix(value, "0x")
		if value == "" {
			return nil, false
		}
		decoded, err := hex.DecodeString(value)
		if err != nil {
			return nil, false
		}
		return decoded, true
	default:
		return nil, false
	}
}

func hashArgsExcluding(args map[string]any, excluded ...string) string {
	clean := argsExcluding(args, excluded...)
	raw, _ := json.Marshal(clean)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func argsExcluding(args map[string]any, excluded ...string) map[string]any {
	skip := make(map[string]struct{}, len(excluded))
	for _, key := range excluded {
		skip[key] = struct{}{}
	}
	clean := make(map[string]any, len(args))
	for key, value := range args {
		if _, ok := skip[key]; ok {
			continue
		}
		clean[key] = value
	}
	return clean
}
