package event

import (
	"encoding/json"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/common"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type LogMarker struct{}

func NewLogMarker() *LogMarker {
	return &LogMarker{}
}

func (m *LogMarker) EmitEvent(ev protocolcommon.NormalizedEvent) {
	m.write(map[string]any{
		"ts":       time.Now().UTC().Format(time.RFC3339Nano),
		"protocol": ev.Protocol,
		"tx_id":    ev.TxID,
		"chain":    ev.ChainName,
		"event":    ev.Name,
		"phase":    PhaseFor(ev.Protocol, ev.Name),
		"block":    ev.BlockNumber,
	})
}

func (m *LogMarker) EmitAction(action protocolcommon.Action, txHash common.Hash) {
	m.write(map[string]any{
		"ts":       time.Now().UTC().Format(time.RFC3339Nano),
		"protocol": action.Protocol,
		"tx_id":    action.TxID,
		"chain":    action.DestChain,
		"event":    action.SourceEvent,
		"phase":    "ACTION_TX",
		"detail": map[string]any{
			"action_id": action.ID,
			"tx_hash":   txHash.Hex(),
			"signer":    action.Signer,
		},
	})
}

func (m *LogMarker) EmitReceipt(action protocolcommon.Action, receipt *transport.Receipt) {
	eventName := "ActionReceipt"
	phase := "ACTION_RECEIPT"
	if action.Protocol == protocolcommon.ProtocolGPACT && action.SourceEvent == "SignallingEvent" && action.DestChain == "bc1" {
		eventName = "CompleteExecutionReceipt"
		phase = "FINAL_CONFIRM"
	}
	if action.Protocol == protocolcommon.ProtocolXSmart && action.SourceEvent == "CrossChainUpdateAck" && action.DestChain == "bc1" {
		eventName = "CompleteExecutionReceipt"
		phase = "FINAL_CONFIRM"
	}

	m.write(map[string]any{
		"ts":       time.Now().UTC().Format(time.RFC3339Nano),
		"protocol": action.Protocol,
		"tx_id":    action.TxID,
		"chain":    action.DestChain,
		"event":    eventName,
		"phase":    phase,
		"block":    receipt.BlockNumber,
		"detail": map[string]any{
			"action_id": action.ID,
			"tx_hash":   receipt.TxHash.Hex(),
			"gas_used":  receipt.GasUsed,
			"success":   receipt.Success,
		},
	})
}

func (m *LogMarker) write(v map[string]any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = os.Stderr.Write(append(raw, '\n'))
}
