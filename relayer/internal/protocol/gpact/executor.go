package gpact

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type bookingRequest struct {
	User            common.Address
	Rooms           uint64
	OutboundTickets uint64
	ReturnTickets   uint64
}

type Executor struct {
	cfg        *config.Config
	manifest   *Manifest
	clients    map[string]*transport.EVMClient
	signerKeys []*ecdsa.PrivateKey

	mu       sync.Mutex
	segments map[string]map[uint64]bool
	results  map[string]map[uint64]common.Hash
	signals  map[string]map[uint64]bool
	cache    map[string]bookingRequest
}

func NewExecutor(cfg *config.Config, clients map[string]*transport.EVMClient) (*Executor, error) {
	manifest, err := LoadManifest(cfg.GPACT.Manifest)
	if err != nil {
		return nil, err
	}
	keys, err := ParseSignerKeys(cfg.GPACT.SignerKeys)
	if err != nil {
		return nil, err
	}
	return &Executor{
		cfg:        cfg,
		manifest:   manifest,
		clients:    clients,
		signerKeys: keys,
		segments:   map[string]map[uint64]bool{},
		results:    map[string]map[uint64]common.Hash{},
		signals:    map[string]map[uint64]bool{},
		cache:      map[string]bookingRequest{},
	}, nil
}

func (e *Executor) Name() protocolcommon.ProtocolName {
	return protocolcommon.ProtocolGPACT
}

func (e *Executor) Handle(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	switch ev.Name {
	case "StartEvent":
		return e.handleStart(ctx, ev)
	case "SegmentEvent":
		return e.handleSegment(ev)
	case "RootEvent":
		return e.handleRoot(ev)
	case "SignallingEvent":
		return e.handleSignalling(ev)
	case "RootTimedOut", "LockTimedOut":
		return e.handleTimeout(ev)
	default:
		return nil, nil
	}
}

func (e *Executor) handleStart(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := protocolcommon.EventArg[[32]byte](ev, "crosschainTxId")
	if !ok {
		return nil, nil
	}
	callTreeHash, ok := protocolcommon.EventArg[[32]byte](ev, "callTreeHash")
	if !ok {
		return nil, nil
	}
	timeoutBlock := uint64(0)
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "timeoutBlock"); ok && v != nil {
		timeoutBlock = v.Uint64()
	}

	req, err := e.loadBookingRequest(ctx, txID)
	if err != nil {
		return nil, err
	}

	e.mu.Lock()
	e.cache[ev.TxID] = req
	e.segments[ev.TxID] = map[uint64]bool{}
	e.results[ev.TxID] = map[uint64]common.Hash{}
	e.signals[ev.TxID] = map[uint64]bool{}
	e.mu.Unlock()

	var actions []protocolcommon.Action
	for _, segment := range e.manifest.Segments {
		action, err := e.segmentAction(ev, txID, callTreeHash, timeoutBlock, segment, req)
		if err != nil {
			return nil, err
		}
		if action == nil {
			continue
		}
		actions = append(actions, *action)
		break
	}
	return actions, nil
}

func (e *Executor) handleSegment(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := protocolcommon.EventArg[[32]byte](ev, "crosschainTxId")
	if !ok {
		return nil, nil
	}
	callTreeHash, ok := protocolcommon.EventArg[[32]byte](ev, "callTreeHash")
	if !ok {
		return nil, nil
	}
	chainIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "chainId")
	if !ok || chainIDBig == nil {
		return nil, nil
	}
	segmentIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "segmentId")
	if !ok || segmentIDBig == nil {
		return nil, nil
	}
	segmentID := segmentIDBig.Uint64()
	result, ok := protocolcommon.EventArg[[]byte](ev, "result")
	if !ok || len(result) == 0 {
		return nil, nil
	}
	resultHash := crypto.Keccak256Hash(result)

	e.mu.Lock()
	seen := e.segments[ev.TxID]
	if seen == nil {
		seen = map[uint64]bool{}
		e.segments[ev.TxID] = seen
	}
	seen[segmentID] = true
	results := e.results[ev.TxID]
	if results == nil {
		results = map[uint64]common.Hash{}
		e.results[ev.TxID] = results
	}
	results[segmentID] = resultHash
	req, okReq := e.cache[ev.TxID]
	nextSegment, hasNext := e.nextPendingSegment(seen)
	allSeen := len(seen) >= len(e.manifest.Segments)
	e.mu.Unlock()
	if !okReq {
		return nil, nil
	}
	if hasNext {
		action, err := e.segmentAction(ev, txID, callTreeHash, 0, nextSegment, req)
		if err != nil {
			return nil, err
		}
		if action == nil {
			return nil, nil
		}
		return []protocolcommon.Action{*action}, nil
	}
	if !allSeen {
		return nil, nil
	}

	var (
		segmentIDs          []uint64
		segmentChainIDs     []uint64
		segmentResultHashes []common.Hash
		segmentSignatures   [][][]byte
	)
	for _, segment := range e.manifest.Segments {
		segmentResultHash := results[segment.SegmentID]
		if segmentResultHash == (common.Hash{}) {
			return nil, fmt.Errorf("missing result hash for GPACT segment %d", segment.SegmentID)
		}
		sigs, err := SignSegmentEvent(e.signerKeys, txID, segment.SegmentID, segment.ChainID, callTreeHash, segmentResultHash)
		if err != nil {
			return nil, err
		}
		segmentIDs = append(segmentIDs, segment.SegmentID)
		segmentChainIDs = append(segmentChainIDs, segment.ChainID)
		segmentResultHashes = append(segmentResultHashes, segmentResultHash)
		segmentSignatures = append(segmentSignatures, sigs)
	}

	rootCallData, err := e.encodeRootCall(req, segmentIDs, segmentResultHashes)
	if err != nil {
		return nil, err
	}
	rootCall, err := NewCallRoot(txID, e.manifest.RootChainID, callTreeHash, gpactAppAddress(e.cfg, "bc1"), rootCallData, segmentIDs, segmentChainIDs, segmentResultHashes, segmentSignatures)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, gpactControlAddress(e.cfg, "bc1"), rootCall, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleRoot(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := protocolcommon.EventArg[[32]byte](ev, "crosschainTxId")
	if !ok {
		return nil, nil
	}
	callTreeHash, ok := protocolcommon.EventArg[[32]byte](ev, "callTreeHash")
	if !ok {
		return nil, nil
	}
	commit, ok := protocolcommon.EventArg[bool](ev, "commit")
	if !ok {
		return nil, nil
	}
	abortTx, ok := protocolcommon.EventArg[bool](ev, "abortTx")
	if !ok {
		return nil, nil
	}

	rootSignatures, err := SignRootEvent(e.signerKeys, txID, e.manifest.RootChainID, callTreeHash, commit, abortTx)
	if err != nil {
		return nil, err
	}

	var actions []protocolcommon.Action
	for _, segment := range e.manifest.Segments {
		destChainKey, destChainID := chainByID(e.cfg, segment.ChainID)
		if destChainKey == "" {
			continue
		}
		chain := e.cfg.Chains[destChainKey]
		destVM := destinationVM(chain.VM)
		if destVM != protocolcommon.DestVMEVM {
			endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), segment.Contract)
			call, err := nonEVMCallSignalling(destVM, endpoint, txID, segment.SegmentID, segment.ChainID, callTreeHash, segment.Contract, commit, abortTx)
			if err != nil {
				return nil, err
			}
			actions = append(actions, protocolcommon.NewEndpointAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, destVM, endpoint, call, e.cfg.Proof.MaxRetry))
			continue
		}
		if !common.IsHexAddress(segment.Contract) {
			return nil, fmt.Errorf("invalid GPACT EVM segment contract %q", segment.Contract)
		}
		call, err := NewCallSignalling(txID, segment.SegmentID, callTreeHash, common.HexToAddress(segment.Contract), commit, abortTx, rootSignatures)
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, gpactControlAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleTimeout(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := protocolcommon.EventArg[[32]byte](ev, "crosschainTxId")
	if !ok {
		return nil, nil
	}
	var actions []protocolcommon.Action
	abortCall, err := NewCallAbortOnTimeout(txID)
	if err != nil {
		return nil, err
	}
	actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, gpactControlAddress(e.cfg, "bc1"), abortCall, e.cfg.Proof.MaxRetry))
	for _, segment := range e.manifest.Segments {
		destChainKey, destChainID := chainByID(e.cfg, segment.ChainID)
		if destChainKey == "" {
			continue
		}
		chain := e.cfg.Chains[destChainKey]
		destVM := destinationVM(chain.VM)
		if destVM != protocolcommon.DestVMEVM {
			endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), segment.Contract)
			timeoutCall, err := nonEVMCallTimeoutUnlock(destVM, endpoint, txID, segment.SegmentID, segment.ChainID)
			if err != nil {
				return nil, err
			}
			actions = append(actions, protocolcommon.NewEndpointAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, destVM, endpoint, timeoutCall, e.cfg.Proof.MaxRetry))
			continue
		}
		if !common.IsHexAddress(segment.Contract) {
			return nil, fmt.Errorf("invalid GPACT EVM segment contract %q", segment.Contract)
		}
		timeoutCall, err := NewCallGpactTimeoutUnlock(txID, common.HexToAddress(segment.Contract))
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, gpactControlAddress(e.cfg, destChainKey), timeoutCall, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleSignalling(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := protocolcommon.EventArg[[32]byte](ev, "crosschainTxId")
	if !ok {
		return nil, nil
	}
	chainIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "chainId")
	if !ok || chainIDBig == nil {
		return nil, nil
	}
	chainID := chainIDBig.Uint64()
	segmentIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "segmentId")
	if !ok || segmentIDBig == nil {
		return nil, nil
	}
	segmentID := segmentIDBig.Uint64()

	e.mu.Lock()
	seen := e.signals[ev.TxID]
	if seen == nil {
		seen = map[uint64]bool{}
		e.signals[ev.TxID] = seen
	}
	seen[segmentID] = true
	allSeen := len(seen) >= len(e.manifest.Segments)
	e.mu.Unlock()
	_ = chainID
	if !allSeen {
		return nil, nil
	}

	call, err := NewCallCompleteExecution(txID)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, gpactControlAddress(e.cfg, "bc1"), call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) nextPendingSegment(seen map[uint64]bool) (SegmentNode, bool) {
	for _, segment := range e.manifest.Segments {
		if !seen[segment.SegmentID] {
			return segment, true
		}
	}
	return SegmentNode{}, false
}

func (e *Executor) segmentAction(ev protocolcommon.NormalizedEvent, txID [32]byte, callTreeHash [32]byte, timeoutBlock uint64, segment SegmentNode, req bookingRequest) (*protocolcommon.Action, error) {
	destChainKey, destChainID := chainByID(e.cfg, segment.ChainID)
	if destChainKey == "" {
		return nil, nil
	}
	callData, err := e.encodeSegmentCall(segment, req)
	if err != nil {
		return nil, err
	}
	chain := e.cfg.Chains[destChainKey]
	destVM := destinationVM(chain.VM)
	if destVM != protocolcommon.DestVMEVM {
		endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), segment.Contract)
		if endpoint == "" {
			return nil, fmt.Errorf("missing GPACT endpoint for %s segment %d", destChainKey, segment.SegmentID)
		}
		call, err := nonEVMCallSegment(destVM, endpoint, txID, segment.SegmentID, segment.ChainID, callTreeHash, segment.Contract, timeoutBlock)
		if err != nil {
			return nil, err
		}
		_ = callData
		action := protocolcommon.NewEndpointAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, destVM, endpoint, call, e.cfg.Proof.MaxRetry)
		return &action, nil
	}
	if !common.IsHexAddress(segment.Contract) {
		return nil, fmt.Errorf("invalid GPACT EVM segment contract %q", segment.Contract)
	}
	call, err := NewCallSegment(txID, segment.SegmentID, e.manifest.RootChainID, callTreeHash, common.HexToAddress(segment.Contract), callData, timeoutBlock)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, gpactControlAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry)
	return &action, nil
}

func (e *Executor) loadBookingRequest(ctx context.Context, txID [32]byte) (bookingRequest, error) {
	client := e.clients["bc1"]
	if client == nil {
		return bookingRequest{}, fmt.Errorf("missing bc1 client")
	}
	call, err := bookingQueryABI.Pack("getBookingRequest", txID)
	if err != nil {
		return bookingRequest{}, err
	}
	raw, err := client.Call(ctx, gpactAppAddress(e.cfg, "bc1"), call)
	if err != nil {
		return bookingRequest{}, err
	}
	values, err := bookingQueryABI.Unpack("getBookingRequest", raw)
	if err != nil {
		return bookingRequest{}, err
	}
	if len(values) != 5 {
		return bookingRequest{}, fmt.Errorf("unexpected booking request output length %d", len(values))
	}
	exists, _ := values[4].(bool)
	if !exists {
		return bookingRequest{}, fmt.Errorf("booking request not found")
	}
	return bookingRequest{
		User:            values[0].(common.Address),
		Rooms:           values[1].(*big.Int).Uint64(),
		OutboundTickets: values[2].(*big.Int).Uint64(),
		ReturnTickets:   values[3].(*big.Int).Uint64(),
	}, nil
}

func (e *Executor) encodeSegmentCall(segment SegmentNode, req bookingRequest) ([]byte, error) {
	kind := strings.ToLower(strings.TrimSpace(segment.Kind))
	if kind == "" {
		kind = strings.ToLower(strings.TrimSpace(segment.Function))
	}
	switch kind {
	case "hotel":
		args := abi.Arguments{
			{Type: mustSimpleType("address")},
			{Type: mustSimpleType("uint256")},
		}
		return args.Pack(req.User, big.NewInt(int64(req.Rooms)))
	case "train":
		args := abi.Arguments{
			{Type: mustSimpleType("address")},
			{Type: mustSimpleType("uint256")},
			{Type: mustSimpleType("uint256")},
		}
		return args.Pack(req.User, big.NewInt(int64(req.OutboundTickets)), big.NewInt(int64(req.ReturnTickets)))
	case "flight":
		args := abi.Arguments{
			{Type: mustSimpleType("address")},
			{Type: mustSimpleType("uint256")},
		}
		return args.Pack(req.User, big.NewInt(int64(req.Rooms)))
	case "taxi":
		args := abi.Arguments{
			{Type: mustSimpleType("address")},
			{Type: mustSimpleType("uint256")},
		}
		return args.Pack(req.User, big.NewInt(int64(req.Rooms)))
	default:
		switch segment.ChainID {
		case 2:
			args := abi.Arguments{
				{Type: mustSimpleType("address")},
				{Type: mustSimpleType("uint256")},
			}
			return args.Pack(req.User, big.NewInt(int64(req.Rooms)))
		case 3:
			args := abi.Arguments{
				{Type: mustSimpleType("address")},
				{Type: mustSimpleType("uint256")},
				{Type: mustSimpleType("uint256")},
			}
			return args.Pack(req.User, big.NewInt(int64(req.OutboundTickets)), big.NewInt(int64(req.ReturnTickets)))
		default:
			return nil, fmt.Errorf("unsupported GPACT segment kind=%q chain=%d", segment.Kind, segment.ChainID)
		}
	}
}

func (e *Executor) encodeRootCall(req bookingRequest, segmentIDs []uint64, segmentResultHashes []common.Hash) ([]byte, error) {
	args := abi.Arguments{
		{Type: mustSimpleType("address")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("uint256")},
		{Type: mustSimpleType("uint256[]")},
		{Type: mustSimpleType("bytes32[]")},
	}
	ids := make([]*big.Int, 0, len(segmentIDs))
	for _, segmentID := range segmentIDs {
		ids = append(ids, big.NewInt(int64(segmentID)))
	}
	return args.Pack(
		req.User,
		big.NewInt(int64(req.Rooms)),
		big.NewInt(int64(req.OutboundTickets)),
		big.NewInt(int64(req.ReturnTickets)),
		ids,
		segmentResultHashes,
	)
}

var bookingQueryABI = mustABI(`[
  {"inputs":[{"internalType":"bytes32","name":"crosschainTxId","type":"bytes32"}],"name":"getBookingRequest","outputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"uint256","name":"rooms","type":"uint256"},{"internalType":"uint256","name":"outboundTickets","type":"uint256"},{"internalType":"uint256","name":"returnTickets","type":"uint256"},{"internalType":"bool","name":"exists","type":"bool"}],"stateMutability":"view","type":"function"}
]`)

func mustSimpleType(kind string) abi.Type {
	typ, err := abi.NewType(kind, "", nil)
	if err != nil {
		panic(err)
	}
	return typ
}

func chainByID(cfg *config.Config, chainID uint64) (string, uint64) {
	for key, chain := range cfg.Chains {
		if chain.ChainID == chainID {
			return key, chain.ChainID
		}
	}
	return "", 0
}

func gpactControlAddress(cfg *config.Config, chainKey string) common.Address {
	if entry, ok := cfg.Contracts.GPACT[chainKey]; ok && common.IsHexAddress(entry.GPACTControl) {
		return common.HexToAddress(entry.GPACTControl)
	}
	return common.HexToAddress(cfg.Chains[chainKey].GPACTControlAddress)
}

func gpactAppAddress(cfg *config.Config, chainKey string) common.Address {
	if entry, ok := cfg.Contracts.GPACT[chainKey]; ok && common.IsHexAddress(entry.GPACTApp) {
		return common.HexToAddress(entry.GPACTApp)
	}
	return common.HexToAddress(cfg.Chains[chainKey].GPACTAppAddress)
}

func destinationVM(raw string) protocolcommon.DestinationVM {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "wasm":
		return protocolcommon.DestVMWASM
	case "fabric":
		return protocolcommon.DestVMFabric
	default:
		return protocolcommon.DestVMEVM
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func nonEVMCallSegment(destVM protocolcommon.DestinationVM, endpoint string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, timeoutBlocks uint64) ([]byte, error) {
	switch destVM {
	case protocolcommon.DestVMWASM:
		return NewWASMCallSegment(endpoint, txID, segmentID, chainID, callTreeHash, app, timeoutBlocks)
	case protocolcommon.DestVMFabric:
		return NewFabricCallSegment(endpoint, txID, segmentID, chainID, callTreeHash, app, timeoutBlocks)
	default:
		return nil, fmt.Errorf("unsupported GPACT endpoint VM %s", destVM)
	}
}

func nonEVMCallSignalling(destVM protocolcommon.DestinationVM, endpoint string, txID [32]byte, segmentID uint64, chainID uint64, callTreeHash [32]byte, app string, commit bool, abortTx bool) ([]byte, error) {
	switch destVM {
	case protocolcommon.DestVMWASM:
		return NewWASMCallSignalling(endpoint, txID, segmentID, chainID, callTreeHash, app, commit, abortTx)
	case protocolcommon.DestVMFabric:
		return NewFabricCallSignalling(endpoint, txID, segmentID, chainID, callTreeHash, app, commit, abortTx)
	default:
		return nil, fmt.Errorf("unsupported GPACT endpoint VM %s", destVM)
	}
}

func nonEVMCallTimeoutUnlock(destVM protocolcommon.DestinationVM, endpoint string, txID [32]byte, segmentID uint64, chainID uint64) ([]byte, error) {
	switch destVM {
	case protocolcommon.DestVMWASM:
		return NewWASMCallTimeoutUnlock(endpoint, txID, segmentID, chainID)
	case protocolcommon.DestVMFabric:
		return NewFabricCallTimeoutUnlock(endpoint, txID, segmentID, chainID)
	default:
		return nil, fmt.Errorf("unsupported GPACT endpoint VM %s", destVM)
	}
}
