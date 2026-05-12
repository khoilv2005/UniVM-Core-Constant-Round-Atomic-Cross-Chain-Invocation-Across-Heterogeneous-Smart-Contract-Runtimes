package gpact

import (
	"encoding/json"
	"os"
)

type Manifest struct {
	WorkflowID  string        `json:"workflow_id"`
	RootChainID uint64        `json:"root_chain_id"`
	Segments    []SegmentNode `json:"segments"`
}

type SegmentNode struct {
	SegmentID uint64 `json:"segment_id"`
	ChainID   uint64 `json:"chain_id"`
	Contract  string `json:"contract"`
	Function  string `json:"function"`
	Kind      string `json:"kind"`
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
