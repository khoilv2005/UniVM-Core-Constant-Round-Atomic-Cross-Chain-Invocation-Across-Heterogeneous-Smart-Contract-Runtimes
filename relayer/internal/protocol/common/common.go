package common

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type ProtocolName string

const (
	ProtocolXSmart     ProtocolName = "xsmart"
	ProtocolIntegrateX ProtocolName = "integratex"
	ProtocolAtom       ProtocolName = "atom"
	ProtocolGPACT      ProtocolName = "gpact"
)

func NormalizeProtocol(raw string) ProtocolName {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(ProtocolXSmart):
		return ProtocolXSmart
	case string(ProtocolIntegrateX):
		return ProtocolIntegrateX
	case string(ProtocolAtom):
		return ProtocolAtom
	case string(ProtocolGPACT):
		return ProtocolGPACT
	default:
		return ProtocolName(strings.ToLower(strings.TrimSpace(raw)))
	}
}

func (p ProtocolName) Valid() bool {
	switch p {
	case ProtocolXSmart, ProtocolIntegrateX, ProtocolAtom, ProtocolGPACT:
		return true
	default:
		return false
	}
}

type ActionStatus string
type DestinationVM string

const (
	ActionPending   ActionStatus = "pending"
	ActionInFlight  ActionStatus = "in_flight"
	ActionDone      ActionStatus = "done"
	ActionFailed    ActionStatus = "failed"
	ActionAbandoned ActionStatus = "abandoned"

	DestVMEVM    DestinationVM = "evm"
	DestVMWASM   DestinationVM = "wasm"
	DestVMFabric DestinationVM = "fabric"
)

type Action struct {
	ID           string            `json:"id"`
	Protocol     ProtocolName      `json:"protocol"`
	TxID         string            `json:"tx_id"`
	SourceEvent  string            `json:"source_event"`
	Signer       string            `json:"signer,omitempty"`
	DestChain    string            `json:"dest_chain"`
	DestChainID  uint64            `json:"dest_chain_id"`
	DestVM       DestinationVM     `json:"dest_vm"`
	DestEndpoint string            `json:"dest_endpoint,omitempty"`
	DestContract ethcommon.Address `json:"dest_contract"`
	Calldata     []byte            `json:"calldata"`
	MaxRetries   int               `json:"max_retries"`
	Attempts     int               `json:"attempts"`
	Status       ActionStatus      `json:"status"`
	CreatedAt    time.Time         `json:"created_at"`
	LastError    string            `json:"last_error,omitempty"`
	LastTxHash   string            `json:"last_tx_hash,omitempty"`
}

func (a Action) WithSigner(addr ethcommon.Address) Action {
	a.Signer = strings.ToLower(addr.Hex())
	return a
}

type NormalizedEvent struct {
	Protocol     ProtocolName      `json:"protocol"`
	ChainName    string            `json:"chain_name"`
	ChainID      uint64            `json:"chain_id"`
	ContractKind string            `json:"contract_kind"`
	ContractAddr ethcommon.Address `json:"contract_addr"`
	Name         string            `json:"name"`
	TxID         string            `json:"tx_id"`
	BlockNumber  uint64            `json:"block_number"`
	TxHash       ethcommon.Hash    `json:"tx_hash"`
	LogIndex     uint              `json:"log_index"`
	Topic0       ethcommon.Hash    `json:"topic0"`
	Args         map[string]any    `json:"args"`
	RawLog       types.Log         `json:"raw_log"`
	ReceivedAt   time.Time         `json:"received_at"`
}

type Handler interface {
	Name() ProtocolName
	Handle(ctx context.Context, ev NormalizedEvent) ([]Action, error)
}

type MultiHandler struct {
	protocol ProtocolName
	parts    []Handler
}

func NewMultiHandler(protocol ProtocolName, parts ...Handler) *MultiHandler {
	return &MultiHandler{protocol: protocol, parts: parts}
}

func (h *MultiHandler) Name() ProtocolName {
	return h.protocol
}

func (h *MultiHandler) Handle(ctx context.Context, ev NormalizedEvent) ([]Action, error) {
	var out []Action
	for _, part := range h.parts {
		actions, err := part.Handle(ctx, ev)
		if err != nil {
			return nil, err
		}
		out = append(out, actions...)
	}
	return out, nil
}

func NewAction(protocol ProtocolName, txID, sourceEvent, destChain string, destChainID uint64, destContract ethcommon.Address, calldata []byte, maxRetries int) Action {
	action := Action{
		Protocol:     protocol,
		TxID:         txID,
		SourceEvent:  sourceEvent,
		DestChain:    destChain,
		DestChainID:  destChainID,
		DestVM:       DestVMEVM,
		DestEndpoint: strings.ToLower(destContract.Hex()),
		DestContract: destContract,
		Calldata:     calldata,
		MaxRetries:   maxRetries,
		Status:       ActionPending,
		CreatedAt:    time.Now().UTC(),
	}
	action.ID = NewActionID(action)
	return action
}

func NewEndpointAction(protocol ProtocolName, txID, sourceEvent, destChain string, destChainID uint64, destVM DestinationVM, destEndpoint string, calldata []byte, maxRetries int) Action {
	action := Action{
		Protocol:     protocol,
		TxID:         txID,
		SourceEvent:  sourceEvent,
		DestChain:    destChain,
		DestChainID:  destChainID,
		DestVM:       destVM,
		DestEndpoint: strings.TrimSpace(destEndpoint),
		Calldata:     calldata,
		MaxRetries:   maxRetries,
		Status:       ActionPending,
		CreatedAt:    time.Now().UTC(),
	}
	action.ID = NewActionID(action)
	return action
}

func NewActionID(action Action) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		string(action.Protocol),
		action.TxID,
		action.SourceEvent,
		strings.ToLower(action.Signer),
		action.DestChain,
		string(action.DestVM),
		strings.ToLower(action.DestEndpoint),
		action.DestContract.Hex(),
		ethcommon.Bytes2Hex(action.Calldata),
	}, "|")))
	return hex.EncodeToString(sum[:])
}

func EventArg[T any](ev NormalizedEvent, key string) (T, bool) {
	value, ok := ev.Args[key]
	if !ok {
		var zero T
		return zero, false
	}
	typed, ok := value.(T)
	if !ok {
		var zero T
		return zero, false
	}
	return typed, true
}
