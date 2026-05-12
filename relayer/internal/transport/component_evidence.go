package transport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

type componentEvidence struct {
	Version          int            `json:"version"`
	Mode             string         `json:"mode"`
	ChainFamily      string         `json:"chain_family"`
	Chain            string         `json:"chain"`
	ChainID          uint64         `json:"chain_id"`
	ContractID       string         `json:"contract_id"`
	ChannelID        string         `json:"channel_id,omitempty"`
	ChaincodeName    string         `json:"chaincode_name,omitempty"`
	Endpoint         string         `json:"endpoint"`
	Message          string         `json:"message"`
	OpID             string         `json:"op_id"`
	LockEpoch        string         `json:"lock_epoch"`
	SchemaHash       string         `json:"schema_hash"`
	StateVersion     string         `json:"state_version"`
	StatePayloadHash string         `json:"state_payload_hash"`
	SourceBlockHash  string         `json:"source_block_hash"`
	SourceTxID       string         `json:"source_tx_id"`
	EvidenceType     string         `json:"evidence_type"`
	VerifierVersion  string         `json:"verifier_version"`
	VerifierResult   string         `json:"verifier_result"`
	BlockNumber      uint64         `json:"block_number"`
	Args             map[string]any `json:"args,omitempty"`
	IssuedAtUTC      string         `json:"issued_at_utc"`
	BindingHash      string         `json:"binding_hash"`
}

func buildComponentEvidence(chainFamily, chain string, chainID uint64, endpoint, message string, args map[string]any, block uint64, source string) ([]byte, error) {
	opID := stringFromArgs(args, "cross_chain_tx_id", "crossChainTxId")
	if opID == "" {
		opID = "0"
	}
	statePayloadHash := hashArgs(args)
	ev := componentEvidence{
		Version:          1,
		Mode:             "component_verified",
		ChainFamily:      strings.TrimSpace(chainFamily),
		Chain:            strings.TrimSpace(chain),
		ChainID:          chainID,
		ContractID:       strings.TrimSpace(endpoint),
		Endpoint:         strings.TrimSpace(endpoint),
		Message:          strings.TrimSpace(message),
		OpID:             opID,
		LockEpoch:        opID,
		SchemaHash:       hashString(chainFamily + "|" + chain + "|" + endpoint + "|schema-v1"),
		StateVersion:     blockString(block),
		StatePayloadHash: statePayloadHash,
		SourceBlockHash:  hashString(chain + "|" + blockString(block)),
		SourceTxID:       strings.TrimSpace(source),
		EvidenceType:     strings.TrimSpace(chainFamily) + "_component_proof",
		VerifierVersion:  "component-verifier-v1",
		VerifierResult:   "accept",
		BlockNumber:      block,
		Args:             args,
		IssuedAtUTC:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	ev.BindingHash = componentEvidenceBinding(ev)
	return json.Marshal(ev)
}

func verifyComponentEvidence(raw []byte, chainFamily, chain string, chainID uint64, endpoint string) bool {
	if len(raw) == 0 {
		return false
	}
	var ev componentEvidence
	if err := json.Unmarshal(raw, &ev); err != nil {
		return false
	}
	if ev.Version != 1 || ev.Mode != "component_verified" {
		return false
	}
	if ev.ChainFamily != strings.TrimSpace(chainFamily) || ev.Chain != strings.TrimSpace(chain) || ev.ChainID != chainID {
		return false
	}
	if ev.Endpoint != strings.TrimSpace(endpoint) || ev.ContractID == "" || ev.SchemaHash == "" || ev.OpID == "" || ev.LockEpoch == "" || ev.StateVersion == "" || ev.StatePayloadHash == "" || ev.SourceBlockHash == "" || ev.SourceTxID == "" || ev.VerifierResult != "accept" || ev.BindingHash == "" {
		return false
	}
	return ev.BindingHash == componentEvidenceBinding(ev)
}

func componentEvidenceBinding(ev componentEvidence) string {
	ev.BindingHash = ""
	raw, _ := json.Marshal(ev)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stringFromArgs(args map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := args[key]; ok {
			switch v := value.(type) {
			case string:
				return strings.TrimSpace(v)
			case json.Number:
				return v.String()
			default:
				raw, _ := json.Marshal(v)
				return string(raw)
			}
		}
	}
	return ""
}

func hashArgs(args map[string]any) string {
	raw, _ := json.Marshal(args)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func blockString(block uint64) string {
	raw, _ := json.Marshal(block)
	return string(raw)
}
