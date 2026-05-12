package atom

import (
	"context"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

func TestJudgeRoutesVotesThroughLocalSelectedJudges(t *testing.T) {
	cfg := &config.Config{
		Protocol: "atom",
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1, AtomServiceAddress: "0x1111111111111111111111111111111111111111"},
		},
		Contracts: config.ContractsConfig{
			Atom: map[string]config.AtomChainContracts{
				"bc1": {AtomService: "0x1111111111111111111111111111111111111111"},
			},
		},
		Proof: config.ProofConfig{MaxRetry: 3},
		Atom: config.AtomConfig{
			JudgeKeys: []string{
				"b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291",
			},
		},
	}

	judge, err := NewJudge(cfg, nil)
	if err != nil {
		t.Fatalf("NewJudge: %v", err)
	}

	localKey, _ := crypto.HexToECDSA("b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291")
	localAddr := crypto.PubkeyToAddress(localKey.PublicKey)
	foreignAddr := common.HexToAddress("0x2222222222222222222222222222222222222222")
	var invokeID [32]byte
	invokeID[31] = 7

	_, err = judge.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolAtom,
		Name:     "JudgesSelected",
		TxID:     "0xaaa",
		Args: map[string]any{
			"invokeId": invokeID,
			"judges":   []common.Address{localAddr, foreignAddr},
		},
	})
	if err != nil {
		t.Fatalf("JudgesSelected: %v", err)
	}

	actions, err := judge.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolAtom,
		Name:     "AllProofsSubmitted",
		TxID:     "0xaaa",
		Args: map[string]any{
			"invokeId": invokeID,
		},
	})
	if err != nil {
		t.Fatalf("AllProofsSubmitted: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(actions))
	}
	if strings.ToLower(actions[0].Signer) != strings.ToLower(localAddr.Hex()) {
		t.Fatalf("unexpected signer %s", actions[0].Signer)
	}
	if actions[0].DestContract != common.HexToAddress("0x1111111111111111111111111111111111111111") {
		t.Fatalf("unexpected service contract %s", actions[0].DestContract.Hex())
	}
}

func TestJudgeFinalizeActionHasRetryBudget(t *testing.T) {
	cfg := &config.Config{
		Protocol: "atom",
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1, AtomServiceAddress: "0x1111111111111111111111111111111111111111"},
		},
		Contracts: config.ContractsConfig{
			Atom: map[string]config.AtomChainContracts{
				"bc1": {AtomService: "0x1111111111111111111111111111111111111111"},
			},
		},
		Atom: config.AtomConfig{
			JudgeKeys: []string{"b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291"},
		},
	}

	judge, err := NewJudge(cfg, nil)
	if err != nil {
		t.Fatalf("NewJudge: %v", err)
	}

	var invokeID [32]byte
	invokeID[0] = 1
	actions, err := judge.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolAtom,
		Name:     "JudgeVoteSubmitted",
		TxID:     "0xbbb",
		Args: map[string]any{
			"invokeId": invokeID,
		},
	})
	if err != nil {
		t.Fatalf("JudgeVoteSubmitted: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(actions))
	}
	if actions[0].MaxRetries < 2 {
		t.Fatalf("expected finalize action to have retry budget, got %d", actions[0].MaxRetries)
	}
}
