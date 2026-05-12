package substrate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRPCCollectorFetchFinalizedEvidence(t *testing.T) {
	seen := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seen[req.Method]++
		switch req.Method {
		case "chain_getFinalizedHead":
			writeRPCResult(t, w, "0xabc")
		case "chain_getHeader":
			writeRPCResult(t, w, map[string]any{"number": "0x2a", "stateRoot": "0x111"})
		case "grandpa_proveFinality":
			writeRPCResult(t, w, map[string]any{"justification": "0x222"})
		case "state_getReadProof":
			writeRPCResult(t, w, map[string]any{"at": "0xabc", "proof": []string{"0x333"}})
		default:
			t.Fatalf("unexpected method %s", req.Method)
		}
	}))
	defer server.Close()

	got, err := (RPCCollector{URL: server.URL, HTTPClient: server.Client()}).FetchFinalizedEvidence(context.Background(), []string{"0xkey"})
	if err != nil {
		t.Fatalf("FetchFinalizedEvidence failed: %v", err)
	}
	if got.FinalizedHead != "0xabc" {
		t.Fatalf("unexpected finalized head %q", got.FinalizedHead)
	}
	if len(got.Header) == 0 || len(got.FinalityProof) == 0 || len(got.ReadProof) == 0 {
		t.Fatalf("expected raw evidence fields, got %+v", got)
	}
	for _, method := range []string{"chain_getFinalizedHead", "chain_getHeader", "grandpa_proveFinality", "state_getReadProof"} {
		if seen[method] != 1 {
			t.Fatalf("expected one call to %s, got %d", method, seen[method])
		}
	}
}

func TestRPCCollectorRequiresStorageKeys(t *testing.T) {
	_, err := (RPCCollector{URL: "http://127.0.0.1:1"}).FetchFinalizedEvidence(context.Background(), nil)
	if err == nil {
		t.Fatalf("expected missing storage key error")
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
