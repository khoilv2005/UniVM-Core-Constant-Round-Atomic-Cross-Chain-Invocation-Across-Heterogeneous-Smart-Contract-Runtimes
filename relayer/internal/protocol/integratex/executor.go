package integratex

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type executionState struct {
	User           common.Address
	Rooms          uint64
	Outbound       uint64
	Return         uint64
	Timeout        uint64
	StateContracts []common.Address
	ChainIDs       []uint64
}

type Executor struct {
	cfg            *config.Config
	rootTravelDApp common.Address
	rootBridge     common.Address
	rootClient     *transport.EVMClient

	mu          sync.Mutex
	stateByTxID map[string]*executionState
}

func NewExecutor(cfg *config.Config, rootClient *transport.EVMClient) (*Executor, error) {
	root := cfg.Chains["bc1"]
	if !common.IsHexAddress(root.TravelDAppAddress) && cfg.Contracts.IntegrateX["bc1"].TravelDApp != "" {
		root.TravelDAppAddress = cfg.Contracts.IntegrateX["bc1"].TravelDApp
	}
	if !common.IsHexAddress(root.ContractAddress) && cfg.Contracts.IntegrateX["bc1"].BridgeingContract != "" {
		root.ContractAddress = cfg.Contracts.IntegrateX["bc1"].BridgeingContract
	}
	if !common.IsHexAddress(root.TravelDAppAddress) || !common.IsHexAddress(root.ContractAddress) {
		return nil, fmt.Errorf("integratex root contracts missing on bc1")
	}
	return &Executor{
		cfg:            cfg,
		rootTravelDApp: common.HexToAddress(root.TravelDAppAddress),
		rootBridge:     common.HexToAddress(root.ContractAddress),
		rootClient:     rootClient,
		stateByTxID:    map[string]*executionState{},
	}, nil
}

func (e *Executor) Name() protocolcommon.ProtocolName {
	return protocolcommon.ProtocolIntegrateX
}

func (e *Executor) Handle(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	switch ev.Name {
	case "CrossChainExecutionInitiated":
		return nil, e.handleInitiated(ev)
	case "LockingPhaseStarted":
		return e.handleLockingStarted(ev)
	case "CrossChainLockResponseBatch":
		return e.handleLockResponseBatch(ev)
	case "UpdatingPhaseStarted":
		return e.handleUpdatingStarted(ctx, ev)
	case "CrossChainUpdateRequested":
		return e.handleUpdateRequest(ev)
	case "CrossChainUpdateAckBatch":
		return e.handleUpdateAckBatch(ev)
	case "CrossChainExecutionRolledBack", "CrossChainRollback":
		return e.handleRollback(ev)
	case "CrossChainExecutionCompleted":
		return e.handleComplete(ev)
	case "UnlockFailed":
		return e.handleUnlockFailed(ev)
	case "TimeoutDetected":
		return e.handleTimeout(ev)
	default:
		return nil, nil
	}
}

func (e *Executor) handleInitiated(ev protocolcommon.NormalizedEvent) error {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil
	}
	user, ok := protocolcommon.EventArg[common.Address](ev, "user")
	if !ok {
		return nil
	}
	state := &executionState{User: user}
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numRooms"); ok && v != nil {
		state.Rooms = v.Uint64()
	}
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numOutboundTickets"); ok && v != nil {
		state.Outbound = v.Uint64()
	}
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numReturnTickets"); ok && v != nil {
		state.Return = v.Uint64()
	}
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "timeoutBlocks"); ok && v != nil {
		state.Timeout = v.Uint64()
	}
	e.mu.Lock()
	e.stateByTxID[txIDBig.String()] = state
	e.stateByTxID[ev.TxID] = state
	e.mu.Unlock()
	return nil
}

func (e *Executor) handleLockingStarted(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	stateContracts, ok := protocolcommon.EventArg[[]common.Address](ev, "stateContracts")
	if !ok || len(stateContracts) == 0 {
		return nil, nil
	}
	chainIDsBig, ok := protocolcommon.EventArg[[]*big.Int](ev, "chainIds")
	if !ok || len(chainIDsBig) != len(stateContracts) {
		return nil, nil
	}

	e.mu.Lock()
	state := e.lookupStateLocked(ev.TxID, txIDBig.String())
	if state != nil {
		state.StateContracts = append([]common.Address(nil), stateContracts...)
		state.ChainIDs = state.ChainIDs[:0]
		for _, id := range chainIDsBig {
			state.ChainIDs = append(state.ChainIDs, id.Uint64())
		}
	}
	e.mu.Unlock()
	if state == nil {
		return nil, nil
	}

	type grouped struct {
		contracts []common.Address
		args      [][]byte
	}
	groupedByChain := map[uint64]*grouped{}
	for idx, contract := range stateContracts {
		chainID := chainIDsBig[idx].Uint64()
		lockArg, err := e.lockArgForStateContract(txIDBig.Uint64(), contract, chainID, state)
		if err != nil {
			return nil, err
		}
		group := groupedByChain[chainID]
		if group == nil {
			group = &grouped{}
			groupedByChain[chainID] = group
		}
		group.contracts = append(group.contracts, contract)
		group.args = append(group.args, lockArg)
	}

	var actions []protocolcommon.Action
	for chainID, group := range groupedByChain {
		destChainKey, destChainID := chainByID(e.cfg, chainID)
		if destChainKey == "" {
			continue
		}
		call, err := NewCallReceiveLockRequest(txIDBig.Uint64(), group.contracts, group.args, state.Timeout)
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, bridgeAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleLockResponseBatch(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	chainIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "sourceChainId")
	if !ok || chainIDBig == nil {
		return nil, nil
	}
	lockedStates, ok := protocolcommon.EventArg[[][]byte](ev, "lockedStates")
	if !ok || len(lockedStates) == 0 {
		return nil, nil
	}
	call, err := NewCallReceiveLockResponseBatch(txIDBig.Uint64(), chainIDBig.Uint64(), lockedStates)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, e.rootTravelDApp, call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleUpdateRequest(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	stateContracts, ok := protocolcommon.EventArg[[]common.Address](ev, "stateContracts")
	if !ok || len(stateContracts) == 0 {
		return nil, nil
	}
	updateData, ok := protocolcommon.EventArg[[][]byte](ev, "updateData")
	if !ok || len(updateData) != len(stateContracts) {
		return nil, nil
	}

	type grouped struct {
		contracts []common.Address
		data      [][]byte
	}
	groupedByChain := map[uint64]*grouped{}
	for idx, contract := range stateContracts {
		chainID := e.chainIDForStateContract(contract)
		if chainID == 0 {
			continue
		}
		group := groupedByChain[chainID]
		if group == nil {
			group = &grouped{}
			groupedByChain[chainID] = group
		}
		group.contracts = append(group.contracts, contract)
		group.data = append(group.data, updateData[idx])
	}

	var actions []protocolcommon.Action
	for chainID, group := range groupedByChain {
		destChainKey, destChainID := chainByID(e.cfg, chainID)
		if destChainKey == "" {
			continue
		}
		call, err := NewCallReceiveUpdateRequest(txIDBig.Uint64(), group.contracts, group.data)
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, bridgeAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleUpdatingStarted(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	if e.rootClient == nil {
		return nil, fmt.Errorf("integratex root client is nil")
	}

	calldata, err := NewCallGetUpdatePayloads(txIDBig.Uint64())
	if err != nil {
		return nil, err
	}
	raw, err := e.rootClient.Call(ctx, e.rootTravelDApp, calldata)
	if err != nil {
		return nil, err
	}
	stateContracts, chainIDsBig, updateData, err := DecodeGetUpdatePayloads(raw)
	if err != nil {
		return nil, err
	}
	if len(stateContracts) == 0 || len(stateContracts) != len(chainIDsBig) || len(stateContracts) != len(updateData) {
		return nil, nil
	}

	type grouped struct {
		contracts []common.Address
		data      [][]byte
	}
	groupedByChain := map[uint64]*grouped{}
	for idx, contract := range stateContracts {
		chainID := chainIDsBig[idx].Uint64()
		group := groupedByChain[chainID]
		if group == nil {
			group = &grouped{}
			groupedByChain[chainID] = group
		}
		group.contracts = append(group.contracts, contract)
		group.data = append(group.data, updateData[idx])
	}

	var actions []protocolcommon.Action
	for chainID, group := range groupedByChain {
		destChainKey, destChainID := chainByID(e.cfg, chainID)
		if destChainKey == "" {
			continue
		}
		call, err := NewCallReceiveUpdateRequest(txIDBig.Uint64(), group.contracts, group.data)
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, bridgeAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleUpdateAckBatch(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	stateContracts, ok := protocolcommon.EventArg[[]common.Address](ev, "stateContracts")
	if !ok || len(stateContracts) == 0 {
		return nil, nil
	}
	call, err := NewCallReceiveUpdateAckBatch(txIDBig.Uint64(), stateContracts)
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, e.rootTravelDApp, call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
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
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, e.rootBridge, call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleRollback(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	e.mu.Lock()
	state := e.lookupStateLocked(ev.TxID, txIDBig.String())
	e.mu.Unlock()
	if state == nil || len(state.StateContracts) == 0 || len(state.ChainIDs) != len(state.StateContracts) {
		return nil, nil
	}

	type grouped struct {
		contracts []common.Address
	}
	groupedByChain := map[uint64]*grouped{}
	for idx, contract := range state.StateContracts {
		chainID := state.ChainIDs[idx]
		group := groupedByChain[chainID]
		if group == nil {
			group = &grouped{}
			groupedByChain[chainID] = group
		}
		group.contracts = append(group.contracts, contract)
	}

	var actions []protocolcommon.Action
	for chainID, group := range groupedByChain {
		destChainKey, destChainID := chainByID(e.cfg, chainID)
		if destChainKey == "" {
			continue
		}
		call, err := NewCallReceiveRollbackRequest(txIDBig.Uint64(), group.contracts)
		if err != nil {
			return nil, err
		}
		actions = append(actions, protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, destChainKey, destChainID, bridgeAddress(e.cfg, destChainKey), call, e.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (e *Executor) handleComplete(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	call, err := NewCallCompleteExecution(txIDBig.Uint64())
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, e.rootBridge, call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) handleTimeout(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	txIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "crossChainTxId")
	if !ok || txIDBig == nil {
		return nil, nil
	}
	call, err := NewCallCheckTimeout(txIDBig.Uint64())
	if err != nil {
		return nil, err
	}
	action := protocolcommon.NewAction(e.Name(), ev.TxID, ev.Name, "bc1", e.cfg.Chains["bc1"].ChainID, e.rootTravelDApp, call, e.cfg.Proof.MaxRetry)
	return []protocolcommon.Action{action}, nil
}

func (e *Executor) lookupStateLocked(keys ...string) *executionState {
	for _, key := range keys {
		if state, ok := e.stateByTxID[key]; ok {
			return state
		}
	}
	return nil
}

func (e *Executor) lockArgForStateContract(txID uint64, addr common.Address, chainID uint64, state *executionState) ([]byte, error) {
	switch e.serviceRoleForStateContract(addr) {
	case "hotel", "flight", "taxi":
		return encodeArgs(txID, state.Rooms, state.Timeout)
	case "train":
		return encodeArgs(txID, state.Outbound+state.Return, state.Timeout)
	}
	switch chainID {
	case 2:
		return encodeArgs(txID, state.Rooms, state.Timeout)
	case 3:
		return encodeArgs(txID, state.Outbound+state.Return, state.Timeout)
	default:
		return nil, fmt.Errorf("unsupported IntegrateX lock state=%s chain=%d", addr.Hex(), chainID)
	}
}

func (e *Executor) chainIDForStateContract(addr common.Address) uint64 {
	for chainKey, chain := range e.cfg.Chains {
		for _, stateAddr := range e.cfg.Contracts.IntegrateX[chainKey].StateContracts {
			if strings.EqualFold(stateAddr, addr.Hex()) {
				return chain.ChainID
			}
		}
		for _, stateAddr := range chain.ServiceStateContracts {
			if strings.EqualFold(stateAddr, addr.Hex()) {
				return chain.ChainID
			}
		}
	}
	return 0
}

func (e *Executor) serviceRoleForStateContract(addr common.Address) string {
	for chainKey, chain := range e.cfg.Chains {
		for serviceName, stateAddrs := range chain.ServiceStateGroups {
			for _, stateAddr := range stateAddrs {
				if strings.EqualFold(stateAddr, addr.Hex()) {
					name := strings.ToLower(strings.TrimSpace(serviceName))
					if strings.Contains(name, "hotel") {
						return "hotel"
					}
					if strings.Contains(name, "train") {
						return "train"
					}
					if strings.Contains(name, "flight") {
						return "flight"
					}
					if strings.Contains(name, "taxi") {
						return "taxi"
					}
				}
			}
		}
		for _, stateAddr := range e.cfg.Contracts.IntegrateX[chainKey].StateContracts {
			if strings.EqualFold(stateAddr, addr.Hex()) {
				if chain.ChainID == 2 {
					return "hotel"
				}
				if chain.ChainID == 3 {
					return "train"
				}
			}
		}
	}
	return ""
}

func encodeArgs(values ...any) ([]byte, error) {
	args := make(abi.Arguments, 0, len(values))
	pack := make([]any, 0, len(values))
	for _, value := range values {
		switch v := value.(type) {
		case common.Address:
			args = append(args, abi.Argument{Type: mustType("address")})
			pack = append(pack, v)
		case uint64:
			args = append(args, abi.Argument{Type: mustType("uint256")})
			pack = append(pack, new(big.Int).SetUint64(v))
		default:
			return nil, fmt.Errorf("unsupported lock arg type %T", value)
		}
	}
	return args.Pack(pack...)
}

func mustType(kind string) abi.Type {
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

func bridgeAddress(cfg *config.Config, chainKey string) common.Address {
	if entry, ok := cfg.Contracts.IntegrateX[chainKey]; ok && common.IsHexAddress(entry.BridgeingContract) {
		return common.HexToAddress(entry.BridgeingContract)
	}
	return common.HexToAddress(cfg.Chains[chainKey].ContractAddress)
}
