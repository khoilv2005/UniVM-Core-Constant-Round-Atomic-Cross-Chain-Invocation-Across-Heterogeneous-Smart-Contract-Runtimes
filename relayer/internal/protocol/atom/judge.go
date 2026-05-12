package atom

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type Judge struct {
	cfg    *config.Config
	client *transport.EVMClient

	mu             sync.Mutex
	localJudges    []common.Address
	selectedByTxID map[string][]common.Address
}

func NewJudge(cfg *config.Config, client *transport.EVMClient) (*Judge, error) {
	judges := make([]common.Address, 0, len(cfg.Atom.JudgeKeys))
	for _, raw := range cfg.Atom.JudgeKeys {
		key, err := parseECDSA(raw)
		if err != nil {
			return nil, err
		}
		judges = append(judges, crypto.PubkeyToAddress(key.PublicKey))
	}
	return &Judge{
		cfg:            cfg,
		client:         client,
		localJudges:    judges,
		selectedByTxID: map[string][]common.Address{},
	}, nil
}

func (j *Judge) Name() protocolcommon.ProtocolName {
	return protocolcommon.ProtocolAtom
}

func (j *Judge) Handle(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	switch ev.Name {
	case "JudgesSelected":
		return nil, j.handleSelected(ev)
	case "AllProofsSubmitted":
		return j.handleProofsSubmitted(ev)
	case "JudgeVoteSubmitted":
		return j.handleVoteSubmitted(ev)
	default:
		return nil, nil
	}
}

func (j *Judge) handleSelected(ev protocolcommon.NormalizedEvent) error {
	judges, ok := protocolcommon.EventArg[[]common.Address](ev, "judges")
	if !ok {
		return nil
	}

	local := map[string]bool{}
	for _, addr := range j.localJudges {
		local[strings.ToLower(addr.Hex())] = true
	}
	selected := make([]common.Address, 0, len(judges))
	for _, judge := range judges {
		if local[strings.ToLower(judge.Hex())] {
			selected = append(selected, judge)
		}
	}

	j.mu.Lock()
	j.selectedByTxID[ev.TxID] = selected
	j.mu.Unlock()
	return nil
}

func (j *Judge) handleProofsSubmitted(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}

	j.mu.Lock()
	selected := append([]common.Address(nil), j.selectedByTxID[ev.TxID]...)
	j.mu.Unlock()
	if len(selected) == 0 {
		queried, err := j.querySelectedJudges(context.Background(), invokeID)
		if err != nil {
			return nil, err
		}
		selected = queried
		j.mu.Lock()
		j.selectedByTxID[ev.TxID] = append([]common.Address(nil), selected...)
		j.mu.Unlock()
	}
	if len(selected) == 0 {
		return nil, nil
	}

	serviceAddr := common.HexToAddress(j.cfg.Contracts.Atom["bc1"].AtomService)
	if serviceAddr == (common.Address{}) && common.IsHexAddress(j.cfg.Chains["bc1"].AtomServiceAddress) {
		serviceAddr = common.HexToAddress(j.cfg.Chains["bc1"].AtomServiceAddress)
	}

	var actions []protocolcommon.Action
	for _, judge := range selected {
		auditHash := crypto.Keccak256Hash(invokeID[:], judge.Bytes())
		var auditHash32 [32]byte
		copy(auditHash32[:], auditHash.Bytes())
		call, err := NewCallSubmitJudgeVote(invokeID, true, auditHash32)
		if err != nil {
			return nil, err
		}
		action := protocolcommon.NewAction(j.Name(), ev.TxID, ev.Name, "bc1", j.cfg.Chains["bc1"].ChainID, serviceAddr, call, 5).WithSigner(judge)
		actions = append(actions, action)
	}
	return actions, nil
}

func (j *Judge) handleVoteSubmitted(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}
	serviceAddr := common.HexToAddress(j.cfg.Contracts.Atom["bc1"].AtomService)
	if serviceAddr == (common.Address{}) && common.IsHexAddress(j.cfg.Chains["bc1"].AtomServiceAddress) {
		serviceAddr = common.HexToAddress(j.cfg.Chains["bc1"].AtomServiceAddress)
	}
	call, err := NewCallFinalizeInvocation(invokeID)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(j.Name(), ev.TxID, ev.Name, "bc1", j.cfg.Chains["bc1"].ChainID, serviceAddr, call, 6)
	return []protocolcommon.Action{action}, nil
}

func parseECDSA(raw string) (*ecdsa.PrivateKey, error) {
	key := strings.TrimPrefix(strings.TrimSpace(raw), "0x")
	bytes, err := hex.DecodeString(key)
	if err != nil {
		return nil, fmt.Errorf("decode hex key: %w", err)
	}
	return crypto.ToECDSA(bytes)
}

var selectedJudgesABI = mustJudgeABI(`[
  {"inputs":[{"internalType":"bytes32","name":"invokeId","type":"bytes32"}],"name":"getSelectedJudges","outputs":[{"internalType":"address[]","name":"","type":"address[]"}],"stateMutability":"view","type":"function"}
]`)

func (j *Judge) querySelectedJudges(ctx context.Context, invokeID [32]byte) ([]common.Address, error) {
	if j.client == nil {
		return nil, nil
	}
	serviceAddr := common.HexToAddress(j.cfg.Contracts.Atom["bc1"].AtomService)
	if serviceAddr == (common.Address{}) && common.IsHexAddress(j.cfg.Chains["bc1"].AtomServiceAddress) {
		serviceAddr = common.HexToAddress(j.cfg.Chains["bc1"].AtomServiceAddress)
	}
	call, err := selectedJudgesABI.Pack("getSelectedJudges", invokeID)
	if err != nil {
		return nil, err
	}
	raw, err := j.client.Call(ctx, serviceAddr, call)
	if err != nil {
		return nil, err
	}
	values, err := selectedJudgesABI.Unpack("getSelectedJudges", raw)
	if err != nil {
		return nil, err
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("unexpected getSelectedJudges outputs %d", len(values))
	}
	judges, ok := values[0].([]common.Address)
	if !ok {
		return nil, fmt.Errorf("unexpected getSelectedJudges output type %T", values[0])
	}
	local := map[string]bool{}
	for _, addr := range j.localJudges {
		local[strings.ToLower(addr.Hex())] = true
	}
	filtered := make([]common.Address, 0, len(judges))
	for _, judge := range judges {
		if local[strings.ToLower(judge.Hex())] {
			filtered = append(filtered, judge)
		}
	}
	return filtered, nil
}

func mustJudgeABI(raw string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(raw))
	if err != nil {
		panic(err)
	}
	return parsed
}
