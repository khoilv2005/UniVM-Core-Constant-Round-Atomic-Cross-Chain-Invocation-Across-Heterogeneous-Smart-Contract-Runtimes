package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	substrateproof "github.com/xsmart/relayer/internal/proof/substrate"
)

type WASMClient struct {
	ChainName       string
	ChainID         uint64
	RPCURL          string
	WSURL           string
	MetadataPath    string
	AccountEndpoint string
	SubmitterURI    string
	FinalityBlocks  uint64
	EvidenceMode    string
	RequireProof    bool
	httpClient      *http.Client

	mu          sync.Mutex
	nextBlock   uint64
	pending     map[common.Hash]wasmPendingEvent
	subscribers map[uint64]wasmSubscriber
	subSeq      uint64
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

type chainHeader struct {
	Number string `json:"number"`
}

type wasmInvokeEnvelope struct {
	Version  int            `json:"version"`
	Contract string         `json:"contract"`
	Message  string         `json:"message"`
	Args     map[string]any `json:"args"`
}

type wasmNativeSubmitRequest struct {
	Endpoint string             `json:"endpoint"`
	Envelope wasmInvokeEnvelope `json:"envelope"`
}

type wasmNativeSubmitResponse struct {
	OK          bool   `json:"ok"`
	TxHash      string `json:"txHash"`
	BlockNumber uint64 `json:"blockNumber"`
	Error       string `json:"error"`
}

type wasmSyntheticEvent struct {
	Endpoint string
	Name     string
	Args     map[string]any
}

type wasmPendingEvent struct {
	Event       wasmSyntheticEvent
	BlockNumber uint64
	TxRef       string
}

type wasmSubscriber struct {
	filter SubscribeFilter
	sink   chan<- NormalizedEvent
}

func NewWASMClient(chainName string, chainID uint64, rpcURL, wsURL, metadataPath, accountEndpoint, submitterURI string, finalityBlocks uint64) *WASMClient {
	if strings.TrimSpace(submitterURI) == "" {
		submitterURI = "//Alice"
	}
	if finalityBlocks == 0 {
		finalityBlocks = 1
	}
	return &WASMClient{
		ChainName:       chainName,
		ChainID:         chainID,
		RPCURL:          rpcURL,
		WSURL:           wsURL,
		MetadataPath:    metadataPath,
		AccountEndpoint: accountEndpoint,
		SubmitterURI:    submitterURI,
		FinalityBlocks:  finalityBlocks,
		EvidenceMode:    "trusted_normalized",
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
		pending:     map[common.Hash]wasmPendingEvent{},
		subscribers: map[uint64]wasmSubscriber{},
	}
}

func (c *WASMClient) SetEvidenceMode(mode string, requireProof bool) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "verified" || mode == "verified_adapter" || mode == "verified-adapter" || mode == "component-verified" || mode == "component_verified_adapter" {
		mode = "component_verified"
	}
	if mode == "zk-substrate" || mode == "substrate_proof" || mode == "proof_backed_substrate" {
		mode = "zk_substrate"
	}
	if mode == "zk-both" || mode == "zk_both" || mode == "both" || mode == "proof_backed_both" || mode == "both_proof" {
		mode = "zk_both"
	}
	if mode == "production" || mode == "production-proof" || mode == "production_proof" || mode == "trust_minimized_production" {
		mode = "production_proof"
	}
	if mode == "sp1" || mode == "succinct-sp1" || mode == "succinct_sp1" || mode == "zk_sp1" {
		mode = "succinct_sp1"
	}
	if mode == "risc0" || mode == "risc_zero" || mode == "succinct-risc0" || mode == "succinct_risc0" || mode == "zk_risc0" {
		mode = "succinct_risc0"
	}
	if mode == "" || mode == "trusted" || mode == "trusted_adapter" || mode == "trusted-adapter" {
		mode = "trusted_normalized"
	}
	c.EvidenceMode = mode
	c.RequireProof = requireProof || mode == "component_verified" || mode == "trust_minimized" || mode == "zk_substrate" || mode == "zk_both" || mode == "production_proof" || mode == "succinct_sp1" || mode == "succinct_risc0"
}

func (c *WASMClient) Send(_ context.Context, _ common.Address, _ []byte) (common.Hash, error) {
	return common.Hash{}, fmt.Errorf("wasm transport requires SendEndpoint")
}

func (c *WASMClient) SendEndpoint(ctx context.Context, endpoint string, calldata []byte) (common.Hash, error) {
	if strings.TrimSpace(endpoint) == "" {
		return common.Hash{}, fmt.Errorf("wasm endpoint is required")
	}
	if len(calldata) == 0 {
		return common.Hash{}, fmt.Errorf("wasm SendEndpoint requires calldata")
	}

	if event, ok, err := decodePrototypeEnvelope(endpoint, calldata); err != nil {
		return common.Hash{}, err
	} else if ok {
		if actual, actualErr := c.tryExecutePrototypeEnvelope(ctx, endpoint, calldata); actualErr != nil {
			return common.Hash{}, actualErr
		} else if actual != nil {
			txHash := syntheticTxHash(endpoint, calldata)
			if actualHash, ok := txHashFromRef(actual.TxRef); ok {
				txHash = actualHash
			}
			c.mu.Lock()
			c.pending[txHash] = *actual
			c.mu.Unlock()
			return txHash, nil
		}
		if c.RequireProof {
			return common.Hash{}, fmt.Errorf("wasm component-verified mode requires native execution evidence; synthetic fallback disabled")
		}
		txHash := syntheticTxHash(endpoint, calldata)
		c.mu.Lock()
		c.pending[txHash] = wasmPendingEvent{Event: event}
		c.mu.Unlock()
		return txHash, nil
	}
	return common.Hash{}, fmt.Errorf("wasm SendEndpoint requires supported prototype envelope; raw extrinsic submission is not implemented")
}

func (c *WASMClient) WaitReceipt(ctx context.Context, txHash common.Hash) (*Receipt, error) {
	c.mu.Lock()
	event, ok := c.pending[txHash]
	c.mu.Unlock()
	if ok {
		block := event.BlockNumber
		if block == 0 {
			block = c.bumpSyntheticBlock()
		}
		if err := c.waitForFinality(ctx, block); err != nil {
			return nil, err
		}
		c.emitSyntheticEvent(txHash, block, event.Event)
		c.mu.Lock()
		delete(c.pending, txHash)
		c.mu.Unlock()
		return &Receipt{
			TxHash:      txHash,
			BlockNumber: block,
			GasUsed:     0,
			Success:     true,
			Raw:         nil,
		}, nil
	}
	return nil, fmt.Errorf("wasm receipt wait not implemented yet for tx %s", txHash.Hex())
}

func (c *WASMClient) Subscribe(ctx context.Context, filter SubscribeFilter, sink chan<- NormalizedEvent) error {
	c.mu.Lock()
	id := c.subSeq
	c.subSeq++
	c.subscribers[id] = wasmSubscriber{filter: filter, sink: sink}
	c.mu.Unlock()

	go func() {
		<-ctx.Done()
		c.mu.Lock()
		delete(c.subscribers, id)
		c.mu.Unlock()
	}()
	return nil
}

func (c *WASMClient) Call(_ context.Context, _ common.Address, _ []byte) ([]byte, error) {
	return nil, fmt.Errorf("wasm transport requires CallEndpoint")
}

func (c *WASMClient) CallEndpoint(ctx context.Context, endpoint string, calldata []byte) ([]byte, error) {
	var envelope wasmInvokeEnvelope
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return nil, fmt.Errorf("wasm CallEndpoint envelope decode failed: %w", err)
	}
	return c.runCargoContractCall(ctx, endpoint, envelope, false)
}

func (c *WASMClient) BestBlockNumber(ctx context.Context) (string, error) {
	var header chainHeader
	if err := c.rpc(ctx, "chain_getHeader", []any{}, &header); err == nil && header.Number != "" {
		return header.Number, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprintf("0x%x", c.nextBlock), nil
}

func (c *WASMClient) Close() {}

func (c *WASMClient) tryExecutePrototypeEnvelope(ctx context.Context, endpoint string, calldata []byte) (*wasmPendingEvent, error) {
	var envelope wasmInvokeEnvelope
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return nil, nil
	}
	if strings.TrimSpace(envelope.Message) == "" {
		return nil, nil
	}

	switch envelope.Message {
	case "receive_lock_request", "receive_update_request", "receive_rollback_request", "receive_timeout_rollback",
		"gpact_segment", "gpact_signalling", "gpact_timeout_unlock",
		"atom_lock_do", "atom_unlock", "atom_undo_unlock":
	default:
		return nil, nil
	}
	if err := c.verifyOutboundEVMUpdateProof(endpoint, envelope); err != nil {
		return nil, err
	}

	if adapterURL := strings.TrimSpace(os.Getenv("XSMART_WASM_SUBMITTER_URL")); adapterURL != "" {
		return c.submitViaNativeAdapter(ctx, adapterURL, endpoint, envelope)
	}
	if strings.TrimSpace(c.MetadataPath) == "" {
		return nil, nil
	}
	if _, err := os.Stat(c.MetadataPath); err != nil {
		return nil, nil
	}

	event, err := syntheticEventFromEnvelope(endpoint, envelope)
	if err != nil {
		return nil, err
	}
	executeOut, err := c.runCargoContractCall(ctx, endpoint, envelope, true)
	if err != nil {
		return nil, err
	}
	if actualEvent, actualErr := c.syntheticEventFromActualCall(endpoint, envelope, executeOut); actualErr == nil {
		event = actualEvent
	}
	txRef, block := parseWASMExecutionMeta(executeOut)
	if block == 0 {
		block, _ = c.currentBestBlock(ctx)
	}
	if c.RequireProof {
		if err := c.attachAndVerifyComponentEvidence(&event, endpoint, envelope, block, firstNonEmptyString(txRef, "cargo-contract")); err != nil {
			return nil, err
		}
	}
	return &wasmPendingEvent{
		Event:       event,
		BlockNumber: block,
		TxRef:       txRef,
	}, nil
}

func (c *WASMClient) submitViaNativeAdapter(ctx context.Context, adapterURL, endpoint string, envelope wasmInvokeEnvelope) (*wasmPendingEvent, error) {
	payload, err := json.Marshal(wasmNativeSubmitRequest{
		Endpoint: endpoint,
		Envelope: envelope,
	})
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(adapterURL, "/") + "/invoke"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wasm native adapter submit failed: %w", err)
	}
	defer resp.Body.Close()

	var result wasmNativeSubmitResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("wasm native adapter response decode failed: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !result.OK {
		if strings.TrimSpace(result.Error) == "" {
			result.Error = resp.Status
		}
		return nil, fmt.Errorf("wasm native adapter rejected %s: %s", envelope.Message, result.Error)
	}

	block := result.BlockNumber
	if block == 0 {
		block, _ = c.currentBestBlock(ctx)
	}
	event, err := syntheticEventFromEnvelope(endpoint, envelope)
	if err != nil {
		return nil, err
	}
	if c.RequireProof {
		if err := c.attachAndVerifyComponentEvidence(&event, endpoint, envelope, block, firstNonEmptyString(result.TxHash, adapterURL)); err != nil {
			return nil, err
		}
	}
	return &wasmPendingEvent{
		Event:       event,
		BlockNumber: block,
		TxRef:       result.TxHash,
	}, nil
}

func (c *WASMClient) verifyOutboundEVMUpdateProof(endpoint string, envelope wasmInvokeEnvelope) error {
	if envelope.Message != "receive_update_request" {
		return nil
	}
	if c.EvidenceMode == "production_proof" {
		if err := verifyProductionOutboundEVMUpdateProof(
			envelope.Args["evm_update_proof"],
			"WASM_SUBSTRATE",
			c.ChainName,
			c.ChainID,
			endpoint,
			envelope.Message,
			envelope.Args,
		); err != nil {
			return fmt.Errorf("wasm production_proof outbound EVM light-client verification failed: %w", err)
		}
		return nil
	}
	if c.EvidenceMode != "zk_substrate" && c.EvidenceMode != "zk_both" {
		return nil
	}
	if !verifyOutboundEVMUpdateProof(
		envelope.Args["evm_update_proof"],
		"WASM_SUBSTRATE",
		c.ChainName,
		c.ChainID,
		endpoint,
		envelope.Message,
		envelope.Args,
	) {
		return fmt.Errorf("wasm outbound EVM update proof failed")
	}
	return nil
}

func (c *WASMClient) attachAndVerifyComponentEvidence(event *wasmSyntheticEvent, endpoint string, envelope wasmInvokeEnvelope, block uint64, source string) error {
	if c.EvidenceMode == "succinct_sp1" || c.EvidenceMode == "succinct_risc0" {
		if event == nil || event.Args == nil {
			return fmt.Errorf("wasm %s evidence requires event args", c.EvidenceMode)
		}
		if _, err := attachSuccinctStateImportProof(event.Args, "WASM_SUBSTRATE", c.ChainName, endpoint, c.EvidenceMode); err != nil {
			return fmt.Errorf("wasm %s state-import proof failed: %w", c.EvidenceMode, err)
		}
		return nil
	}
	if c.EvidenceMode == "production_proof" {
		return c.attachAndVerifyProductionEvidence(event, endpoint)
	}
	if event == nil {
		return fmt.Errorf("wasm component-verified evidence requires an event")
	}
	if event.Args == nil {
		event.Args = map[string]any{}
	}
	proof, err := buildComponentEvidence("WASM_SUBSTRATE", c.ChainName, c.ChainID, endpoint, firstNonEmptyString(envelope.Message, event.Name), event.Args, block, source)
	if err != nil {
		return err
	}
	if !verifyComponentEvidence(proof, "WASM_SUBSTRATE", c.ChainName, c.ChainID, endpoint) {
		return fmt.Errorf("wasm component-verified evidence failed local verification")
	}
	event.Args["proof"] = proof
	event.Args["verificationMode"] = "component_verified"
	return nil
}

func (c *WASMClient) attachAndVerifyProductionEvidence(event *wasmSyntheticEvent, endpoint string) error {
	if event == nil {
		return fmt.Errorf("wasm production_proof evidence requires an event")
	}
	if event.Args == nil {
		return fmt.Errorf("wasm production_proof evidence requires event args")
	}
	proofBytes, ok := evidenceBytesFromArgs(event.Args, "production_proof", "substrate_finality_proof", "proof")
	var encodedState []byte
	if !ok {
		var err error
		proofBytes, encodedState, err = buildSubstrateHostProductionFixture(c.ChainName, c.ChainID, endpoint, event.Args, 1)
		if err != nil {
			return fmt.Errorf("wasm production_proof host fixture generation failed: %w", err)
		}
		event.Args["productionProofSource"] = "host_production_fixture"
	} else {
		encodedState, ok = evidenceBytesFromArgs(event.Args, "encoded_state", "lockedState", "locked_state")
		if !ok {
			return fmt.Errorf("wasm production_proof inbound GRANDPA/storage verifier requires encoded state")
		}
	}
	var proof substrateproof.FinalityProof
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		return fmt.Errorf("wasm production_proof GRANDPA proof decode failed: %w", err)
	}
	if proof.Binding.ContractID != "" && proof.Binding.ContractID != endpoint {
		return fmt.Errorf("wasm production_proof contract binding mismatch: got %q want %q", proof.Binding.ContractID, endpoint)
	}
	result, err := substrateproof.VerifyFinalityProof(proof, encodedState)
	if err != nil {
		return fmt.Errorf("wasm production_proof GRANDPA/storage verification failed: %w", err)
	}
	event.Args["proof"] = proofBytes
	event.Args["verificationMode"] = "production_proof"
	event.Args["productionPublicInputHash"] = result.PublicInputHash
	event.Args["productionSignedWeight"] = result.SignedWeight
	event.Args["productionTotalWeight"] = result.TotalWeight
	stateHash := sha256.Sum256(encodedState)
	event.Args["encodedStateHash"] = hex.EncodeToString(stateHash[:])
	return nil
}

func (c *WASMClient) eventFromEnvelope(endpoint string, envelope wasmInvokeEnvelope) (wasmSyntheticEvent, error) {
	event, err := syntheticEventFromEnvelope(endpoint, envelope)
	if err != nil {
		return wasmSyntheticEvent{}, err
	}
	if c.RequireProof {
		if err := c.attachAndVerifyComponentEvidence(&event, endpoint, envelope, 0, "envelope"); err != nil {
			return wasmSyntheticEvent{}, err
		}
	}
	return event, nil
}

func syntheticEventFromEnvelope(endpoint string, envelope wasmInvokeEnvelope) (wasmSyntheticEvent, error) {
	switch envelope.Message {
	case "receive_lock_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainLockResponse",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  common.Address{},
				"lockedState":    []byte{},
				"irHash":         common.Hash{},
				"proof":          []byte{},
			},
		}, nil
	case "receive_update_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainUpdateAck",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  common.Address{},
				"success":        true,
			},
		}, nil
	case "receive_rollback_request", "receive_timeout_rollback":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainRollback",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
			},
		}, nil
	case "gpact_segment":
		txID, err := mapHash32(envelope.Args, "tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		callTreeHash, err := mapHash32(envelope.Args, "call_tree_hash")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "SegmentEvent",
			Args: map[string]any{
				"crosschainTxId": txID,
				"chainId":        new(big.Int).SetUint64(chainID),
				"segmentId":      new(big.Int).SetUint64(segmentID),
				"callTreeHash":   callTreeHash,
				"success":        true,
				"locked":         true,
				"result":         gpactSegmentResultBytes(txID, callTreeHash, chainID, segmentID),
			},
		}, nil
	case "gpact_signalling":
		txID, err := mapHash32(envelope.Args, "tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		commit, err := mapBool(envelope.Args, "commit")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "SignallingEvent",
			Args: map[string]any{
				"crosschainTxId": txID,
				"chainId":        new(big.Int).SetUint64(chainID),
				"segmentId":      new(big.Int).SetUint64(segmentID),
				"commit":         commit,
			},
		}, nil
	case "gpact_timeout_unlock":
		txID, err := mapHash32(envelope.Args, "tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "SignallingEvent",
			Args: map[string]any{
				"crosschainTxId": txID,
				"chainId":        new(big.Int).SetUint64(chainID),
				"segmentId":      new(big.Int).SetUint64(segmentID),
				"commit":         false,
			},
		}, nil
	case "atom_lock_do":
		invokeID, err := mapHash32(envelope.Args, "invoke_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomEventName(envelope.Args, "Locked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	case "atom_unlock":
		invokeID, err := mapHash32(envelope.Args, "invoke_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomEventName(envelope.Args, "Unlocked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	case "atom_undo_unlock":
		invokeID, err := mapHash32(envelope.Args, "invoke_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomEventName(envelope.Args, "UndoUnlocked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	default:
		return wasmSyntheticEvent{}, fmt.Errorf("unsupported wasm message %s", envelope.Message)
	}
}

func (c *WASMClient) runCargoContractCall(ctx context.Context, endpoint string, envelope wasmInvokeEnvelope, execute bool) ([]byte, error) {
	hostDir := filepath.Dir(c.MetadataPath)
	metadataName := filepath.Base(c.MetadataPath)
	callArgs := []string{
		"contract", "call",
		"--contract", endpoint,
		"--message", envelope.Message,
		"--suri", c.SubmitterURI,
		"--url", c.cargoContractURL(),
	}
	if execute {
		callArgs = append(
			callArgs,
			"--skip-confirm",
			"--execute",
			"--skip-dry-run",
			"--gas",
			"500000000000",
			"--proof-size",
			"500000",
		)
	}
	outputTarget := c.MetadataPath
	if c.cargoRunner() == "docker" {
		outputTarget = "/work/" + metadataName
	}
	callArgs = append(callArgs, "--output-json", outputTarget)
	messageArgs, err := wasmEnvelopeArgs(envelope)
	if err != nil {
		return nil, err
	}
	if len(messageArgs) > 0 {
		callArgs = append(callArgs, "--args")
		callArgs = append(callArgs, messageArgs...)
	}

	command := "cargo"
	args := callArgs
	cmdDir := hostDir
	if c.cargoRunner() == "docker" {
		command = "docker"
		args = c.dockerCargoArgs(hostDir, append([]string{"cargo"}, callArgs...))
		cmdDir = ""
	}
	cmd := exec.CommandContext(ctx, command, args...)
	if cmdDir != "" {
		cmd.Dir = cmdDir
	}
	cmd.Env = os.Environ()
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("wasm cargo-contract %s failed: %w\n%s", envelope.Message, err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func (c *WASMClient) cargoRunner() string {
	runner := strings.ToLower(strings.TrimSpace(os.Getenv("XSMART_WASM_RUNNER")))
	switch runner {
	case "docker", "local":
		return runner
	}
	if hasDockerArtifact("container", firstNonEmptyEnv("XSMART_BC2_NODE_CONTAINER", "xsmart-bc2-local")) ||
		hasDockerArtifact("image", firstNonEmptyEnv("XSMART_INK_BUILDER_IMAGE", "xsmart-ink-builder:local")) {
		return "docker"
	}
	if _, err := exec.LookPath("cargo"); err != nil {
		return "docker"
	}
	if strings.TrimSpace(os.Getenv("XSMART_INK_BUILDER_IMAGE")) != "" || strings.TrimSpace(os.Getenv("XSMART_BC2_NODE_CONTAINER")) != "" || strings.TrimSpace(os.Getenv("XSMART_BC2_DOCKER_NETWORK")) != "" {
		return "docker"
	}
	return "local"
}

func (c *WASMClient) dockerCargoArgs(hostDir string, callArgs []string) []string {
	args := []string{
		"run", "--rm",
	}
	if network := strings.TrimSpace(os.Getenv("XSMART_BC2_DOCKER_NETWORK")); network != "" {
		args = append(args, "--network", network)
	} else if wasmDeployMode() == "local" {
		container := firstNonEmptyEnv("XSMART_BC2_NODE_CONTAINER", "xsmart-bc2-local")
		if hasRunningDockerContainer(container) {
			args = append(args, "--network", "container:"+container)
		}
	}
	args = append(args,
		"-v", hostDir+":/work",
		"-w", "/work",
		firstNonEmptyEnv("XSMART_INK_BUILDER_IMAGE", "xsmart-ink-builder:local"),
	)
	args = append(args, callArgs...)
	return args
}

func (c *WASMClient) cargoContractURL() string {
	normalizeRemoteURL := func(url string) string {
		// cargo-contract accepts websocket RPC endpoints. Rewriting a remote
		// ws:// endpoint to http:// makes current cargo-contract reject the call
		// as an insecure URL, which stalls heterogeneous WASM benchmarks.
		return url
	}
	if c.cargoRunner() == "docker" {
		if url := strings.TrimSpace(os.Getenv("XSMART_BC2_DOCKER_WS_URL")); url != "" {
			return normalizeRemoteURL(url)
		}
		containerName := strings.TrimSpace(os.Getenv("XSMART_BC2_NODE_CONTAINER"))
		if wasmDeployMode() == "local" && strings.TrimSpace(os.Getenv("XSMART_BC2_DOCKER_NETWORK")) == "" && containerName == "" {
			containerName = "xsmart-bc2-local"
		}
		if wasmDeployMode() == "local" && strings.TrimSpace(os.Getenv("XSMART_BC2_DOCKER_NETWORK")) == "" && hasRunningDockerContainer(containerName) {
			return "ws://127.0.0.1:9944"
		}
		return normalizeRemoteURL(firstNonEmptyEnv("XSMART_BC2_WS_URL", firstNonEmpty(c.WSURL, c.RPCURL, "ws://127.0.0.1:9944")))
	}
	return normalizeRemoteURL(firstNonEmpty(c.WSURL, c.RPCURL, "ws://127.0.0.1:9944"))
}

func wasmDeployMode() string {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("XSMART_BC2_DEPLOY_MODE")))
	if raw == "prod" || raw == "production" || raw == "remote" {
		return "prod"
	}
	return "local"
}

func (c *WASMClient) syntheticEventFromActualCall(endpoint string, envelope wasmInvokeEnvelope, output []byte) (wasmSyntheticEvent, error) {
	switch envelope.Message {
	case "receive_lock_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		lockedState, irHash, proof, err := parseWASMLockDryRun(output)
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainLockResponse",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  common.Address{},
				"lockedState":    lockedState,
				"irHash":         common.HexToHash(irHash),
				"proof":          proof,
			},
		}, nil
	case "receive_update_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainUpdateAck",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  common.Address{},
				"success":        true,
			},
		}, nil
	case "receive_rollback_request", "receive_timeout_rollback":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, err
		}
		return wasmSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainRollback",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
			},
		}, nil
	default:
		return wasmSyntheticEvent{}, fmt.Errorf("unsupported wasm message %s", envelope.Message)
	}
}

func wasmEnvelopeArgs(envelope wasmInvokeEnvelope) ([]string, error) {
	switch envelope.Message {
	case "receive_lock_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		num, err := mapUint64(envelope.Args, "num")
		if err != nil {
			return nil, err
		}
		timeout, err := mapUint64(envelope.Args, "timeout_blocks")
		if err != nil {
			return nil, err
		}
		return []string{
			strconv.FormatUint(txID, 10),
			strconv.FormatUint(num, 10),
			strconv.FormatUint(timeout, 10),
		}, nil
	case "receive_update_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		newRemain, err := mapUint64(envelope.Args, "new_remain")
		if err != nil {
			return nil, err
		}
		user, ok := envelope.Args["user"].(string)
		if !ok || strings.TrimSpace(user) == "" {
			return nil, fmt.Errorf("wasm envelope missing user")
		}
		num, err := mapUint64(envelope.Args, "num")
		if err != nil {
			return nil, err
		}
		totalCost, err := mapUint64(envelope.Args, "total_cost")
		if err != nil {
			return nil, err
		}
		return []string{
			strconv.FormatUint(txID, 10),
			strconv.FormatUint(newRemain, 10),
			strings.TrimSpace(user),
			strconv.FormatUint(num, 10),
			strconv.FormatUint(totalCost, 10),
		}, nil
	case "receive_rollback_request", "receive_timeout_rollback":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		return []string{strconv.FormatUint(txID, 10)}, nil
	case "gpact_segment":
		txID, err := mapString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		callTreeHash, err := mapString(envelope.Args, "call_tree_hash")
		if err != nil {
			return nil, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		return []string{cargoStringArg(txID), cargoStringArg(callTreeHash), strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10)}, nil
	case "gpact_signalling":
		txID, err := mapString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		callTreeHash, err := mapString(envelope.Args, "call_tree_hash")
		if err != nil {
			return nil, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		commit, err := mapBool(envelope.Args, "commit")
		if err != nil {
			return nil, err
		}
		abortTx, err := mapBool(envelope.Args, "abort_tx")
		if err != nil {
			return nil, err
		}
		return []string{cargoStringArg(txID), cargoStringArg(callTreeHash), strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10), strconv.FormatBool(commit), strconv.FormatBool(abortTx)}, nil
	case "gpact_timeout_unlock":
		txID, err := mapString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		chainID, err := mapUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		return []string{cargoStringArg(txID), strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10)}, nil
	case "atom_lock_do":
		invokeID, err := mapString(envelope.Args, "invoke_id")
		if err != nil {
			return nil, err
		}
		lockHash, err := mapString(envelope.Args, "lock_hash")
		if err != nil {
			return nil, err
		}
		kind, err := mapString(envelope.Args, "kind")
		if err != nil {
			return nil, err
		}
		user, err := mapString(envelope.Args, "user")
		if err != nil {
			return nil, err
		}
		amountA, err := mapUint64(envelope.Args, "amount_a")
		if err != nil {
			return nil, err
		}
		amountB, err := mapUint64(envelope.Args, "amount_b")
		if err != nil {
			return nil, err
		}
		return []string{cargoStringArg(invokeID), cargoStringArg(lockHash), cargoStringArg(kind), cargoStringArg(user), strconv.FormatUint(amountA, 10), strconv.FormatUint(amountB, 10)}, nil
	case "atom_unlock", "atom_undo_unlock":
		invokeID, err := mapString(envelope.Args, "invoke_id")
		if err != nil {
			return nil, err
		}
		hashKey, err := mapString(envelope.Args, "hash_key_hex")
		if err != nil {
			return nil, err
		}
		kind, err := mapString(envelope.Args, "kind")
		if err != nil {
			return nil, err
		}
		return []string{cargoStringArg(invokeID), cargoStringArg(hashKey), cargoStringArg(kind)}, nil
	default:
		return nil, fmt.Errorf("unsupported wasm message %s", envelope.Message)
	}
}

func cargoStringArg(value string) string {
	return strconv.Quote(value)
}

func parseWASMLockDryRun(output []byte) ([]byte, string, []byte, error) {
	var payload map[string]any
	if err := json.Unmarshal(output, &payload); err != nil {
		return nil, "", nil, err
	}
	data, ok := payload["data"]
	if !ok {
		return nil, "", nil, fmt.Errorf("wasm dry-run missing data")
	}
	unwrapped, err := unwrapInkValue(data)
	if err != nil {
		return nil, "", nil, err
	}
	values, ok := unwrapped.([]any)
	if !ok || len(values) != 3 {
		return nil, "", nil, fmt.Errorf("unexpected wasm lock dry-run shape %T", unwrapped)
	}
	lockedState, ok := values[0].([]byte)
	if !ok {
		return nil, "", nil, fmt.Errorf("unexpected lockedState type %T", values[0])
	}
	irHash, ok := values[1].(string)
	if !ok {
		return nil, "", nil, fmt.Errorf("unexpected irHash type %T", values[1])
	}
	proof, ok := values[2].([]byte)
	if !ok {
		return nil, "", nil, fmt.Errorf("unexpected proof type %T", values[2])
	}
	return lockedState, irHash, proof, nil
}

func unwrapInkValue(value any) (any, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return decodeInkValue(value), nil
	}
	tuple, ok := m["Tuple"].(map[string]any)
	if !ok {
		return decodeInkValue(value), nil
	}
	ident, _ := tuple["ident"].(string)
	values, _ := tuple["values"].([]any)
	switch ident {
	case "Ok":
		if len(values) != 1 {
			return nil, fmt.Errorf("unexpected Ok tuple arity %d", len(values))
		}
		return unwrapInkValue(values[0])
	case "Err":
		if len(values) == 0 {
			return nil, fmt.Errorf("ink call returned Err")
		}
		decoded, _ := unwrapInkValue(values[0])
		return nil, fmt.Errorf("ink call returned Err: %v", decoded)
	default:
		return decodeInkValue(value), nil
	}
}

func decodeInkValue(value any) any {
	m, ok := value.(map[string]any)
	if !ok {
		return value
	}
	if raw, ok := m["UInt"]; ok {
		switch v := raw.(type) {
		case float64:
			return uint64(v)
		case string:
			n, err := strconv.ParseUint(v, 10, 64)
			if err == nil {
				return n
			}
		}
	}
	if raw, ok := m["Literal"]; ok {
		if s, ok := raw.(string); ok {
			return s
		}
	}
	if raw, ok := m["Hex"].(map[string]any); ok {
		if s, ok := raw["s"].(string); ok {
			return "0x" + strings.TrimSpace(s)
		}
	}
	if raw, ok := m["Seq"].(map[string]any); ok {
		elems, _ := raw["elems"].([]any)
		bytesOut := make([]byte, 0, len(elems))
		typed := true
		values := make([]any, 0, len(elems))
		for _, elem := range elems {
			decoded := decodeInkValue(elem)
			values = append(values, decoded)
			number, ok := decoded.(uint64)
			if !ok || number > 255 {
				typed = false
				continue
			}
			bytesOut = append(bytesOut, byte(number))
		}
		if typed {
			return bytesOut
		}
		return values
	}
	if raw, ok := m["Tuple"].(map[string]any); ok {
		elems, _ := raw["values"].([]any)
		values := make([]any, 0, len(elems))
		for _, elem := range elems {
			values = append(values, decodeInkValue(elem))
		}
		return values
	}
	return value
}

func firstNonEmptyEnv(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value != "" {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func hasDockerArtifact(kind string, name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return false
	}
	var args []string
	switch kind {
	case "container":
		args = []string{"inspect", name}
	case "image":
		args = []string{"image", "inspect", name}
	default:
		return false
	}
	cmd := exec.Command("docker", args...)
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

func hasRunningDockerContainer(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return false
	}
	cmd := exec.Command("docker", "inspect", "-f", "{{.State.Running}}", name)
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(string(output)), "true")
}

func (c *WASMClient) rpc(ctx context.Context, method string, params any, out any) error {
	if strings.TrimSpace(c.RPCURL) == "" {
		return fmt.Errorf("wasm rpc url is required for %s", c.ChainName)
	}
	payload, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.RPCURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var parsed rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return err
	}
	if parsed.Error != nil {
		return fmt.Errorf("wasm rpc %s failed: %s (%d)", method, parsed.Error.Message, parsed.Error.Code)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(parsed.Result, out)
}

func (c *WASMClient) bumpSyntheticBlock() uint64 {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if best, err := c.BestBlockNumber(ctx); err == nil {
		if block, ok := parseHexUint64(best); ok {
			c.mu.Lock()
			if block >= c.nextBlock {
				c.nextBlock = block + 1
				block = c.nextBlock
			} else {
				c.nextBlock++
				block = c.nextBlock
			}
			c.mu.Unlock()
			return block
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextBlock++
	return c.nextBlock
}

func (c *WASMClient) currentBestBlock(ctx context.Context) (uint64, error) {
	best, err := c.BestBlockNumber(ctx)
	if err != nil {
		return 0, err
	}
	block, ok := parseHexUint64(best)
	if !ok {
		return 0, fmt.Errorf("invalid best block %q", best)
	}
	return block, nil
}

func (c *WASMClient) waitForFinality(ctx context.Context, block uint64) error {
	if c.FinalityBlocks <= 1 || block == 0 {
		return nil
	}
	target := block + c.FinalityBlocks - 1
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		best, err := c.currentBestBlock(ctx)
		if err == nil && best >= target {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (c *WASMClient) emitSyntheticEvent(txHash common.Hash, block uint64, event wasmSyntheticEvent) {
	c.mu.Lock()
	subscribers := make([]wasmSubscriber, 0, len(c.subscribers))
	for _, sub := range c.subscribers {
		subscribers = append(subscribers, sub)
	}
	c.mu.Unlock()

	normalized := NormalizedEvent{
		ChainName:   c.ChainName,
		ChainID:     c.ChainID,
		BlockNumber: block,
		TxHash:      txHash,
		LogIndex:    0,
		ContractRef: event.Endpoint,
		Name:        event.Name,
		Args:        event.Args,
		ReceivedAt:  time.Now().UTC(),
	}
	for _, sub := range subscribers {
		if sub.filter.ChainName != "" && !strings.EqualFold(sub.filter.ChainName, c.ChainName) {
			continue
		}
		select {
		case sub.sink <- normalized:
		default:
		}
	}
}

func decodePrototypeEnvelope(endpoint string, calldata []byte) (wasmSyntheticEvent, bool, error) {
	var envelope wasmInvokeEnvelope
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return wasmSyntheticEvent{}, false, nil
	}
	event := wasmSyntheticEvent{
		Endpoint: endpoint,
		Args:     map[string]any{},
	}
	switch envelope.Message {
	case "gpact_segment", "gpact_signalling", "gpact_timeout_unlock", "atom_lock_do", "atom_unlock", "atom_undo_unlock":
		event, err := syntheticEventFromEnvelope(endpoint, envelope)
		return event, true, err
	}
	switch envelope.Message {
	case "receive_lock_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, false, err
		}
		event.Name = "CrossChainLockResponse"
		event.Args["crossChainTxId"] = new(big.Int).SetUint64(txID)
		event.Args["stateContract"] = common.Address{}
		event.Args["lockedState"] = []byte{}
	case "receive_update_request":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, false, err
		}
		event.Name = "CrossChainUpdateAck"
		event.Args["crossChainTxId"] = new(big.Int).SetUint64(txID)
		event.Args["stateContract"] = common.Address{}
		event.Args["success"] = true
	case "receive_rollback_request", "receive_timeout_rollback":
		txID, err := mapUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return wasmSyntheticEvent{}, false, err
		}
		event.Name = "CrossChainRollback"
		event.Args["crossChainTxId"] = new(big.Int).SetUint64(txID)
	default:
		return wasmSyntheticEvent{}, false, nil
	}
	return event, true, nil
}

func syntheticTxHash(endpoint string, calldata []byte) common.Hash {
	sum := sha256.Sum256(append([]byte(endpoint+"|"), calldata...))
	return common.BytesToHash(sum[:])
}

func txHashFromRef(value string) (common.Hash, bool) {
	trimmed := strings.TrimSpace(value)
	if matched, _ := regexp.MatchString(`^0x[0-9a-fA-F]{64}$`, trimmed); matched {
		return common.HexToHash(trimmed), true
	}
	if trimmed == "" {
		return common.Hash{}, false
	}
	sum := sha256.Sum256([]byte(trimmed))
	return common.BytesToHash(sum[:]), true
}

func parseWASMExecutionMeta(output []byte) (string, uint64) {
	text := strings.TrimSpace(string(output))
	if text == "" {
		return "", 0
	}

	var payload any
	if err := json.Unmarshal(output, &payload); err == nil {
		ref := firstStringForKeys(payload,
			"extrinsic_hash", "extrinsicHash",
			"transaction_hash", "transactionHash",
			"tx_hash", "txHash",
			"extrinsic", "hash",
		)
		block := firstUint64ForKeys(payload,
			"block_number", "blockNumber",
			"best_block", "bestBlock",
			"number", "block",
		)
		if ref != "" || block != 0 {
			return ref, block
		}
	}

	hashPattern := regexp.MustCompile(`0x[0-9a-fA-F]{64}`)
	if match := hashPattern.FindString(text); match != "" {
		return match, parseBlockNumberFromText(text)
	}
	return "", parseBlockNumberFromText(text)
}

func parseBlockNumberFromText(text string) uint64 {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)block(?:_number| number)?["=: ]+(0x[0-9a-fA-F]+|\d+)`),
		regexp.MustCompile(`(?i)best(?:_block| block)?["=: ]+(0x[0-9a-fA-F]+|\d+)`),
	}
	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(text)
		if len(matches) < 2 {
			continue
		}
		if block, ok := parseFlexibleUint64(matches[1]); ok {
			return block
		}
	}
	return 0
}

func firstStringForKeys(value any, keys ...string) string {
	keyset := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		keyset[strings.ToLower(key)] = struct{}{}
	}
	var walk func(any) string
	walk = func(current any) string {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if _, ok := keyset[strings.ToLower(key)]; ok {
					if s, ok := child.(string); ok && strings.TrimSpace(s) != "" {
						return strings.TrimSpace(s)
					}
				}
			}
			for _, child := range typed {
				if found := walk(child); found != "" {
					return found
				}
			}
		case []any:
			for _, child := range typed {
				if found := walk(child); found != "" {
					return found
				}
			}
		}
		return ""
	}
	return walk(value)
}

func firstUint64ForKeys(value any, keys ...string) uint64 {
	keyset := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		keyset[strings.ToLower(key)] = struct{}{}
	}
	var walk func(any) uint64
	walk = func(current any) uint64 {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if _, ok := keyset[strings.ToLower(key)]; ok {
					if n, ok := parseFlexibleUint64Any(child); ok {
						return n
					}
				}
			}
			for _, child := range typed {
				if found := walk(child); found != 0 {
					return found
				}
			}
		case []any:
			for _, child := range typed {
				if found := walk(child); found != 0 {
					return found
				}
			}
		}
		return 0
	}
	return walk(value)
}

func parseFlexibleUint64Any(value any) (uint64, bool) {
	switch typed := value.(type) {
	case string:
		return parseFlexibleUint64(typed)
	case float64:
		return uint64(typed), true
	case int:
		return uint64(typed), true
	case int64:
		return uint64(typed), true
	case uint64:
		return typed, true
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return uint64(n), true
	default:
		return 0, false
	}
}

func parseFlexibleUint64(value string) (uint64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	if strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X") {
		return parseHexUint64(trimmed)
	}
	n, err := strconv.ParseUint(trimmed, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func parseHexUint64(value string) (uint64, bool) {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.TrimPrefix(trimmed, "0x")
	if trimmed == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(trimmed, 16, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func mapUint64(values map[string]any, key string) (uint64, error) {
	value, ok := values[key]
	if !ok {
		return 0, fmt.Errorf("wasm envelope missing %s", key)
	}
	switch v := value.(type) {
	case float64:
		return uint64(v), nil
	case int:
		return uint64(v), nil
	case int64:
		return uint64(v), nil
	case uint64:
		return v, nil
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, err
		}
		return uint64(n), nil
	default:
		return 0, fmt.Errorf("wasm envelope %s has unsupported type %T", key, value)
	}
}

func mapString(values map[string]any, key string) (string, error) {
	value, ok := values[key]
	if !ok {
		return "", fmt.Errorf("wasm envelope missing %s", key)
	}
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return "", fmt.Errorf("wasm envelope %s is empty", key)
		}
		return strings.TrimSpace(v), nil
	default:
		return "", fmt.Errorf("wasm envelope %s has unsupported type %T", key, value)
	}
}

func mapBool(values map[string]any, key string) (bool, error) {
	value, ok := values[key]
	if !ok {
		return false, fmt.Errorf("wasm envelope missing %s", key)
	}
	switch v := value.(type) {
	case bool:
		return v, nil
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(v))
		if err != nil {
			return false, err
		}
		return parsed, nil
	default:
		return false, fmt.Errorf("wasm envelope %s has unsupported type %T", key, value)
	}
}

func mapHash32(values map[string]any, key string) ([32]byte, error) {
	raw, err := mapString(values, key)
	if err != nil {
		return [32]byte{}, err
	}
	hash := common.HexToHash(raw)
	var out [32]byte
	copy(out[:], hash.Bytes())
	return out, nil
}

func atomEventName(args map[string]any, suffix string) string {
	kind, _ := mapString(args, "kind")
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "train":
		return "AtomTrain" + suffix
	case "flight":
		return "AtomFlight" + suffix
	case "taxi":
		return "AtomTaxi" + suffix
	default:
		return "AtomHotel" + suffix
	}
}
