package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	gatewayclient "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/hash"
	"github.com/hyperledger/fabric-gateway/pkg/identity"
	fabricproof "github.com/xsmart/relayer/internal/proof/fabric"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type FabricGatewayConfig struct {
	Endpoint  string
	Channel   string
	Chaincode string
	MSPID     string
	UserCert  string
	UserKey   string
	TLSCert   string
	PeerName  string
}

type FabricGatewaySubmitResult struct {
	TransactionID string
	BlockNumber   uint64
	Result        []byte
}

type FabricClient struct {
	ChainName    string
	ChainID      uint64
	BaseURL      string
	Gateway      *FabricGatewayConfig
	EvidenceMode string
	RequireProof bool

	httpClient *http.Client

	mu          sync.Mutex
	nextBlock   uint64
	pending     map[common.Hash]fabricSyntheticEvent
	subscribers map[uint64]fabricSubscriber
	subSeq      uint64

	gatewayMu   sync.Mutex
	gatewayConn *fabricGatewayConn
}

type fabricGatewayConn struct {
	grpcConn *grpc.ClientConn
	gateway  *gatewayclient.Gateway
	network  *gatewayclient.Network
}

type fabricInvokeRequest struct {
	Endpoint string         `json:"endpoint"`
	Message  string         `json:"message"`
	Args     map[string]any `json:"args"`
}

type fabricInvokeResponse struct {
	OK          bool              `json:"ok"`
	TxHash      string            `json:"txHash"`
	BlockNumber uint64            `json:"blockNumber"`
	Event       fabricEventRecord `json:"event"`
	Error       string            `json:"error"`
}

type fabricEventRecord struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type fabricProductionEvidenceBundle struct {
	Evidence                fabricproof.Evidence `json:"evidence"`
	ProposalResponsePayload string               `json:"proposal_response_payload"`
	RWSet                   string               `json:"rw_set"`
	EncodedState            string               `json:"encoded_state"`
	MSPRoots                []string             `json:"msp_roots"`
	MSPIntermediates        []string             `json:"msp_intermediates,omitempty"`
}

type fabricHealthResponse struct {
	OK    bool   `json:"ok"`
	Block uint64 `json:"block"`
}

type fabricSyntheticEvent struct {
	Endpoint string
	Name     string
	Args     map[string]any
	Block    uint64
}

type fabricSubscriber struct {
	filter SubscribeFilter
	sink   chan<- NormalizedEvent
}

func NewFabricClient(chainName string, chainID uint64, baseURL string, gatewayCfg *FabricGatewayConfig) *FabricClient {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if gatewayCfg != nil && strings.TrimSpace(gatewayCfg.Endpoint) == "" {
		gatewayCfg = nil
	}
	return &FabricClient{
		ChainName:    chainName,
		ChainID:      chainID,
		BaseURL:      baseURL,
		Gateway:      gatewayCfg,
		EvidenceMode: "trusted_normalized",
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		pending:     map[common.Hash]fabricSyntheticEvent{},
		subscribers: map[uint64]fabricSubscriber{},
	}
}

func (c *FabricClient) SetEvidenceMode(mode string, requireProof bool) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "verified" || mode == "verified_adapter" || mode == "verified-adapter" || mode == "component-verified" || mode == "component_verified_adapter" {
		mode = "component_verified"
	}
	if mode == "zk-fabric" || mode == "fabric_proof" || mode == "proof_backed_fabric" {
		mode = "zk_fabric"
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
	c.RequireProof = requireProof || mode == "component_verified" || mode == "trust_minimized" || mode == "zk_fabric" || mode == "zk_both" || mode == "production_proof" || mode == "succinct_sp1" || mode == "succinct_risc0"
}

func (c *FabricClient) Send(_ context.Context, _ common.Address, _ []byte) (common.Hash, error) {
	return common.Hash{}, fmt.Errorf("fabric transport requires SendEndpoint")
}

func (c *FabricClient) SendEndpoint(ctx context.Context, endpoint string, calldata []byte) (common.Hash, error) {
	if strings.TrimSpace(endpoint) == "" {
		return common.Hash{}, fmt.Errorf("fabric endpoint is required")
	}
	if len(calldata) == 0 {
		return common.Hash{}, fmt.Errorf("fabric SendEndpoint requires calldata")
	}

	var envelope fabricInvokeRequest
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return common.Hash{}, fmt.Errorf("fabric envelope decode failed: %w", err)
	}
	if envelope.Endpoint == "" {
		envelope.Endpoint = endpoint
	}
	if envelope.Message == "" {
		return common.Hash{}, fmt.Errorf("fabric message is required")
	}
	if err := c.verifyOutboundEVMUpdateProof(endpoint, envelope); err != nil {
		return common.Hash{}, err
	}

	if !c.usesGateway() {
		if c.RequireProof {
			return common.Hash{}, fmt.Errorf("fabric component-verified mode requires Fabric Gateway evidence; simulator fallback disabled")
		}
		return c.sendViaSimulator(ctx, endpoint, envelope)
	}
	return c.sendViaGateway(ctx, endpoint, envelope)
}

func (c *FabricClient) WaitReceipt(_ context.Context, txHash common.Hash) (*Receipt, error) {
	c.mu.Lock()
	event, ok := c.pending[txHash]
	if ok {
		delete(c.pending, txHash)
	}
	c.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("fabric receipt wait missing tx %s", txHash.Hex())
	}

	block := event.Block
	if block == 0 {
		block = c.bumpSyntheticBlock()
	}
	c.emitSyntheticEvent(txHash, block, event)
	return &Receipt{
		TxHash:      txHash,
		BlockNumber: block,
		GasUsed:     0,
		Success:     true,
		Raw:         nil,
	}, nil
}

func (c *FabricClient) Subscribe(ctx context.Context, filter SubscribeFilter, sink chan<- NormalizedEvent) error {
	c.mu.Lock()
	id := c.subSeq
	c.subSeq++
	c.subscribers[id] = fabricSubscriber{filter: filter, sink: sink}
	c.mu.Unlock()

	go func() {
		<-ctx.Done()
		c.mu.Lock()
		delete(c.subscribers, id)
		c.mu.Unlock()
	}()
	return nil
}

func (c *FabricClient) Call(_ context.Context, _ common.Address, _ []byte) ([]byte, error) {
	return nil, fmt.Errorf("fabric transport requires CallEndpoint")
}

func (c *FabricClient) CallEndpoint(ctx context.Context, endpoint string, calldata []byte) ([]byte, error) {
	if strings.TrimSpace(endpoint) == "" {
		return nil, fmt.Errorf("fabric endpoint is required")
	}
	if !c.usesGateway() {
		var state any
		if err := c.getJSON(ctx, "/state", &state); err != nil {
			return nil, err
		}
		return json.Marshal(state)
	}

	var envelope fabricInvokeRequest
	if len(calldata) == 0 {
		return nil, fmt.Errorf("fabric CallEndpoint in gateway mode requires envelope calldata")
	}
	if err := json.Unmarshal(calldata, &envelope); err != nil {
		return nil, fmt.Errorf("fabric call envelope decode failed: %w", err)
	}
	if envelope.Endpoint == "" {
		envelope.Endpoint = endpoint
	}
	method, err := fabricMethodName(envelope.Message)
	if err != nil {
		return nil, err
	}
	args, err := fabricArgs(envelope)
	if err != nil {
		return nil, err
	}
	conn, err := c.connectGateway(ctx)
	if err != nil {
		return nil, err
	}
	contract := conn.network.GetContractWithName(c.Gateway.Chaincode, envelope.Endpoint)
	return contract.EvaluateTransaction(method, args...)
}

func (c *FabricClient) BestBlockNumber(ctx context.Context) (string, error) {
	if !c.usesGateway() {
		var health fabricHealthResponse
		if err := c.getJSON(ctx, "/health", &health); err != nil {
			return "", err
		}
		if !health.OK {
			return "", fmt.Errorf("fabric health endpoint returned not-ok")
		}
		return fmt.Sprintf("0x%x", health.Block), nil
	}

	if _, err := c.connectGateway(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.nextBlock == 0 {
		return "0x1", nil
	}
	return fmt.Sprintf("0x%x", c.nextBlock), nil
}

func (c *FabricClient) Close() {
	c.gatewayMu.Lock()
	defer c.gatewayMu.Unlock()
	if c.gatewayConn != nil {
		if c.gatewayConn.gateway != nil {
			c.gatewayConn.gateway.Close()
		}
		if c.gatewayConn.grpcConn != nil {
			_ = c.gatewayConn.grpcConn.Close()
		}
		c.gatewayConn = nil
	}
}

func (c *FabricClient) GatewayEvaluate(ctx context.Context, endpoint string, method string, args ...string) ([]byte, error) {
	if !c.usesGateway() {
		return nil, fmt.Errorf("fabric gateway is not configured")
	}
	conn, err := c.connectGateway(ctx)
	if err != nil {
		return nil, err
	}
	contract := conn.network.GetContractWithName(c.Gateway.Chaincode, endpoint)
	return contract.EvaluateTransaction(method, args...)
}

func (c *FabricClient) GatewaySubmit(ctx context.Context, endpoint string, method string, args ...string) (*FabricGatewaySubmitResult, error) {
	if !c.usesGateway() {
		return nil, fmt.Errorf("fabric gateway is not configured")
	}
	conn, err := c.connectGateway(ctx)
	if err != nil {
		return nil, err
	}
	contract := conn.network.GetContractWithName(c.Gateway.Chaincode, endpoint)
	result, commit, err := contract.SubmitAsync(method, gatewayclient.WithArguments(args...))
	if err != nil {
		return nil, fmt.Errorf("fabric gateway submit %s failed: %w", method, err)
	}
	status, err := commit.Status()
	if err != nil {
		return nil, fmt.Errorf("fabric gateway commit status %s failed: %w", method, err)
	}
	if !status.Successful {
		return nil, fmt.Errorf("fabric gateway commit %s unsuccessful: code=%d tx=%s", method, int32(status.Code), status.TransactionID)
	}
	return &FabricGatewaySubmitResult{
		TransactionID: status.TransactionID,
		BlockNumber:   status.BlockNumber,
		Result:        result,
	}, nil
}

func (c *FabricClient) usesGateway() bool {
	return c.Gateway != nil && strings.TrimSpace(c.Gateway.Endpoint) != ""
}

func (c *FabricClient) verifyOutboundEVMUpdateProof(endpoint string, envelope fabricInvokeRequest) error {
	if envelope.Message != "receive_update_request" {
		return nil
	}
	if c.EvidenceMode == "production_proof" {
		if err := verifyProductionOutboundEVMUpdateProof(
			envelope.Args["evm_update_proof"],
			"FABRIC",
			c.ChainName,
			c.ChainID,
			endpoint,
			envelope.Message,
			envelope.Args,
		); err != nil {
			return fmt.Errorf("fabric production_proof outbound EVM light-client verification failed: %w", err)
		}
		return nil
	}
	if c.EvidenceMode != "zk_fabric" && c.EvidenceMode != "zk_both" {
		return nil
	}
	if !verifyOutboundEVMUpdateProof(
		envelope.Args["evm_update_proof"],
		"FABRIC",
		c.ChainName,
		c.ChainID,
		endpoint,
		envelope.Message,
		envelope.Args,
	) {
		return fmt.Errorf("fabric outbound EVM update proof failed")
	}
	return nil
}

func (c *FabricClient) sendViaSimulator(ctx context.Context, endpoint string, envelope fabricInvokeRequest) (common.Hash, error) {
	var response fabricInvokeResponse
	if err := c.postJSON(ctx, "/invoke", envelope, &response); err != nil {
		return common.Hash{}, err
	}
	if !response.OK {
		return common.Hash{}, fmt.Errorf("fabric invoke failed: %s", response.Error)
	}
	txHashHex := strings.TrimSpace(response.TxHash)
	if txHashHex == "" {
		txHashHex = syntheticFabricTxHash(endpoint, mustJSON(envelope)).Hex()
	}
	txHash := common.HexToHash(txHashHex)

	c.mu.Lock()
	event := fabricSyntheticEvent{
		Endpoint: endpoint,
		Name:     response.Event.Name,
		Args:     normalizeFabricArgs(response.Event.Args),
		Block:    response.BlockNumber,
	}
	if c.RequireProof {
		if err := c.attachAndVerifyComponentEvidence(&event, endpoint, envelope, response.BlockNumber, firstNonEmptyString(txHashHex, c.BaseURL)); err != nil {
			c.mu.Unlock()
			return common.Hash{}, err
		}
	}
	c.pending[txHash] = event
	if response.BlockNumber >= c.nextBlock {
		c.nextBlock = response.BlockNumber
	}
	c.mu.Unlock()
	return txHash, nil
}

func (c *FabricClient) sendViaGateway(ctx context.Context, endpoint string, envelope fabricInvokeRequest) (common.Hash, error) {
	conn, err := c.connectGateway(ctx)
	if err != nil {
		return common.Hash{}, err
	}
	method, err := fabricMethodName(envelope.Message)
	if err != nil {
		return common.Hash{}, err
	}
	args, err := fabricArgs(envelope)
	if err != nil {
		return common.Hash{}, err
	}
	contract := conn.network.GetContractWithName(c.Gateway.Chaincode, envelope.Endpoint)

	result, commit, err := contract.SubmitAsync(method, gatewayclient.WithArguments(args...))
	if err != nil {
		return common.Hash{}, fmt.Errorf("fabric gateway submit %s failed: %w", method, err)
	}
	status, err := commit.Status()
	if err != nil {
		return common.Hash{}, fmt.Errorf("fabric gateway commit status %s failed: %w", method, err)
	}
	if !status.Successful {
		return common.Hash{}, fmt.Errorf("fabric gateway commit %s unsuccessful: code=%d tx=%s", method, int32(status.Code), status.TransactionID)
	}

	txHash := syntheticFabricTxHash(endpoint, []byte(status.TransactionID))
	event, err := c.syntheticGatewayEvent(endpoint, envelope, result)
	if err != nil {
		return common.Hash{}, err
	}
	event.Block = status.BlockNumber
	if c.RequireProof {
		if err := c.attachAndVerifyComponentEvidence(&event, endpoint, envelope, status.BlockNumber, status.TransactionID); err != nil {
			return common.Hash{}, err
		}
	}

	c.mu.Lock()
	c.pending[txHash] = event
	if status.BlockNumber >= c.nextBlock {
		c.nextBlock = status.BlockNumber
	}
	c.mu.Unlock()
	return txHash, nil
}

func (c *FabricClient) attachAndVerifyComponentEvidence(event *fabricSyntheticEvent, endpoint string, envelope fabricInvokeRequest, block uint64, source string) error {
	if c.EvidenceMode == "succinct_sp1" || c.EvidenceMode == "succinct_risc0" {
		if event == nil || event.Args == nil {
			return fmt.Errorf("fabric %s evidence requires event args", c.EvidenceMode)
		}
		if _, err := attachSuccinctStateImportProof(event.Args, "FABRIC", c.ChainName, endpoint, c.EvidenceMode); err != nil {
			return fmt.Errorf("fabric %s state-import proof failed: %w", c.EvidenceMode, err)
		}
		return nil
	}
	if c.EvidenceMode == "production_proof" {
		return c.attachAndVerifyProductionEvidence(event, endpoint)
	}
	if event == nil {
		return fmt.Errorf("fabric component-verified evidence requires an event")
	}
	if event.Args == nil {
		event.Args = map[string]any{}
	}
	proof, err := buildComponentEvidence("FABRIC", c.ChainName, c.ChainID, endpoint, firstNonEmptyString(envelope.Message, event.Name), event.Args, block, source)
	if err != nil {
		return err
	}
	if !verifyComponentEvidence(proof, "FABRIC", c.ChainName, c.ChainID, endpoint) {
		return fmt.Errorf("fabric component-verified evidence failed local verification")
	}
	event.Args["proof"] = "0x" + hex.EncodeToString(proof)
	event.Args["verificationMode"] = "component_verified"
	return nil
}

func (c *FabricClient) attachAndVerifyProductionEvidence(event *fabricSyntheticEvent, endpoint string) error {
	if event == nil {
		return fmt.Errorf("fabric production_proof evidence requires an event")
	}
	if event.Args == nil {
		return fmt.Errorf("fabric production_proof evidence requires event args")
	}
	proofBytes, ok := evidenceBytesFromArgs(event.Args, "production_proof", "fabric_msp_proof", "proof")
	if !ok {
		var err error
		proofBytes, err = buildFabricHostProductionFixture(c.ChainName, c.ChainID, endpoint, event.Args, 1)
		if err != nil {
			return fmt.Errorf("fabric production_proof host fixture generation failed: %w", err)
		}
		event.Args["productionProofSource"] = "host_production_fixture"
	}
	var bundle fabricProductionEvidenceBundle
	if err := json.Unmarshal(proofBytes, &bundle); err != nil {
		return fmt.Errorf("fabric production_proof MSP proof decode failed: %w", err)
	}
	if bundle.Evidence.ChaincodeName != "" && bundle.Evidence.ChaincodeName != endpoint {
		return fmt.Errorf("fabric production_proof chaincode binding mismatch: got %q want %q", bundle.Evidence.ChaincodeName, endpoint)
	}
	proposalPayload, ok := bytesFromEvidenceValue(bundle.ProposalResponsePayload)
	if !ok {
		return fmt.Errorf("fabric production_proof requires proposal response payload")
	}
	rwSet, ok := bytesFromEvidenceValue(bundle.RWSet)
	if !ok {
		return fmt.Errorf("fabric production_proof requires rw set")
	}
	encodedState, ok := bytesFromEvidenceValue(bundle.EncodedState)
	if !ok {
		return fmt.Errorf("fabric production_proof requires encoded state")
	}
	roots, err := certPoolFromPEMList(bundle.MSPRoots)
	if err != nil {
		return fmt.Errorf("fabric production_proof MSP roots rejected: %w", err)
	}
	intermediates, err := certPoolFromPEMList(bundle.MSPIntermediates)
	if err != nil {
		return fmt.Errorf("fabric production_proof MSP intermediates rejected: %w", err)
	}
	result, err := fabricproof.VerifyEvidence(bundle.Evidence, proposalPayload, rwSet, encodedState, fabricproof.VerificationOptions{
		Roots:         roots,
		Intermediates: intermediates,
	})
	if err != nil {
		return fmt.Errorf("fabric production_proof MSP/block verification failed: %w", err)
	}
	event.Args["proof"] = "0x" + hex.EncodeToString(proofBytes)
	event.Args["verificationMode"] = "production_proof"
	event.Args["productionPublicInputHash"] = result.PublicInputHash
	event.Args["productionAcceptedEndorsements"] = result.AcceptedEndorsements
	event.Args["productionAcceptedMSPs"] = result.AcceptedMSPs
	return nil
}

func (c *FabricClient) syntheticGatewayEvent(endpoint string, envelope fabricInvokeRequest, _ []byte) (fabricSyntheticEvent, error) {
	switch envelope.Message {
	case "receive_lock_request":
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainLockResponse",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  endpoint,
				"lockedState":    "",
				"irHash":         "",
				"proof":          "",
			},
		}, nil
	case "receive_update_request":
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainUpdateAck",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  endpoint,
				"success":        true,
			},
		}, nil
	case "receive_rollback_request", "receive_timeout_rollback":
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     "CrossChainRollback",
			Args: map[string]any{
				"crossChainTxId": new(big.Int).SetUint64(txID),
				"stateContract":  endpoint,
			},
		}, nil
	case "gpact_segment":
		txID, err := mapFabricHash32(envelope.Args, "tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		callTreeHash, err := mapFabricHash32(envelope.Args, "call_tree_hash")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
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
		txID, err := mapFabricHash32(envelope.Args, "tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		commit, err := mapFabricBool(envelope.Args, "commit")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
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
		txID, err := mapFabricHash32(envelope.Args, "tx_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
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
		invokeID, err := mapFabricHash32(envelope.Args, "invoke_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomFabricEventName(envelope.Args, "Locked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	case "atom_unlock":
		invokeID, err := mapFabricHash32(envelope.Args, "invoke_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomFabricEventName(envelope.Args, "Unlocked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	case "atom_undo_unlock":
		invokeID, err := mapFabricHash32(envelope.Args, "invoke_id")
		if err != nil {
			return fabricSyntheticEvent{}, err
		}
		return fabricSyntheticEvent{
			Endpoint: endpoint,
			Name:     atomFabricEventName(envelope.Args, "UndoUnlocked"),
			Args: map[string]any{
				"invokeId": invokeID,
			},
		}, nil
	default:
		return fabricSyntheticEvent{}, fmt.Errorf("unsupported fabric gateway message %s", envelope.Message)
	}
}

func (c *FabricClient) connectGateway(ctx context.Context) (*fabricGatewayConn, error) {
	c.gatewayMu.Lock()
	defer c.gatewayMu.Unlock()
	if c.gatewayConn != nil {
		return c.gatewayConn, nil
	}
	if c.Gateway == nil {
		return nil, fmt.Errorf("fabric gateway config is not set")
	}

	id, sign, err := loadFabricIdentity(c.Gateway)
	if err != nil {
		return nil, err
	}
	tlsCreds, err := loadFabricTLS(c.Gateway)
	if err != nil {
		return nil, err
	}

	dialOpts := []grpc.DialOption{
		grpc.WithTransportCredentials(tlsCreds),
		grpc.WithBlock(),
	}
	if authority := strings.TrimSpace(c.Gateway.PeerName); authority != "" {
		dialOpts = append(dialOpts, grpc.WithAuthority(authority))
	}
	conn, err := grpc.DialContext(
		ctx,
		c.Gateway.Endpoint,
		dialOpts...,
	)
	if err != nil {
		return nil, fmt.Errorf("fabric grpc dial %s failed: %w", c.Gateway.Endpoint, err)
	}
	gw, err := gatewayclient.Connect(
		id,
		gatewayclient.WithSign(sign),
		gatewayclient.WithHash(hash.SHA256),
		gatewayclient.WithClientConnection(conn),
		gatewayclient.WithEvaluateTimeout(15*time.Second),
		gatewayclient.WithEndorseTimeout(30*time.Second),
		gatewayclient.WithSubmitTimeout(15*time.Second),
		gatewayclient.WithCommitStatusTimeout(2*time.Minute),
	)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("fabric gateway connect failed: %w", err)
	}
	network := gw.GetNetwork(c.Gateway.Channel)
	if network == nil {
		gw.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("fabric gateway returned nil network for channel %s", c.Gateway.Channel)
	}

	c.gatewayConn = &fabricGatewayConn{
		grpcConn: conn,
		gateway:  gw,
		network:  network,
	}
	return c.gatewayConn, nil
}

func loadFabricIdentity(cfg *FabricGatewayConfig) (*identity.X509Identity, identity.Sign, error) {
	certPem, err := os.ReadFile(cfg.UserCert)
	if err != nil {
		return nil, nil, fmt.Errorf("read fabric user cert: %w", err)
	}
	cert, err := identity.CertificateFromPEM(certPem)
	if err != nil {
		return nil, nil, fmt.Errorf("parse fabric user cert: %w", err)
	}
	id, err := identity.NewX509Identity(cfg.MSPID, cert)
	if err != nil {
		return nil, nil, fmt.Errorf("create fabric x509 identity: %w", err)
	}
	keyPem, err := os.ReadFile(cfg.UserKey)
	if err != nil {
		return nil, nil, fmt.Errorf("read fabric user key: %w", err)
	}
	privateKey, err := identity.PrivateKeyFromPEM(keyPem)
	if err != nil {
		return nil, nil, fmt.Errorf("parse fabric user key: %w", err)
	}
	sign, err := identity.NewPrivateKeySign(privateKey)
	if err != nil {
		return nil, nil, fmt.Errorf("create fabric signer: %w", err)
	}
	return id, sign, nil
}

func loadFabricTLS(cfg *FabricGatewayConfig) (credentials.TransportCredentials, error) {
	tlsPem, err := os.ReadFile(cfg.TLSCert)
	if err != nil {
		return nil, fmt.Errorf("read fabric tls cert: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(tlsPem) {
		return nil, fmt.Errorf("append fabric tls cert failed")
	}
	serverName := strings.TrimSpace(cfg.PeerName)
	if serverName == "" {
		serverName = hostPart(cfg.Endpoint)
	}
	return credentials.NewClientTLSFromCert(pool, serverName), nil
}

func fabricMethodName(message string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(message)) {
	case "receive_lock_request":
		return "ReceiveLockRequest", nil
	case "receive_update_request":
		return "ReceiveUpdateRequest", nil
	case "receive_rollback_request":
		return "ReceiveRollbackRequest", nil
	case "receive_timeout_rollback":
		return "ReceiveTimeoutRollback", nil
	case "gpact_segment":
		return "GPACTSegment", nil
	case "gpact_signalling":
		return "GPACTSignalling", nil
	case "gpact_timeout_unlock":
		return "GPACTTimeoutUnlock", nil
	case "atom_lock_do":
		return "AtomLockDo", nil
	case "atom_unlock":
		return "AtomUnlock", nil
	case "atom_undo_unlock":
		return "AtomUndoUnlock", nil
	default:
		return "", fmt.Errorf("unsupported fabric message %s", message)
	}
}

func fabricArgs(envelope fabricInvokeRequest) ([]string, error) {
	switch strings.ToLower(strings.TrimSpace(envelope.Message)) {
	case "receive_lock_request":
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		num, err := mapFabricUint64(envelope.Args, "num")
		if err != nil {
			return nil, err
		}
		timeout, err := mapFabricUint64(envelope.Args, "timeout_blocks")
		if err != nil {
			return nil, err
		}
		return []string{
			strconv.FormatUint(txID, 10),
			strconv.FormatUint(num, 10),
			strconv.FormatUint(timeout, 10),
		}, nil
	case "receive_update_request":
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		newRemain, err := mapFabricUint64(envelope.Args, "new_remain")
		if err != nil {
			return nil, err
		}
		user, ok := envelope.Args["user"].(string)
		if !ok || strings.TrimSpace(user) == "" {
			return nil, fmt.Errorf("fabric update request missing user")
		}
		num, err := mapFabricUint64(envelope.Args, "num")
		if err != nil {
			return nil, err
		}
		totalCost, err := mapFabricUint64(envelope.Args, "total_cost")
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
		txID, err := mapFabricUint64(envelope.Args, "cross_chain_tx_id")
		if err != nil {
			return nil, err
		}
		return []string{strconv.FormatUint(txID, 10)}, nil
	case "gpact_segment":
		txID, err := mapFabricString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		callTreeHash, err := mapFabricString(envelope.Args, "call_tree_hash")
		if err != nil {
			return nil, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		return []string{txID, callTreeHash, strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10)}, nil
	case "gpact_signalling":
		txID, err := mapFabricString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		callTreeHash, err := mapFabricString(envelope.Args, "call_tree_hash")
		if err != nil {
			return nil, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		commit, err := mapFabricBool(envelope.Args, "commit")
		if err != nil {
			return nil, err
		}
		abortTx, err := mapFabricBool(envelope.Args, "abort_tx")
		if err != nil {
			return nil, err
		}
		return []string{txID, callTreeHash, strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10), strconv.FormatBool(commit), strconv.FormatBool(abortTx)}, nil
	case "gpact_timeout_unlock":
		txID, err := mapFabricString(envelope.Args, "tx_id")
		if err != nil {
			return nil, err
		}
		chainID, err := mapFabricUint64(envelope.Args, "chain_id")
		if err != nil {
			return nil, err
		}
		segmentID, err := mapFabricUint64(envelope.Args, "segment_id")
		if err != nil {
			return nil, err
		}
		return []string{txID, strconv.FormatUint(chainID, 10), strconv.FormatUint(segmentID, 10)}, nil
	case "atom_lock_do":
		invokeID, err := mapFabricString(envelope.Args, "invoke_id")
		if err != nil {
			return nil, err
		}
		lockHash, err := mapFabricString(envelope.Args, "lock_hash")
		if err != nil {
			return nil, err
		}
		kind, err := mapFabricString(envelope.Args, "kind")
		if err != nil {
			return nil, err
		}
		user, err := mapFabricString(envelope.Args, "user")
		if err != nil {
			return nil, err
		}
		amountA, err := mapFabricUint64(envelope.Args, "amount_a")
		if err != nil {
			return nil, err
		}
		amountB, err := mapFabricUint64(envelope.Args, "amount_b")
		if err != nil {
			return nil, err
		}
		return []string{invokeID, lockHash, kind, user, strconv.FormatUint(amountA, 10), strconv.FormatUint(amountB, 10)}, nil
	case "atom_unlock", "atom_undo_unlock":
		invokeID, err := mapFabricString(envelope.Args, "invoke_id")
		if err != nil {
			return nil, err
		}
		hashKey, err := mapFabricString(envelope.Args, "hash_key_hex")
		if err != nil {
			return nil, err
		}
		kind, err := mapFabricString(envelope.Args, "kind")
		if err != nil {
			return nil, err
		}
		return []string{invokeID, hashKey, kind}, nil
	default:
		return nil, fmt.Errorf("unsupported fabric message %s", envelope.Message)
	}
}

func mapFabricUint64(values map[string]any, key string) (uint64, error) {
	value, ok := values[key]
	if !ok {
		return 0, fmt.Errorf("fabric envelope missing %s", key)
	}
	if n, ok := normalizeFabricUint64(value); ok {
		return n, nil
	}
	return 0, fmt.Errorf("fabric envelope %s has unsupported type %T", key, value)
}

func mapFabricString(values map[string]any, key string) (string, error) {
	value, ok := values[key]
	if !ok {
		return "", fmt.Errorf("fabric envelope missing %s", key)
	}
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return "", fmt.Errorf("fabric envelope %s is empty", key)
		}
		return strings.TrimSpace(v), nil
	default:
		return "", fmt.Errorf("fabric envelope %s has unsupported type %T", key, value)
	}
}

func mapFabricBool(values map[string]any, key string) (bool, error) {
	value, ok := values[key]
	if !ok {
		return false, fmt.Errorf("fabric envelope missing %s", key)
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
		return false, fmt.Errorf("fabric envelope %s has unsupported type %T", key, value)
	}
}

func mapFabricHash32(values map[string]any, key string) ([32]byte, error) {
	raw, err := mapFabricString(values, key)
	if err != nil {
		return [32]byte{}, err
	}
	hash := common.HexToHash(raw)
	var out [32]byte
	copy(out[:], hash.Bytes())
	return out, nil
}

func atomFabricEventName(args map[string]any, suffix string) string {
	kind, _ := mapFabricString(args, "kind")
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

func hostPart(endpoint string) string {
	raw := strings.TrimSpace(endpoint)
	if raw == "" {
		return ""
	}
	if idx := strings.Index(raw, ":"); idx >= 0 {
		return raw[:idx]
	}
	return raw
}

func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}

func (c *FabricClient) postJSON(ctx context.Context, path string, payload any, out any) error {
	if strings.TrimSpace(c.BaseURL) == "" {
		return fmt.Errorf("fabric base url is required")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("fabric http %s returned %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *FabricClient) getJSON(ctx context.Context, path string, out any) error {
	if strings.TrimSpace(c.BaseURL) == "" {
		return fmt.Errorf("fabric base url is required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("fabric http %s returned %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *FabricClient) bumpSyntheticBlock() uint64 {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if best, err := c.BestBlockNumber(ctx); err == nil {
		if block, ok := parseHexFabricUint64(best); ok {
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

func (c *FabricClient) emitSyntheticEvent(txHash common.Hash, block uint64, event fabricSyntheticEvent) {
	c.mu.Lock()
	subscribers := make([]fabricSubscriber, 0, len(c.subscribers))
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

func normalizeFabricArgs(values map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range values {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "crosschaintxid":
			if txID, ok := normalizeFabricUint64(value); ok {
				out["crossChainTxId"] = new(big.Int).SetUint64(txID)
				continue
			}
		case "success":
			if b, ok := value.(bool); ok {
				out["success"] = b
				continue
			}
		case "statecontract":
			if s, ok := value.(string); ok {
				out["stateContract"] = s
				continue
			}
		case "lockedstate":
			if s, ok := value.(string); ok {
				out["lockedState"] = s
				continue
			}
		case "irhash":
			if s, ok := value.(string); ok {
				out["irHash"] = s
				continue
			}
		case "proof":
			if s, ok := value.(string); ok {
				out["proof"] = s
				continue
			}
		}
		out[key] = value
	}
	return out
}

func normalizeFabricUint64(value any) (uint64, bool) {
	switch v := value.(type) {
	case float64:
		return uint64(v), true
	case int:
		return uint64(v), true
	case int64:
		return uint64(v), true
	case uint64:
		return v, true
	case json.Number:
		n, err := strconv.ParseUint(v.String(), 10, 64)
		return n, err == nil
	case string:
		if strings.HasPrefix(strings.ToLower(v), "0x") {
			n, err := strconv.ParseUint(strings.TrimPrefix(v, "0x"), 16, 64)
			return n, err == nil
		}
		n, err := strconv.ParseUint(v, 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func syntheticFabricTxHash(endpoint string, calldata []byte) common.Hash {
	sum := sha256.Sum256(append([]byte(endpoint+"|"), calldata...))
	return common.BytesToHash(sum[:])
}

func parseHexFabricUint64(value string) (uint64, bool) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(value, "0x"))
	if trimmed == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(trimmed, 16, 64)
	return n, err == nil
}
