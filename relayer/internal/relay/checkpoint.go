package relay

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

type CheckpointStore struct {
	path    string
	mu      sync.Mutex
	actions map[string]protocolcommon.Action
}

func NewCheckpointStore(path string) (*CheckpointStore, error) {
	store := &CheckpointStore{
		path:    path,
		actions: map[string]protocolcommon.Action{},
	}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *CheckpointStore) Put(action protocolcommon.Action) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.actions[action.ID] = action
	return s.flushLocked()
}

func (s *CheckpointStore) Get(id string) (protocolcommon.Action, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	action, ok := s.actions[id]
	return action, ok
}

func (s *CheckpointStore) Pending() []protocolcommon.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	var out []protocolcommon.Action
	for _, action := range s.actions {
		if action.Status == protocolcommon.ActionDone || action.Status == protocolcommon.ActionAbandoned {
			continue
		}
		out = append(out, action)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

func (s *CheckpointStore) load() error {
	if _, err := os.Stat(s.path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, &s.actions)
}

func (s *CheckpointStore) flushLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.actions, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o644)
}
