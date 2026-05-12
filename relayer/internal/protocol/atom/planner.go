package atom

import (
	"encoding/json"
	"fmt"
	"os"
)

type Manifest struct {
	WorkflowID      string              `json:"workflow_id"`
	WorkflowName    string              `json:"workflow_name"`
	TotalOperations int                 `json:"total_operations"`
	RemoteFunctions []RemoteFunction    `json:"remote_functions"`
	Operations      []ManifestOperation `json:"operations"`
}

type RemoteFunction struct {
	FunctionID         string `json:"function_id"`
	ChainID            uint64 `json:"chain_id"`
	ContractAddress    string `json:"contract_address"`
	BusinessUnit       string `json:"business_unit"`
	Pattern            string `json:"pattern"`
	LockDoSelector     string `json:"lock_do_selector"`
	UnlockSelector     string `json:"unlock_selector"`
	UndoUnlockSelector string `json:"undo_unlock_selector"`
}

type ManifestOperation struct {
	ID             uint64   `json:"id"`
	Step           uint64   `json:"step"`
	FunctionID     string   `json:"function_id"`
	ParameterNames []string `json:"parameter_names"`
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

func (m *Manifest) ValidateSequentialWriteOnly() error {
	if m == nil {
		return fmt.Errorf("nil ATOM manifest")
	}
	if m.TotalOperations <= 0 {
		return fmt.Errorf("total_operations must be positive")
	}
	if len(m.Operations) != m.TotalOperations {
		return fmt.Errorf("operations length %d does not match total_operations %d", len(m.Operations), m.TotalOperations)
	}

	seenSteps := make(map[uint64]bool, len(m.Operations))
	seenIDs := make(map[uint64]bool, len(m.Operations))
	for _, op := range m.Operations {
		if op.ID == 0 || op.Step == 0 {
			return fmt.Errorf("operation %q has zero id or step", op.FunctionID)
		}
		if seenIDs[op.ID] {
			return fmt.Errorf("duplicate operation id %d", op.ID)
		}
		if seenSteps[op.Step] {
			return fmt.Errorf("parallel ATOM step %d is not allowed for paper-aligned write-only workflow", op.Step)
		}
		if op.ID != op.Step {
			return fmt.Errorf("operation %d must be scheduled at step %d for sequential dependency chain", op.ID, op.ID)
		}
		seenIDs[op.ID] = true
		seenSteps[op.Step] = true
	}
	for i := 1; i <= m.TotalOperations; i++ {
		step := uint64(i)
		if !seenSteps[step] {
			return fmt.Errorf("missing sequential ATOM step %d", step)
		}
	}
	return nil
}
