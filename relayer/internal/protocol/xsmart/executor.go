package xsmart

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type translationCommitment struct {
	Key                common.Hash
	SourceChainID      uint64
	SourceContractHash common.Hash
	IRHash             common.Hash
	Translated         common.Address
	StorageMapRoot     common.Hash
	Verified           bool
	LastVerifyOK       *bool
}

type remoteTarget struct {
	chainKey       string
	chain          config.ChainConfig
	vm             protocolcommon.DestinationVM
	endpoint       string
	contractName   string
	bridgeContract common.Address
	stateContracts []string
	lockNum        uint64
	timeoutBlocks  uint64
	updateTemplate wasmUpdateTemplate
}

type evmChainGroup struct {
	chainKey       string
	chain          config.ChainConfig
	bridgeContract common.Address
	members        []remoteTarget
}

type Executor struct {
	cfg        *config.Config
	manifest   *Manifest
	rootBridge common.Address

	mu               sync.Mutex
	translationByKey map[string]translationCommitment
	translationByEVM map[string]string
	seenLockTx       map[string]uint64
	lockResponses    map[uint64]map[string]bool
	updateAcks       map[uint64]map[string]bool
	executedTx       map[uint64]bool
	completedTx      map[uint64]bool
}

func NewExecutor(cfg *config.Config, rootClient *transport.EVMClient) (*Executor, error) {
	_ = rootClient
	root := cfg.Contracts.XSmart["bc1"]
	if !common.IsHexAddress(root.XBridgingContract) {
		return nil, fmt.Errorf("xsmart root bridge missing on bc1")
	}
	var manifest *Manifest
	if strings.TrimSpace(cfg.XSmart.Manifest) != "" {
		loaded, err := LoadManifest(cfg.XSmart.Manifest)
		if err != nil {
			return nil, err
		}
		if err := loaded.Validate(); err != nil {
			return nil, err
		}
		manifest = loaded
	}
	return &Executor{
		cfg:              cfg,
		manifest:         manifest,
		rootBridge:       common.HexToAddress(root.XBridgingContract),
		translationByKey: map[string]translationCommitment{},
		translationByEVM: map[string]string{},
		seenLockTx:       map[string]uint64{},
		lockResponses:    map[uint64]map[string]bool{},
		updateAcks:       map[uint64]map[string]bool{},
		executedTx:       map[uint64]bool{},
		completedTx:      map[uint64]bool{},
	}, nil
}

func (e *Executor) Name() protocolcommon.ProtocolName {
	return protocolcommon.ProtocolXSmart
}

func (e *Executor) Handle(_ context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	switch ev.Name {
	case "TranslationRegistered":
		return nil, e.handleTranslationRegistered(ev)
	case "TranslationVerified":
		return nil, e.handleTranslationVerified(ev)
	case "CrossChainLockRequested":
		return e.handleCrossChainLockRequested(ev)
	case "CrossChainLockResponse":
		return e.handleCrossChainLockResponse(ev)
	case "CallTreeNodeExecuted":
		return e.handleCallTreeNodeExecuted(ev)
	case "CrossChainUpdateRequested":
		return e.handleCrossChainUpdateRequested(ev)
	case "CrossChainUpdateAck":
		return e.handleCrossChainUpdateAck(ev)
	case "CrossChainRollback", "IntegratedExecutionFailed":
		return e.handleCrossChainRollback(ev)
	case "UnlockFailed":
		return e.handleUnlockFailed(ev)
	default:
		return nil, nil
	}
}

func (e *Executor) handleCrossChainLockRequested(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	expectedServiceID := e.cfg.XSmart.ServiceID
	if e.manifest != nil {
		expectedServiceID = e.manifest.EffectiveServiceID(expectedServiceID)
	}
	serviceID, ok := protocolcommon.EventArg[string](ev, "serviceId")
	if ok && serviceID != "" && serviceID != expectedServiceID {
		return nil, nil
	}

	e.mu.Lock()
	e.seenLockTx[ev.TxID] = txIDBig.Uint64()
	e.seenLockTx[txIDBig.String()] = txIDBig.Uint64()
	e.mu.Unlock()

	return e.newLockActions(ev, txIDBig.Uint64())
}

func (e *Executor) handleCrossChainLockResponse(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	if e.manifest == nil {
		return nil, nil
	}
	stateContract, okState := protocolcommon.EventArg[common.Address](ev, "stateContract")
	targetKey, ok := e.remoteTargetKey(ev.ChainName, stateContract, okState)
	if !ok {
		return nil, nil
	}
	txID, ok := e.crossChainTxID(ev)
	if !ok {
		return nil, nil
	}

	e.mu.Lock()
	if e.executedTx[txID] {
		e.mu.Unlock()
		return nil, nil
	}
	seen := e.lockResponses[txID]
	if seen == nil {
		seen = map[string]bool{}
		e.lockResponses[txID] = seen
	}
	seen[targetKey] = true
	count := len(seen)
	threshold := e.manifest.EffectiveExecuteThreshold()
	if count < threshold {
		e.mu.Unlock()
		return nil, nil
	}
	e.executedTx[txID] = true
	e.mu.Unlock()

	callTreeBlob, err := e.manifest.CallTreeBytes()
	if err != nil {
		return nil, err
	}
	translationKeys, err := e.manifest.TranslationKeyHashes()
	if err != nil {
		return nil, err
	}
	peerIRHashes, err := e.manifest.PeerIRHashList()
	if err != nil {
		return nil, err
	}
	call, err := NewCallExecuteIntegratedCallTree(txID, e.manifest.EffectiveServiceID(e.cfg.XSmart.ServiceID), callTreeBlob, translationKeys, peerIRHashes)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(
		e.Name(),
		ev.TxID,
		ev.Name,
		"bc1",
		e.cfg.Chains["bc1"].ChainID,
		e.rootBridge,
		call,
		e.cfg.Proof.MaxRetry,
	)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleCrossChainUpdateRequested(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	updateData, ok := protocolcommon.EventArg[[][]byte](ev, "updateData")
	if !ok || len(updateData) == 0 {
		return nil, nil
	}
	txID, _ := e.crossChainTxID(ev)
	stateContracts, _ := protocolcommon.EventArg[[]common.Address](ev, "stateContracts")
	var actions []protocolcommon.Action
	for _, group := range e.evmGroups(ev.ChainName) {
		var groupedContracts []common.Address
		var groupedUpdates [][]byte
		for _, target := range group.members {
			filteredContracts, filteredPayloads := target.filterUpdatePayloads(stateContracts, updateData)
			if len(filteredContracts) == 0 {
				continue
			}
			groupedContracts = append(groupedContracts, filteredContracts...)
			groupedUpdates = append(groupedUpdates, filteredPayloads...)
		}
		if len(groupedContracts) == 0 {
			continue
		}
		calldata, err := NewCallReceiveUpdateRequest(txID, groupedContracts, groupedUpdates)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForEVMGroup(ev, group, calldata))
	}
	for _, target := range e.remoteTargets() {
		if strings.EqualFold(ev.ChainName, target.chainKey) {
			continue
		}
		if target.vm == protocolcommon.DestVMEVM {
			continue
		}
		switch target.vm {
		case protocolcommon.DestVMWASM, protocolcommon.DestVMFabric:
			calldata, err := e.newUpdateFromEVMCall(ev, target, updateData[0])
			if err != nil {
				return nil, err
			}
			actions = append(actions, e.newActionForTarget(ev, target, calldata))
		}
	}
	return actions, nil
}

func (e *Executor) handleCrossChainUpdateAck(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	if e.manifest == nil {
		return nil, nil
	}
	stateContract, okState := protocolcommon.EventArg[common.Address](ev, "stateContract")
	targetKey, ok := e.remoteTargetKey(ev.ChainName, stateContract, okState)
	if !ok {
		return nil, nil
	}
	success, ok := protocolcommon.EventArg[bool](ev, "success")
	if !ok || !success {
		return nil, nil
	}
	txID, ok := e.crossChainTxID(ev)
	if !ok {
		return nil, nil
	}

	e.mu.Lock()
	if e.completedTx[txID] {
		e.mu.Unlock()
		return nil, nil
	}
	seen := e.updateAcks[txID]
	if seen == nil {
		seen = map[string]bool{}
		e.updateAcks[txID] = seen
	}
	if seen[targetKey] {
		e.mu.Unlock()
		return nil, nil
	}
	seen[targetKey] = true
	count := len(seen)
	threshold := e.manifest.EffectiveUpdateAckThreshold()
	if count >= threshold {
		e.completedTx[txID] = true
	}
	e.mu.Unlock()

	ackKey := crypto.Keccak256Hash([]byte(targetKey))
	call, err := NewCallRecordUpdateAckAndMaybeComplete(txID, ackKey, success, ev.TxHash)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(
		e.Name(),
		ev.TxID,
		ev.Name,
		"bc1",
		e.cfg.Chains["bc1"].ChainID,
		e.rootBridge,
		call,
		e.cfg.Proof.MaxRetry,
	)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleCallTreeNodeExecuted(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	if e.manifest == nil || !strings.EqualFold(ev.ChainName, "bc1") {
		return nil, nil
	}
	txID, ok := e.crossChainTxID(ev)
	if !ok {
		return nil, nil
	}
	nodeIndexBig, ok := protocolcommon.EventArg[*big.Int](ev, "nodeIndex")
	if !ok || nodeIndexBig == nil || nodeIndexBig.Uint64() != e.manifest.RootNodeIndex {
		return nil, nil
	}
	result, ok := protocolcommon.EventArg[[]byte](ev, "result")
	if !ok || len(result) == 0 {
		return nil, nil
	}
	var actions []protocolcommon.Action
	for _, group := range e.evmGroups(ev.ChainName) {
		calldata, err := e.newUpdateFromRootResultCallForGroup(group, txID, result)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForEVMGroup(ev, group, calldata))
	}
	for _, target := range e.remoteTargets() {
		if strings.EqualFold(ev.ChainName, target.chainKey) || target.vm == protocolcommon.DestVMEVM {
			continue
		}
		calldata, err := e.newUpdateFromRootResultCall(ev, target, txID, result)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForTarget(ev, target, calldata))
	}
	return actions, nil
}

func (e *Executor) handleCrossChainRollback(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txID, ok := e.crossChainTxID(ev)
	if !ok {
		return nil, nil
	}
	return e.newRollbackActions(ev, txID, ev.Name == "IntegratedExecutionFailed")
}

func (e *Executor) handleTranslationRegistered(ev protocolcommon.NormalizedEvent) error {
	key, ok := protocolcommon.EventArg[common.Hash](ev, "key")
	if !ok {
		return nil
	}
	sourceChainIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "sourceChainId")
	if !ok || sourceChainIDBig == nil {
		return nil
	}
	sourceContractHash, ok := protocolcommon.EventArg[common.Hash](ev, "sourceContractHash")
	if !ok {
		return nil
	}
	irHash, ok := protocolcommon.EventArg[common.Hash](ev, "irHash")
	if !ok {
		return nil
	}
	translated, ok := protocolcommon.EventArg[common.Address](ev, "translated")
	if !ok {
		return nil
	}
	storageMapRoot, ok := protocolcommon.EventArg[common.Hash](ev, "storageMapRoot")
	if !ok {
		return nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	entry := translationCommitment{
		Key:                key,
		SourceChainID:      sourceChainIDBig.Uint64(),
		SourceContractHash: sourceContractHash,
		IRHash:             irHash,
		Translated:         translated,
		StorageMapRoot:     storageMapRoot,
	}
	e.translationByKey[key.Hex()] = entry
	e.translationByEVM[translated.Hex()] = key.Hex()
	return nil
}

func (e *Executor) handleTranslationVerified(ev protocolcommon.NormalizedEvent) error {
	key, ok := protocolcommon.EventArg[common.Hash](ev, "key")
	if !ok {
		return nil
	}
	verifyOK, ok := protocolcommon.EventArg[bool](ev, "ok")
	if !ok {
		return nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	entry, exists := e.translationByKey[key.Hex()]
	if !exists {
		entry = translationCommitment{Key: key}
	}
	entry.LastVerifyOK = &verifyOK
	if verifyOK {
		entry.Verified = true
	}
	e.translationByKey[key.Hex()] = entry
	return nil
}

func (e *Executor) handleUnlockFailed(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	target, ok := protocolcommon.EventArg[common.Address](ev, "target")
	if !ok {
		return nil, nil
	}
	call, err := NewCallRetryUnlock(target, txIDBig.Uint64())
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(
		e.Name(),
		ev.TxID,
		ev.Name,
		"bc1",
		e.cfg.Chains["bc1"].ChainID,
		e.rootBridge,
		call,
		e.cfg.Proof.MaxRetry,
	)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) translationForKey(key common.Hash) (translationCommitment, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	entry, ok := e.translationByKey[key.Hex()]
	return entry, ok
}

func (e *Executor) wasmChain() (string, config.ChainConfig) {
	for _, target := range e.remoteTargets() {
		if target.vm == protocolcommon.DestVMWASM {
			return target.chainKey, target.chain
		}
	}
	return "", config.ChainConfig{}
}

func (e *Executor) crossChainTxID(ev protocolcommon.NormalizedEvent) (uint64, bool) {
	if txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId"); ok && txIDBig != nil {
		return txIDBig.Uint64(), true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if txID, ok := e.seenLockTx[ev.TxID]; ok {
		return txID, true
	}
	return 0, false
}

func (e *Executor) remoteTargets() []remoteTarget {
	targets := make([]remoteTarget, 0, 3)
	if e.manifest == nil {
		for chainKey, chain := range e.cfg.Chains {
			if strings.EqualFold(chain.VM, "wasm") && strings.TrimSpace(chain.AccountEndpoint) != "" {
				targets = append(targets, remoteTarget{
					chainKey:       chainKey,
					chain:          chain,
					vm:             protocolcommon.DestVMWASM,
					endpoint:       chain.AccountEndpoint,
					contractName:   "xbridge_bc2",
					stateContracts: []string{chain.AccountEndpoint},
					lockNum:        e.cfg.XSmart.WASMLockNum,
					timeoutBlocks:  e.cfg.XSmart.WASMTimeoutBlocks,
				})
			}
			if strings.EqualFold(chain.VM, "fabric") && strings.TrimSpace(chain.AccountEndpoint) != "" {
				targets = append(targets, remoteTarget{
					chainKey:       chainKey,
					chain:          chain,
					vm:             protocolcommon.DestVMFabric,
					endpoint:       chain.AccountEndpoint,
					contractName:   chain.AccountEndpoint,
					stateContracts: []string{chain.AccountEndpoint},
					lockNum:        e.cfg.XSmart.WASMLockNum,
					timeoutBlocks:  e.cfg.XSmart.WASMTimeoutBlocks,
				})
			}
		}
		sort.SliceStable(targets, func(i, j int) bool { return targets[i].chainKey < targets[j].chainKey })
		return targets
	}
	for _, entry := range e.manifest.TargetList() {
		chainKey := strings.TrimSpace(entry.Chain)
		if chainKey == "" {
			continue
		}
		chain, ok := e.cfg.Chains[chainKey]
		if !ok {
			continue
		}
		vm := protocolcommon.DestinationVM(strings.ToLower(firstNonEmptyString(entry.VM, chain.VM)))
		target := remoteTarget{
			chainKey:       chainKey,
			chain:          chain,
			vm:             vm,
			endpoint:       firstNonEmptyString(entry.Endpoint, chain.AccountEndpoint),
			contractName:   firstNonEmptyString(entry.Contract, chain.AccountEndpoint),
			stateContracts: append([]string(nil), entry.StateContracts...),
			lockNum:        firstNonZero(entry.LockNum, e.cfg.XSmart.WASMLockNum),
			timeoutBlocks:  firstNonZero(entry.TimeoutBlocks, e.cfg.XSmart.WASMTimeoutBlocks),
			updateTemplate: wasmUpdateTemplate{
				Kind:      entry.Update.Kind,
				User:      entry.Update.User,
				Num:       entry.Update.Num,
				TotalCost: entry.Update.TotalCost,
			},
		}
		if common.IsHexAddress(entry.BridgeContract) {
			target.bridgeContract = common.HexToAddress(entry.BridgeContract)
		}
		switch vm {
		case protocolcommon.DestVMEVM:
			if target.bridgeContract == (common.Address{}) {
				continue
			}
			targets = append(targets, target)
		case protocolcommon.DestVMWASM, protocolcommon.DestVMFabric:
			if strings.TrimSpace(target.endpoint) == "" {
				continue
			}
			targets = append(targets, target)
		}
	}
	sort.SliceStable(targets, func(i, j int) bool { return targets[i].chainKey < targets[j].chainKey })
	return targets
}

func (e *Executor) remoteTargetKey(chainName string, stateContract common.Address, hasStateContract bool) (string, bool) {
	for _, target := range e.remoteTargets() {
		if !strings.EqualFold(target.chainKey, chainName) {
			continue
		}
		if hasStateContract {
			for _, raw := range target.stateContracts {
				if common.IsHexAddress(raw) && strings.EqualFold(common.HexToAddress(raw).Hex(), stateContract.Hex()) {
					return strings.ToLower(target.chainKey) + ":" + strings.ToLower(stateContract.Hex()), true
				}
			}
		}
		return strings.ToLower(target.chainKey), true
	}
	return "", false
}

func (e *Executor) buildRemoteActions(ev protocolcommon.NormalizedEvent, builder func(target remoteTarget) ([]byte, error)) ([]protocolcommon.Action, error) {
	var actions []protocolcommon.Action
	for _, target := range e.remoteTargets() {
		if strings.EqualFold(ev.ChainName, target.chainKey) {
			continue
		}
		calldata, err := builder(target)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForTarget(ev, target, calldata))
	}
	return actions, nil
}

func (e *Executor) evmGroups(sourceChain string) []evmChainGroup {
	groupsByChain := make(map[string]*evmChainGroup)
	order := make([]string, 0, 3)
	for _, target := range e.remoteTargets() {
		if target.vm != protocolcommon.DestVMEVM || strings.EqualFold(sourceChain, target.chainKey) {
			continue
		}
		group, ok := groupsByChain[target.chainKey]
		if !ok {
			group = &evmChainGroup{
				chainKey:       target.chainKey,
				chain:          target.chain,
				bridgeContract: target.bridgeContract,
			}
			groupsByChain[target.chainKey] = group
			order = append(order, target.chainKey)
		}
		group.members = append(group.members, target)
	}
	groups := make([]evmChainGroup, 0, len(order))
	for _, chainKey := range order {
		groups = append(groups, *groupsByChain[chainKey])
	}
	return groups
}

func (e *Executor) newLockActions(ev protocolcommon.NormalizedEvent, txID uint64) ([]protocolcommon.Action, error) {
	var actions []protocolcommon.Action
	for _, group := range e.evmGroups(ev.ChainName) {
		calldata, err := e.newLockRequestCallForGroup(group, txID)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForEVMGroup(ev, group, calldata))
	}
	for _, target := range e.remoteTargets() {
		if strings.EqualFold(ev.ChainName, target.chainKey) || target.vm == protocolcommon.DestVMEVM {
			continue
		}
		calldata, err := e.newLockRequestCall(target, txID)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForTarget(ev, target, calldata))
	}
	return actions, nil
}

func (e *Executor) newRollbackActions(ev protocolcommon.NormalizedEvent, txID uint64, timeout bool) ([]protocolcommon.Action, error) {
	var actions []protocolcommon.Action
	for _, group := range e.evmGroups(ev.ChainName) {
		calldata, err := e.newRollbackCallForGroup(group, txID)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForEVMGroup(ev, group, calldata))
	}
	for _, target := range e.remoteTargets() {
		if strings.EqualFold(ev.ChainName, target.chainKey) || target.vm == protocolcommon.DestVMEVM {
			continue
		}
		calldata, err := e.newRollbackCall(target, txID, timeout)
		if err != nil {
			return nil, err
		}
		actions = append(actions, e.newActionForTarget(ev, target, calldata))
	}
	return actions, nil
}

func (e *Executor) newLockRequestCall(target remoteTarget, txID uint64) ([]byte, error) {
	switch target.vm {
	case protocolcommon.DestVMEVM:
		stateContracts, err := target.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		lockArgs := make([][]byte, 0, len(stateContracts))
		for range stateContracts {
			lockArgs = append(lockArgs, encodeStandardLockArgs(txID, target.lockNum, target.timeoutBlocks))
		}
		return NewCallReceiveLockRequest(txID, stateContracts, lockArgs, target.timeoutBlocks)
	case protocolcommon.DestVMWASM:
		return NewWASMCallReceiveLockRequest(target.contractName, txID, target.lockNum, target.timeoutBlocks)
	case protocolcommon.DestVMFabric:
		return NewFabricCallReceiveLockRequest(target.endpoint, txID, target.lockNum, target.timeoutBlocks)
	default:
		return nil, fmt.Errorf("unsupported lock target vm %s", target.vm)
	}
}

func (e *Executor) newLockRequestCallForGroup(group evmChainGroup, txID uint64) ([]byte, error) {
	stateContracts := make([]common.Address, 0, len(group.members))
	lockArgs := make([][]byte, 0, len(group.members))
	for _, member := range group.members {
		memberContracts, err := member.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		for _, stateContract := range memberContracts {
			stateContracts = append(stateContracts, stateContract)
			lockArgs = append(lockArgs, encodeStandardLockArgs(txID, member.lockNum, member.timeoutBlocks))
		}
	}
	return NewCallReceiveLockRequest(txID, stateContracts, lockArgs, firstNonZero(group.members[0].timeoutBlocks, e.cfg.XSmart.WASMTimeoutBlocks))
}

func (e *Executor) newRollbackCall(target remoteTarget, txID uint64, timeout bool) ([]byte, error) {
	switch target.vm {
	case protocolcommon.DestVMEVM:
		stateContracts, err := target.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		return NewCallReceiveRollbackRequest(txID, stateContracts)
	case protocolcommon.DestVMWASM:
		return NewWASMCallReceiveRollbackRequest(target.contractName, txID, timeout)
	case protocolcommon.DestVMFabric:
		return NewFabricCallReceiveRollbackRequest(target.endpoint, txID, timeout)
	default:
		return nil, fmt.Errorf("unsupported rollback target vm %s", target.vm)
	}
}

func (e *Executor) newRollbackCallForGroup(group evmChainGroup, txID uint64) ([]byte, error) {
	stateContracts := make([]common.Address, 0, len(group.members))
	for _, member := range group.members {
		memberContracts, err := member.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		stateContracts = append(stateContracts, memberContracts...)
	}
	return NewCallReceiveRollbackRequest(txID, stateContracts)
}

func (e *Executor) newUpdateFromEVMCall(ev protocolcommon.NormalizedEvent, target remoteTarget, updateData []byte) ([]byte, error) {
	switch target.vm {
	case protocolcommon.DestVMEVM:
		stateContracts, err := target.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		return NewCallReceiveUpdateRequest(0, stateContracts, [][]byte{updateData})
	case protocolcommon.DestVMWASM:
		call, err := NewWASMCallReceiveUpdateRequestFromEVM(target.contractName, updateData)
		if err != nil {
			return nil, err
		}
		return e.attachOutboundUpdateProof(ev, target, call)
	case protocolcommon.DestVMFabric:
		call, err := NewFabricCallReceiveUpdateRequestFromEVM(target.endpoint, updateData)
		if err != nil {
			return nil, err
		}
		return e.attachOutboundUpdateProof(ev, target, call)
	default:
		return nil, fmt.Errorf("unsupported update target vm %s", target.vm)
	}
}

func (e *Executor) newUpdateFromRootResultCall(ev protocolcommon.NormalizedEvent, target remoteTarget, txID uint64, rootResult []byte) ([]byte, error) {
	switch target.vm {
	case protocolcommon.DestVMEVM:
		stateContracts, err := target.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		return NewEVMCallReceiveUpdateRequestFromRootResult(stateContracts, txID, rootResult, target.updateTemplate)
	case protocolcommon.DestVMWASM:
		call, err := NewWASMCallReceiveUpdateRequestFromRootResult(target.contractName, txID, rootResult, target.updateTemplate)
		if err != nil {
			return nil, err
		}
		return e.attachOutboundUpdateProof(ev, target, call)
	case protocolcommon.DestVMFabric:
		call, err := NewFabricCallReceiveUpdateRequestFromRootResult(target.endpoint, txID, rootResult, target.updateTemplate)
		if err != nil {
			return nil, err
		}
		return e.attachOutboundUpdateProof(ev, target, call)
	default:
		return nil, fmt.Errorf("unsupported update target vm %s", target.vm)
	}
}

func (e *Executor) attachOutboundUpdateProof(ev protocolcommon.NormalizedEvent, target remoteTarget, calldata []byte) ([]byte, error) {
	family := ""
	endpoint := target.endpoint
	switch target.vm {
	case protocolcommon.DestVMWASM:
		if e.cfg.Proof.Mode != "zk_substrate" && e.cfg.Proof.Mode != "zk_both" && e.cfg.Proof.Mode != "trust_minimized" && e.cfg.Proof.Mode != "production_proof" {
			return calldata, nil
		}
		family = "WASM_SUBSTRATE"
	case protocolcommon.DestVMFabric:
		if e.cfg.Proof.Mode != "zk_fabric" && e.cfg.Proof.Mode != "zk_both" && e.cfg.Proof.Mode != "trust_minimized" && e.cfg.Proof.Mode != "production_proof" {
			return calldata, nil
		}
		family = "FABRIC"
	default:
		return calldata, nil
	}
	if e.cfg.Proof.Mode == "production_proof" {
		return transport.AttachProductionOutboundEVMUpdateProof(
			calldata,
			family,
			target.chainKey,
			target.chain.ChainID,
			endpoint,
			ev.Name,
			ev.TxID,
			ev.BlockNumber,
			ev.TxHash,
		)
	}
	return transport.AttachOutboundEVMUpdateProof(
		calldata,
		family,
		target.chainKey,
		target.chain.ChainID,
		endpoint,
		ev.Name,
		ev.TxID,
		ev.BlockNumber,
		ev.TxHash,
	)
}

func (e *Executor) newUpdateFromRootResultCallForGroup(group evmChainGroup, txID uint64, rootResult []byte) ([]byte, error) {
	stateContracts := make([]common.Address, 0, len(group.members))
	templates := make([]wasmUpdateTemplate, 0, len(group.members))
	for _, member := range group.members {
		memberContracts, err := member.stateContractAddresses()
		if err != nil {
			return nil, err
		}
		for _, stateContract := range memberContracts {
			stateContracts = append(stateContracts, stateContract)
			templates = append(templates, member.updateTemplate)
		}
	}
	return NewEVMCallReceiveUpdateRequestFromRootResultBatch(stateContracts, txID, rootResult, templates)
}

func firstNonZero(values ...uint64) uint64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (e *Executor) newActionForTarget(ev protocolcommon.NormalizedEvent, target remoteTarget, calldata []byte) protocolcommon.Action {
	if target.vm == protocolcommon.DestVMEVM {
		return protocolcommon.NewAction(
			e.Name(),
			ev.TxID,
			ev.Name,
			target.chainKey,
			target.chain.ChainID,
			target.bridgeContract,
			calldata,
			e.cfg.Proof.MaxRetry,
		)
	}
	return protocolcommon.NewEndpointAction(
		e.Name(),
		ev.TxID,
		ev.Name,
		target.chainKey,
		target.chain.ChainID,
		target.vm,
		target.endpoint,
		calldata,
		e.cfg.Proof.MaxRetry,
	)
}

func (e *Executor) newActionForEVMGroup(ev protocolcommon.NormalizedEvent, group evmChainGroup, calldata []byte) protocolcommon.Action {
	return protocolcommon.NewAction(
		e.Name(),
		ev.TxID,
		ev.Name,
		group.chainKey,
		group.chain.ChainID,
		group.bridgeContract,
		calldata,
		e.cfg.Proof.MaxRetry,
	)
}

func (t remoteTarget) stateContractAddresses() ([]common.Address, error) {
	addresses := make([]common.Address, 0, len(t.stateContracts))
	for _, raw := range t.stateContracts {
		if !common.IsHexAddress(raw) {
			return nil, fmt.Errorf("invalid evm state contract address %q for chain %s", raw, t.chainKey)
		}
		addresses = append(addresses, common.HexToAddress(raw))
	}
	return addresses, nil
}

func (t remoteTarget) filterUpdatePayloads(stateContracts []common.Address, updateData [][]byte) ([]common.Address, [][]byte) {
	if len(stateContracts) != len(updateData) || len(t.stateContracts) == 0 {
		return nil, nil
	}
	allowed := make(map[string]struct{}, len(t.stateContracts))
	for _, raw := range t.stateContracts {
		if common.IsHexAddress(raw) {
			allowed[strings.ToLower(common.HexToAddress(raw).Hex())] = struct{}{}
		}
	}
	var filteredContracts []common.Address
	var filteredUpdates [][]byte
	for idx, contractAddr := range stateContracts {
		if _, ok := allowed[strings.ToLower(contractAddr.Hex())]; !ok {
			continue
		}
		filteredContracts = append(filteredContracts, contractAddr)
		filteredUpdates = append(filteredUpdates, updateData[idx])
	}
	return filteredContracts, filteredUpdates
}
