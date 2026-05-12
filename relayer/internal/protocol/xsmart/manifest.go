package xsmart

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

type Manifest struct {
	WorkflowID         string         `json:"workflow_id"`
	ServiceID          string         `json:"service_id"`
	RootChain          string         `json:"root_chain"`
	RootChainID        uint64         `json:"root_chain_id"`
	RootNodeIndex      uint64         `json:"root_node_index"`
	ExecuteThreshold   int            `json:"execute_threshold"`
	UpdateAckThreshold int            `json:"update_ack_threshold"`
	CallTreeBlob       string         `json:"call_tree_blob"`
	TranslationKeys    []string       `json:"translation_keys"`
	PeerIRHashes       []string       `json:"peer_ir_hashes"`
	Targets            []ManifestTarget `json:"targets"`
	WASM               ManifestTarget `json:"wasm"`
	Fabric             ManifestTarget `json:"fabric"`
}

type ManifestTarget struct {
	VM            string   `json:"vm"`
	Chain         string   `json:"chain"`
	Contract      string   `json:"contract"`
	BridgeContract string  `json:"bridge_contract"`
	Endpoint      string   `json:"endpoint"`
	StateContract string   `json:"state_contract"`
	StateContracts []string `json:"state_contracts"`
	LockNum       uint64   `json:"lock_num"`
	TimeoutBlocks uint64   `json:"timeout_blocks"`
	Update        struct {
		Kind      string `json:"kind"`
		User      string `json:"user"`
		Num       uint64 `json:"num"`
		TotalCost uint64 `json:"total_cost"`
	} `json:"update"`
}

func LoadManifest(path string) (*Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func (m *Manifest) EffectiveServiceID(fallback string) string {
	if strings.TrimSpace(m.ServiceID) != "" {
		return strings.TrimSpace(m.ServiceID)
	}
	return strings.TrimSpace(fallback)
}

func (m *Manifest) EffectiveExecuteThreshold() int {
	if m.ExecuteThreshold > 0 {
		return m.ExecuteThreshold
	}
	count := len(m.TargetList())
	if count > 0 {
		return count
	}
	return 1
}

func (m *Manifest) EffectiveUpdateAckThreshold() int {
	if m.UpdateAckThreshold > 0 {
		return m.UpdateAckThreshold
	}
	count := len(m.TargetList())
	if count > 0 {
		return count
	}
	return 1
}

func (m *Manifest) TargetList() []ManifestTarget {
	if len(m.Targets) > 0 {
		out := make([]ManifestTarget, 0, len(m.Targets))
		for _, target := range m.Targets {
			out = append(out, target.normalized())
		}
		return out
	}

	var out []ManifestTarget
	if strings.TrimSpace(m.WASM.Chain) != "" || strings.TrimSpace(m.WASM.Contract) != "" {
		target := m.WASM.normalized()
		if target.VM == "" {
			target.VM = "wasm"
		}
		out = append(out, target)
	}
	if strings.TrimSpace(m.Fabric.Chain) != "" || strings.TrimSpace(m.Fabric.Contract) != "" {
		target := m.Fabric.normalized()
		if target.VM == "" {
			target.VM = "fabric"
		}
		out = append(out, target)
	}
	return out
}

func (m *Manifest) EffectiveWASMChain(fallback string) string {
	if !m.HasWASM() {
		return strings.TrimSpace(fallback)
	}
	if strings.TrimSpace(m.WASM.Chain) != "" {
		return strings.TrimSpace(m.WASM.Chain)
	}
	return strings.TrimSpace(fallback)
}

func (m *Manifest) EffectiveFabricChain(fallback string) string {
	if !m.HasFabric() {
		return strings.TrimSpace(fallback)
	}
	if strings.TrimSpace(m.Fabric.Chain) != "" {
		return strings.TrimSpace(m.Fabric.Chain)
	}
	return strings.TrimSpace(fallback)
}

func (m *Manifest) EffectiveLockNum(fallback uint64) uint64 {
	if m.WASM.LockNum != 0 {
		return m.WASM.LockNum
	}
	return fallback
}

func (m *Manifest) EffectiveTimeoutBlocks(fallback uint64) uint64 {
	if m.WASM.TimeoutBlocks != 0 {
		return m.WASM.TimeoutBlocks
	}
	return fallback
}

func (m *Manifest) HasWASM() bool {
	for _, target := range m.TargetList() {
		if strings.EqualFold(target.VM, "wasm") {
			return true
		}
	}
	return false
}

func (m *Manifest) HasFabric() bool {
	for _, target := range m.TargetList() {
		if strings.EqualFold(target.VM, "fabric") {
			return true
		}
	}
	return false
}

func (m *Manifest) CallTreeBytes() ([]byte, error) {
	return decodeHexBytes(m.CallTreeBlob, "call_tree_blob")
}

func (m *Manifest) TranslationKeyHashes() ([]common.Hash, error) {
	return decodeHashes(m.TranslationKeys, "translation_keys")
}

func (m *Manifest) PeerIRHashList() ([]common.Hash, error) {
	return decodeHashes(m.PeerIRHashes, "peer_ir_hashes")
}

func (m *Manifest) Validate() error {
	if strings.TrimSpace(m.CallTreeBlob) == "" {
		return fmt.Errorf("xsmart manifest missing call_tree_blob")
	}
	if len(m.TranslationKeys) != len(m.PeerIRHashes) {
		return fmt.Errorf("xsmart manifest translation_keys and peer_ir_hashes length mismatch")
	}
	if _, err := m.CallTreeBytes(); err != nil {
		return err
	}
	if _, err := m.TranslationKeyHashes(); err != nil {
		return err
	}
	if _, err := m.PeerIRHashList(); err != nil {
		return err
	}
	for idx, target := range m.TargetList() {
		if strings.TrimSpace(target.VM) == "" {
			return fmt.Errorf("xsmart manifest targets[%d] missing vm", idx)
		}
		if strings.TrimSpace(target.Chain) == "" {
			return fmt.Errorf("xsmart manifest targets[%d] missing chain", idx)
		}
		if strings.EqualFold(target.VM, "evm") && strings.TrimSpace(target.BridgeContract) == "" {
			return fmt.Errorf("xsmart manifest targets[%d] missing bridge_contract", idx)
		}
	}
	return nil
}

func (t ManifestTarget) normalized() ManifestTarget {
	if len(t.StateContracts) == 0 && strings.TrimSpace(t.StateContract) != "" {
		t.StateContracts = []string{strings.TrimSpace(t.StateContract)}
	}
	t.VM = strings.ToLower(strings.TrimSpace(t.VM))
	t.Chain = strings.TrimSpace(t.Chain)
	t.Contract = strings.TrimSpace(t.Contract)
	t.BridgeContract = strings.TrimSpace(t.BridgeContract)
	t.Endpoint = strings.TrimSpace(t.Endpoint)
	t.StateContract = strings.TrimSpace(t.StateContract)
	t.Update.Kind = strings.ToLower(strings.TrimSpace(t.Update.Kind))
	for idx, value := range t.StateContracts {
		t.StateContracts[idx] = strings.TrimSpace(value)
	}
	return t
}

func decodeHexBytes(value string, field string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.TrimPrefix(trimmed, "0x")
	if trimmed == "" {
		return nil, fmt.Errorf("%s is empty", field)
	}
	data, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%s decode failed: %w", field, err)
	}
	return data, nil
}

func decodeHashes(values []string, field string) ([]common.Hash, error) {
	out := make([]common.Hash, 0, len(values))
	for idx, raw := range values {
		if !isBytes32Hex(raw) {
			return nil, fmt.Errorf("%s[%d] is not a bytes32 hex string", field, idx)
		}
		out = append(out, common.HexToHash(raw))
	}
	return out, nil
}

func isBytes32Hex(value string) bool {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "0x") || len(trimmed) != 66 {
		return false
	}
	_, err := hex.DecodeString(trimmed[2:])
	return err == nil
}
