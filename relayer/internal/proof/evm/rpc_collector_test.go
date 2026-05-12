package evm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRPCCollectorFetchUpdateEvidence(t *testing.T) {
	seen := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seen[req.Method]++
		switch req.Method {
		case "eth_getTransactionReceipt":
			writeRPCResult(t, w, map[string]any{
				"blockHash":   "0xabc",
				"blockNumber": "0x2a",
				"logs":        []any{map[string]any{"address": "0x1"}},
			})
		case "eth_getBlockByHash":
			writeRPCResult(t, w, map[string]any{
				"hash":         "0xabc",
				"number":       "0x2a",
				"receiptsRoot": "0x111",
				"stateRoot":    "0x222",
			})
		default:
			t.Fatalf("unexpected method %s", req.Method)
		}
	}))
	defer server.Close()

	got, err := (RPCCollector{URL: server.URL, HTTPClient: server.Client()}).FetchUpdateEvidence(context.Background(), "0xtx")
	if err != nil {
		t.Fatalf("FetchUpdateEvidence failed: %v", err)
	}
	if got.BlockHash != "0xabc" || got.BlockNumber != 42 || got.ReceiptsRoot != "0x111" || got.StateRoot != "0x222" {
		t.Fatalf("unexpected collected evidence: %+v", got)
	}
	if len(got.Receipt) == 0 || len(got.Block) == 0 || len(got.Logs) == 0 {
		t.Fatalf("expected raw receipt/block/logs, got %+v", got)
	}
	for _, method := range []string{"eth_getTransactionReceipt", "eth_getBlockByHash"} {
		if seen[method] != 1 {
			t.Fatalf("expected one call to %s, got %d", method, seen[method])
		}
	}
}

func TestRPCCollectorRejectsReceiptBlockMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		switch req.Method {
		case "eth_getTransactionReceipt":
			writeRPCResult(t, w, map[string]any{"blockHash": "0xabc", "blockNumber": "0x2a", "logs": []any{}})
		case "eth_getBlockByHash":
			writeRPCResult(t, w, map[string]any{"hash": "0xdef", "number": "0x2a", "receiptsRoot": "0x111", "stateRoot": "0x222"})
		default:
			t.Fatalf("unexpected method %s", req.Method)
		}
	}))
	defer server.Close()

	_, err := (RPCCollector{URL: server.URL, HTTPClient: server.Client()}).FetchUpdateEvidence(context.Background(), "0xtx")
	if err == nil {
		t.Fatalf("expected block hash mismatch error")
	}
}

func TestParseHexUint64(t *testing.T) {
	got, err := parseHexUint64("0x2a")
	if err != nil {
		t.Fatalf("parseHexUint64 failed: %v", err)
	}
	if got != 42 {
		t.Fatalf("unexpected value %d", got)
	}
}

func writeRPCResult(t *testing.T, w http.ResponseWriter, result any) {
	t.Helper()
	w.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"result":  result,
	}); err != nil {
		t.Fatalf("write response: %v", err)
	}
}
