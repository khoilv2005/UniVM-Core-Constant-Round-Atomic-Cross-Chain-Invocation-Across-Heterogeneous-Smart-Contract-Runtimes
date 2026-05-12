package substrate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type RPCCollector struct {
	URL        string
	HTTPClient *http.Client
}

type CollectedEvidence struct {
	FinalizedHead string          `json:"finalized_head"`
	Header        json.RawMessage `json:"header"`
	FinalityProof json.RawMessage `json:"finality_proof"`
	ReadProof     json.RawMessage `json:"read_proof"`
	StorageKeys   []string        `json:"storage_keys"`
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

func (c RPCCollector) FetchFinalizedEvidence(ctx context.Context, storageKeys []string) (CollectedEvidence, error) {
	if strings.TrimSpace(c.URL) == "" {
		return CollectedEvidence{}, fmt.Errorf("substrate RPC collector URL is required")
	}
	if len(storageKeys) == 0 {
		return CollectedEvidence{}, fmt.Errorf("substrate RPC collector requires at least one storage key")
	}
	headRaw, err := c.call(ctx, "chain_getFinalizedHead", []any{})
	if err != nil {
		return CollectedEvidence{}, err
	}
	var head string
	if err := json.Unmarshal(headRaw, &head); err != nil {
		return CollectedEvidence{}, fmt.Errorf("decode finalized head: %w", err)
	}
	if strings.TrimSpace(head) == "" {
		return CollectedEvidence{}, fmt.Errorf("substrate RPC finalized head is empty")
	}
	header, err := c.call(ctx, "chain_getHeader", []any{head})
	if err != nil {
		return CollectedEvidence{}, err
	}
	finalityProof, err := c.call(ctx, "grandpa_proveFinality", []any{head})
	if err != nil {
		return CollectedEvidence{}, err
	}
	readProof, err := c.call(ctx, "state_getReadProof", []any{storageKeys, head})
	if err != nil {
		return CollectedEvidence{}, err
	}
	return CollectedEvidence{
		FinalizedHead: strings.TrimSpace(head),
		Header:        header,
		FinalityProof: finalityProof,
		ReadProof:     readProof,
		StorageKeys:   append([]string(nil), storageKeys...),
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
		return nil, fmt.Errorf("substrate RPC %s failed: %w", method, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("substrate RPC %s returned HTTP %d", method, resp.StatusCode)
	}
	var decoded rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode substrate RPC %s response: %w", method, err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("substrate RPC %s error %d: %s", method, decoded.Error.Code, decoded.Error.Message)
	}
	if len(decoded.Result) == 0 {
		return nil, fmt.Errorf("substrate RPC %s returned empty result", method)
	}
	return decoded.Result, nil
}
