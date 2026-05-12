package atom

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

func TestServerHandleWriteOnlyDepth4ReleasesOperationsSequentially(t *testing.T) {
	t.Helper()

	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "atom-depth4.json")
	manifest := Manifest{
		WorkflowID:      "atom-travel-write-only-depth-4",
		WorkflowName:    "Atom Travel Write Only Depth 4",
		TotalOperations: 3,
		RemoteFunctions: []RemoteFunction{
			{
				FunctionID:      "hotel-write",
				ChainID:         2,
				ContractAddress: "0xE1866ebc74355F8E62383957bDd0eD26F47f88e1",
				BusinessUnit:    "hotel.book",
			},
			{
				FunctionID:      "train-write",
				ChainID:         3,
				ContractAddress: "0xD6AD037c491C51852E01777f3F8a78947d0F5585",
				BusinessUnit:    "train.book",
			},
			{
				FunctionID:      "flight-write",
				ChainID:         2,
				ContractAddress: "0x8ee15B395f6c18eFECbde6806507637499693D23",
				BusinessUnit:    "flight.book",
			},
		},
		Operations: []ManifestOperation{
			{ID: 1, Step: 1, FunctionID: "hotel-write"},
			{ID: 2, Step: 2, FunctionID: "train-write"},
			{ID: 3, Step: 3, FunctionID: "flight-write"},
		},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(manifestPath, raw, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	cfg := &config.Config{
		Protocol: "atom",
		Chains: map[string]config.ChainConfig{
			"bc1": {ChainID: 1},
			"bc2": {ChainID: 2},
			"bc3": {ChainID: 3},
		},
		Proof: config.ProofConfig{MaxRetry: 3},
		Relayer: config.RelayerConfig{
			PrivateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		},
		Atom: config.AtomConfig{WriteManifest: manifestPath},
	}

	server, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	var invokeID [32]byte
	invokeID[31] = 4
	user := common.HexToAddress("0x71562b71999873DB5b286dF957af199Ec94617F7")
	actions, err := server.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol: protocolcommon.ProtocolAtom,
		Name:     "WriteOnlyInvocationRequested",
		TxID:     "0xdepth4",
		Args: map[string]any{
			"invokeId":           invokeID,
			"user":               user,
			"numRooms":           bigIntPtr(1),
			"numOutboundTickets": bigIntPtr(1),
			"numReturnTickets":   bigIntPtr(1),
		},
	})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	assertSingleDest(t, actions, "0xE1866ebc74355F8E62383957bDd0eD26F47f88e1")

	actions, err = server.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:    protocolcommon.ProtocolAtom,
		ChainName:   "bc2",
		Name:        "AtomHotelLocked",
		TxID:        "0xdepth4-hotel",
		BlockNumber: 10,
		Args: map[string]any{
			"invokeId": invokeID,
		},
	})
	if err != nil {
		t.Fatalf("Handle hotel locked: %v", err)
	}
	assertContainsDest(t, actions, "0xD6AD037c491C51852E01777f3F8a78947d0F5585")

	actions, err = server.Handle(context.Background(), protocolcommon.NormalizedEvent{
		Protocol:    protocolcommon.ProtocolAtom,
		ChainName:   "bc3",
		Name:        "AtomTrainLocked",
		TxID:        "0xdepth4-train",
		BlockNumber: 11,
		Args: map[string]any{
			"invokeId": invokeID,
		},
	})
	if err != nil {
		t.Fatalf("Handle train locked: %v", err)
	}
	assertContainsDest(t, actions, "0x8ee15B395f6c18eFECbde6806507637499693D23")
}

func bigIntPtr(v int64) *big.Int {
	return big.NewInt(v)
}

func assertSingleDest(t *testing.T, actions []protocolcommon.Action, want string) {
	t.Helper()
	if len(actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(actions))
	}
	if strings.ToLower(actions[0].DestContract.Hex()) != strings.ToLower(want) {
		t.Fatalf("expected action for %s, got %s", want, actions[0].DestContract.Hex())
	}
}

func assertContainsDest(t *testing.T, actions []protocolcommon.Action, want string) {
	t.Helper()
	for _, action := range actions {
		if strings.ToLower(action.DestContract.Hex()) == strings.ToLower(want) {
			return
		}
	}
	t.Fatalf("missing action for %s", want)
}
