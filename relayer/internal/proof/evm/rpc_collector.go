package evm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"
)

type RPCCollector struct {
	URL        string
	HTTPClient *http.Client
}

type CollectedUpdateEvidence struct {
	TxHash       string          `json:"tx_hash"`
	Receipt      json.RawMessage `json:"receipt"`
	Block        json.RawMessage `json:"block"`
	BlockHash    string          `json:"block_hash"`
	BlockNumber  uint64          `json:"block_number"`
	ReceiptsRoot string          `json:"receipts_root"`
	StateRoot    string          `json:"state_root"`
	Logs         json.RawMessage `json:"logs"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type receiptFields struct {
	BlockHash   string          `json:"blockHash"`
	BlockNumber string          `json:"blockNumber"`
	Logs        json.RawMessage `json:"logs"`
}

type blockFields struct {
	Hash         string `json:"hash"`
	Number       string `json:"number"`
	ReceiptsRoot string `json:"receiptsRoot"`
	StateRoot    string `json:"stateRoot"`
}

func (c RPCCollector) FetchUpdateEvidence(ctx context.Context, txHash string) (CollectedUpdateEvidence, error) {
	txHash = strings.TrimSpace(txHash)
	if txHash == "" {
		return CollectedUpdateEvidence{}, fmt.Errorf("evm RPC collector requires transaction hash")
	}
	if strings.TrimSpace(c.URL) == "" {
		return CollectedUpdateEvidence{}, fmt.Errorf("evm RPC collector URL is required")
	}
	receiptRaw, err := c.call(ctx, "eth_getTransactionReceipt", []any{txHash})
	if err != nil {
		return CollectedUpdateEvidence{}, err
	}
	var receipt receiptFields
	if err := json.Unmarshal(receiptRaw, &receipt); err != nil {
		return CollectedUpdateEvidence{}, fmt.Errorf("decode EVM receipt: %w", err)
	}
	if strings.TrimSpace(receipt.BlockHash) == "" {
		return CollectedUpdateEvidence{}, fmt.Errorf("EVM receipt has no block hash")
	}
	blockRaw, err := c.call(ctx, "eth_getBlockByHash", []any{receipt.BlockHash, false})
	if err != nil {
		return CollectedUpdateEvidence{}, err
	}
	var block blockFields
	if err := json.Unmarshal(blockRaw, &block); err != nil {
		return CollectedUpdateEvidence{}, fmt.Errorf("decode EVM block: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(block.Hash), strings.TrimSpace(receipt.BlockHash)) {
		return CollectedUpdateEvidence{}, fmt.Errorf("EVM receipt block hash %s does not match block hash %s", receipt.BlockHash, block.Hash)
	}
	blockNumber, err := parseHexUint64(firstNonEmpty(block.Number, receipt.BlockNumber))
	if err != nil {
		return CollectedUpdateEvidence{}, fmt.Errorf("decode EVM block number: %w", err)
	}
	if strings.TrimSpace(block.ReceiptsRoot) == "" || strings.TrimSpace(block.StateRoot) == "" {
		return CollectedUpdateEvidence{}, fmt.Errorf("EVM block is missing receipts/state root")
	}
	return CollectedUpdateEvidence{
		TxHash:       txHash,
		Receipt:      receiptRaw,
		Block:        blockRaw,
		BlockHash:    strings.TrimSpace(block.Hash),
		BlockNumber:  blockNumber,
		ReceiptsRoot: strings.TrimSpace(block.ReceiptsRoot),
		StateRoot:    strings.TrimSpace(block.StateRoot),
		Logs:         receipt.Logs,
	}, nil
}

func (c RPCCollector) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	body, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("EVM RPC %s failed: %w", method, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("EVM RPC %s returned HTTP %d", method, resp.StatusCode)
	}
	var decoded rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode EVM RPC %s response: %w", method, err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("EVM RPC %s error %d: %s", method, decoded.Error.Code, decoded.Error.Message)
	}
	if len(decoded.Result) == 0 || string(decoded.Result) == "null" {
		return nil, fmt.Errorf("EVM RPC %s returned empty result", method)
	}
	return decoded.Result, nil
}

func parseHexUint64(value string) (uint64, error) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "0x"))
	if value == "" {
		return 0, fmt.Errorf("empty hex integer")
	}
	n, ok := new(big.Int).SetString(value, 16)
	if !ok || n.Sign() < 0 || !n.IsUint64() {
		return 0, fmt.Errorf("invalid uint64 hex %q", value)
	}
	return n.Uint64(), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
