package atom

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

type InvocationState struct {
	HashKey         []byte
	Proofs          map[uint64]bool
	SubmittedProofs map[uint64]bool
	ProofHashes     map[uint64][32]byte
	CurrentStep     uint64
	CompletedOps    map[uint64]bool
	User            common.Address
	Rooms           uint64
	Outbound        uint64
	Return          uint64
}

type Server struct {
	cfg       *config.Config
	manifest  *Manifest
	serverKey *ecdsa.PrivateKey

	mu      sync.Mutex
	pending map[string]*InvocationState
}

func NewServer(cfg *config.Config) (*Server, error) {
	manifest, err := LoadManifest(cfg.Atom.WriteManifest)
	if err != nil {
		return nil, err
	}
	if err := manifest.ValidateSequentialWriteOnly(); err != nil {
		return nil, err
	}
	serverKey, err := parseECDSA(cfg.Relayer.PrivateKey)
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:       cfg,
		manifest:  manifest,
		serverKey: serverKey,
		pending:   map[string]*InvocationState{},
	}, nil
}

func (s *Server) Name() protocolcommon.ProtocolName {
	return protocolcommon.ProtocolAtom
}

func (s *Server) Handle(ctx context.Context, ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	switch ev.Name {
	case "WriteOnlyInvocationRequested":
		return s.handleWriteOnly(ev)
	case "AtomHotelLocked":
		return s.handleLocked(ev, "hotel-write")
	case "AtomTrainLocked":
		return s.handleLocked(ev, "train-write")
	case "AtomFlightLocked":
		return s.handleLocked(ev, "flight-write")
	case "AtomTaxiLocked":
		return s.handleLocked(ev, "taxi-write")
	case "OperationProofSubmitted":
		return s.handleOperationProofSubmitted(ev)
	case "InvocationFinalized":
		return s.handleUnlock(ev, false)
	case "InvocationInvalidated", "ForceSettleUndoRequired", "InvocationForceSettled":
		return s.handleUnlock(ev, true)
	default:
		return nil, nil
	}
}

func (s *Server) handleWriteOnly(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}
	user, ok := protocolcommon.EventArg[common.Address](ev, "user")
	if !ok {
		return nil, nil
	}
	numRooms := uint64(0)
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numRooms"); ok && v != nil {
		numRooms = v.Uint64()
	}
	numOutbound := uint64(0)
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numOutboundTickets"); ok && v != nil {
		numOutbound = v.Uint64()
	}
	numReturn := uint64(0)
	if v, ok := protocolcommon.EventArg[*big.Int](ev, "numReturnTickets"); ok && v != nil {
		numReturn = v.Uint64()
	}

	hashKey := make([]byte, 32)
	if _, err := rand.Read(hashKey); err != nil {
		return nil, err
	}
	lockHash := crypto.Keccak256Hash(hashKey)

	invokeKey := invokeIDKey(invokeID)
	s.mu.Lock()
	s.pending[invokeKey] = &InvocationState{
		HashKey:         hashKey,
		Proofs:          map[uint64]bool{},
		SubmittedProofs: map[uint64]bool{},
		ProofHashes:     map[uint64][32]byte{},
		CurrentStep:     1,
		CompletedOps:    map[uint64]bool{},
		User:            user,
		Rooms:           numRooms,
		Outbound:        numOutbound,
		Return:          numReturn,
	}
	s.mu.Unlock()

	actions, err := s.lockActionsForStep(ev.TxID, invokeID, user, numRooms, numOutbound, numReturn, lockHash, 1)
	if err != nil {
		return nil, err
	}
	return actions, nil
}

func (s *Server) lockActionsForStep(
	rootTxID string,
	invokeID [32]byte,
	user common.Address,
	numRooms uint64,
	numOutbound uint64,
	numReturn uint64,
	lockHash common.Hash,
	step uint64,
) ([]protocolcommon.Action, error) {
	var actions []protocolcommon.Action
	for _, op := range s.manifest.Operations {
		if op.Step != step {
			continue
		}
		remote, ok := remoteFunctionForID(s.manifest, op.FunctionID)
		if !ok {
			continue
		}
		destChainKey, destChainID := chainByID(s.cfg, remote.ChainID)
		if destChainKey == "" {
			continue
		}
		chain := s.cfg.Chains[destChainKey]
		destVM := destinationVM(chain.VM)
		kind := remoteKind(remote.BusinessUnit)

		var call []byte
		var err error
		switch {
		case strings.Contains(strings.ToLower(remote.BusinessUnit), "hotel"):
			if destVM == protocolcommon.DestVMEVM {
				call, err = NewCallBookUnitLockDo(invokeID, lockHash, user.Hex(), numRooms)
			} else {
				call, err = nonEVMCallBookLockDo(destVM, firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress), invokeID, lockHash, kind, user.Hex(), numRooms, 0)
			}
			if err != nil {
				return nil, fmt.Errorf("build hotel lock_do: %w", err)
			}
		case strings.Contains(strings.ToLower(remote.BusinessUnit), "train"):
			if destVM == protocolcommon.DestVMEVM {
				call, err = NewCallBookTrainLockDo(invokeID, lockHash, user.Hex(), numOutbound, numReturn)
			} else {
				call, err = nonEVMCallBookLockDo(destVM, firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress), invokeID, lockHash, kind, user.Hex(), numOutbound, numReturn)
			}
			if err != nil {
				return nil, fmt.Errorf("build train lock_do: %w", err)
			}
		case strings.Contains(strings.ToLower(remote.BusinessUnit), "flight"):
			if destVM == protocolcommon.DestVMEVM {
				call, err = NewCallBookUnitLockDo(invokeID, lockHash, user.Hex(), numRooms)
			} else {
				call, err = nonEVMCallBookLockDo(destVM, firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress), invokeID, lockHash, kind, user.Hex(), numRooms, 0)
			}
			if err != nil {
				return nil, fmt.Errorf("build flight lock_do: %w", err)
			}
		case strings.Contains(strings.ToLower(remote.BusinessUnit), "taxi"):
			if destVM == protocolcommon.DestVMEVM {
				call, err = NewCallBookUnitLockDo(invokeID, lockHash, user.Hex(), numRooms)
			} else {
				call, err = nonEVMCallBookLockDo(destVM, firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress), invokeID, lockHash, kind, user.Hex(), numRooms, 0)
			}
			if err != nil {
				return nil, fmt.Errorf("build taxi lock_do: %w", err)
			}
		default:
			continue
		}
		if destVM != protocolcommon.DestVMEVM {
			endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress)
			actions = append(actions, protocolcommon.NewEndpointAction(s.Name(), rootTxID, "WriteOnlyInvocationRequested", destChainKey, destChainID, destVM, endpoint, call, s.cfg.Proof.MaxRetry))
			continue
		}
		if !common.IsHexAddress(remote.ContractAddress) {
			return nil, fmt.Errorf("invalid ATOM EVM remote contract %q", remote.ContractAddress)
		}
		actions = append(actions, protocolcommon.NewAction(s.Name(), rootTxID, "WriteOnlyInvocationRequested", destChainKey, destChainID, common.HexToAddress(remote.ContractAddress), call, s.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func (s *Server) handleLocked(ev protocolcommon.NormalizedEvent, functionID string) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}
	operationID, remoteChainID := operationIDForFunctionID(s.manifest, functionID)
	if operationID == 0 {
		return nil, nil
	}
	step := stepForOperationID(s.manifest, operationID)
	var dependencyHash [32]byte

	invokeKey := invokeIDKey(invokeID)
	s.mu.Lock()
	state := s.pending[invokeKey]
	if state == nil {
		state = &InvocationState{
			Proofs:          map[uint64]bool{},
			SubmittedProofs: map[uint64]bool{},
			ProofHashes:     map[uint64][32]byte{},
			CurrentStep:     1,
			CompletedOps:    map[uint64]bool{},
		}
		s.pending[invokeKey] = state
	}
	if state.SubmittedProofs == nil {
		state.SubmittedProofs = map[uint64]bool{}
	}
	if state.CompletedOps[operationID] {
		s.mu.Unlock()
		return nil, nil
	}
	if operationID > 1 {
		prevHash, ok := state.ProofHashes[operationID-1]
		if !ok {
			s.mu.Unlock()
			return nil, fmt.Errorf("missing dependency hash for operation %d", operationID)
		}
		dependencyHash = prevHash
	}
	proofHash, err := HashOperationProofFlat(
		invokeID,
		operationID,
		remoteChainID,
		ev.BlockNumber,
		toBytes32(ev.TxHash),
		0,
		[32]byte{},
		0,
		[32]byte{},
		0,
		[32]byte{},
		dependencyHash,
	)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	signature, err := signProofHash(s.serverKey, proofHash)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	state.Proofs[operationID] = true
	state.ProofHashes[operationID] = proofHash
	state.CompletedOps[operationID] = true
	stepComplete := stepCompleted(s.manifest, state.CompletedOps, step)
	if stepComplete && state.CurrentStep == step {
		state.CurrentStep = nextStepAfter(s.manifest, step)
	}
	s.mu.Unlock()

	call, err := NewCallSubmitOperationProofFlat(
		invokeID,
		operationID,
		remoteChainID,
		ev.BlockNumber,
		toBytes32(ev.TxHash),
		0,
		[32]byte{},
		0,
		[32]byte{},
		0,
		[32]byte{},
		dependencyHash,
		signature,
	)
	if err != nil {
		return nil, err
	}

	rootChainKey, rootChainID := chainByID(s.cfg, 1)
	serviceAddr := common.HexToAddress(s.cfg.Contracts.Atom["bc1"].AtomService)
	if serviceAddr == (common.Address{}) && common.IsHexAddress(s.cfg.Chains["bc1"].AtomServiceAddress) {
		serviceAddr = common.HexToAddress(s.cfg.Chains["bc1"].AtomServiceAddress)
	}

	actions := []protocolcommon.Action{
		protocolcommon.NewAction(s.Name(), ev.TxID, ev.Name, rootChainKey, rootChainID, serviceAddr, call, s.cfg.Proof.MaxRetry),
	}

	if stepComplete {
		nextStep := nextStepAfter(s.manifest, step)
		if nextStep > 0 {
			lockHash := crypto.Keccak256Hash(state.HashKey)
			stepActions, err := s.lockActionsForStep(
				ev.TxID,
				invokeID,
				state.User,
				state.Rooms,
				state.Outbound,
				state.Return,
				lockHash,
				nextStep,
			)
			if err != nil {
				return nil, err
			}
			actions = append(actions, stepActions...)
		}
	}

	return actions, nil
}

func (s *Server) handleOperationProofSubmitted(ev protocolcommon.NormalizedEvent) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}
	operationIDBig, ok := protocolcommon.EventArg[*big.Int](ev, "operationId")
	if !ok || operationIDBig == nil {
		return nil, nil
	}
	operationID := operationIDBig.Uint64()

	invokeKey := invokeIDKey(invokeID)
	s.mu.Lock()
	state := s.pending[invokeKey]
	if state == nil {
		state = &InvocationState{
			Proofs:          map[uint64]bool{},
			SubmittedProofs: map[uint64]bool{},
			ProofHashes:     map[uint64][32]byte{},
			CurrentStep:     1,
			CompletedOps:    map[uint64]bool{},
		}
		s.pending[invokeKey] = state
	}
	if state.SubmittedProofs == nil {
		state.SubmittedProofs = map[uint64]bool{}
	}
	state.SubmittedProofs[operationID] = true
	allSubmitted := len(state.SubmittedProofs) >= s.manifest.TotalOperations
	s.mu.Unlock()
	if !allSubmitted {
		return nil, nil
	}

	rootChainKey, rootChainID := chainByID(s.cfg, 1)
	serviceAddr := common.HexToAddress(s.cfg.Contracts.Atom["bc1"].AtomService)
	if serviceAddr == (common.Address{}) && common.IsHexAddress(s.cfg.Chains["bc1"].AtomServiceAddress) {
		serviceAddr = common.HexToAddress(s.cfg.Chains["bc1"].AtomServiceAddress)
	}
	completeCall, err := NewCallMarkProofSubmissionComplete(invokeID)
	if err != nil {
		return nil, err
	}
	return []protocolcommon.Action{
		protocolcommon.NewAction(s.Name(), ev.TxID, "AllProofsSubmitted", rootChainKey, rootChainID, serviceAddr, completeCall, s.cfg.Proof.MaxRetry),
	}, nil
}

func (s *Server) handleUnlock(ev protocolcommon.NormalizedEvent, undo bool) ([]protocolcommon.Action, error) {
	invokeID, ok := protocolcommon.EventArg[[32]byte](ev, "invokeId")
	if !ok {
		return nil, nil
	}

	invokeKey := invokeIDKey(invokeID)
	s.mu.Lock()
	state := s.pending[invokeKey]
	delete(s.pending, invokeKey)
	s.mu.Unlock()
	if state == nil || len(state.HashKey) == 0 {
		return nil, nil
	}

	var actions []protocolcommon.Action
	for _, remote := range s.manifest.RemoteFunctions {
		destChainKey, destChainID := chainByID(s.cfg, remote.ChainID)
		if destChainKey == "" {
			continue
		}
		chain := s.cfg.Chains[destChainKey]
		destVM := destinationVM(chain.VM)
		kind := remoteKind(remote.BusinessUnit)
		var (
			call []byte
			err  error
		)
		if destVM != protocolcommon.DestVMEVM {
			endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress)
			call, err = nonEVMCallBookUnlock(destVM, endpoint, invokeID, state.HashKey, kind, undo)
		} else if undo {
			call, err = NewCallBookUndoUnlock(invokeID, state.HashKey)
		} else {
			call, err = NewCallBookUnlock(invokeID, state.HashKey)
		}
		if err != nil {
			return nil, err
		}
		if destVM != protocolcommon.DestVMEVM {
			endpoint := firstNonEmptyString(chain.EffectiveEndpoint(), remote.ContractAddress)
			actions = append(actions, protocolcommon.NewEndpointAction(s.Name(), ev.TxID, ev.Name, destChainKey, destChainID, destVM, endpoint, call, s.cfg.Proof.MaxRetry))
			continue
		}
		if !common.IsHexAddress(remote.ContractAddress) {
			return nil, fmt.Errorf("invalid ATOM EVM remote contract %q", remote.ContractAddress)
		}
		actions = append(actions, protocolcommon.NewAction(s.Name(), ev.TxID, ev.Name, destChainKey, destChainID, common.HexToAddress(remote.ContractAddress), call, s.cfg.Proof.MaxRetry))
	}
	return actions, nil
}

func operationIDForFunctionID(manifest *Manifest, functionID string) (uint64, uint64) {
	for _, remote := range manifest.RemoteFunctions {
		if remote.FunctionID != functionID {
			continue
		}
		for _, op := range manifest.Operations {
			if op.FunctionID == remote.FunctionID {
				return op.ID, remote.ChainID
			}
		}
	}
	return 0, 0
}

func stepForOperationID(manifest *Manifest, operationID uint64) uint64 {
	for _, op := range manifest.Operations {
		if op.ID == operationID {
			return op.Step
		}
	}
	return 0
}

func stepCompleted(manifest *Manifest, completed map[uint64]bool, step uint64) bool {
	found := false
	for _, op := range manifest.Operations {
		if op.Step != step {
			continue
		}
		found = true
		if !completed[op.ID] {
			return false
		}
	}
	return found
}

func nextStepAfter(manifest *Manifest, step uint64) uint64 {
	var candidate uint64
	for _, op := range manifest.Operations {
		if op.Step <= step {
			continue
		}
		if candidate == 0 || op.Step < candidate {
			candidate = op.Step
		}
	}
	return candidate
}

func remoteFunctionForID(manifest *Manifest, functionID string) (RemoteFunction, bool) {
	for _, remote := range manifest.RemoteFunctions {
		if remote.FunctionID == functionID {
			return remote, true
		}
	}
	return RemoteFunction{}, false
}

func invokeIDKey(invokeID [32]byte) string {
	return common.BytesToHash(invokeID[:]).Hex()
}

func chainByID(cfg *config.Config, chainID uint64) (string, uint64) {
	for key, chain := range cfg.Chains {
		if chain.ChainID == chainID {
			return key, chain.ChainID
		}
	}
	return "", 0
}

func toBytes32(hash common.Hash) [32]byte {
	var out [32]byte
	copy(out[:], hash.Bytes())
	return out
}

func signProofHash(key *ecdsa.PrivateKey, proofHash [32]byte) ([]byte, error) {
	signature, err := crypto.Sign(accounts.TextHash(proofHash[:]), key)
	if err != nil {
		return nil, err
	}
	signature[64] += 27
	return signature, nil
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

func remoteKind(businessUnit string) string {
	lower := strings.ToLower(strings.TrimSpace(businessUnit))
	for _, kind := range []string{"hotel", "train", "flight", "taxi"} {
		if strings.Contains(lower, kind) {
			return kind
		}
	}
	return lower
}

func nonEVMCallBookLockDo(destVM protocolcommon.DestinationVM, endpoint string, invokeID [32]byte, lockHash common.Hash, kind string, user string, amountA uint64, amountB uint64) ([]byte, error) {
	if strings.TrimSpace(endpoint) == "" {
		return nil, fmt.Errorf("missing ATOM endpoint for %s", kind)
	}
	switch destVM {
	case protocolcommon.DestVMWASM:
		return NewWASMCallBookLockDo(endpoint, invokeID, lockHash, kind, user, amountA, amountB)
	case protocolcommon.DestVMFabric:
		return NewFabricCallBookLockDo(endpoint, invokeID, lockHash, kind, user, amountA, amountB)
	default:
		return nil, fmt.Errorf("unsupported ATOM endpoint VM %s", destVM)
	}
}

func nonEVMCallBookUnlock(destVM protocolcommon.DestinationVM, endpoint string, invokeID [32]byte, hashKey []byte, kind string, undo bool) ([]byte, error) {
	if strings.TrimSpace(endpoint) == "" {
		return nil, fmt.Errorf("missing ATOM endpoint for %s", kind)
	}
	switch destVM {
	case protocolcommon.DestVMWASM:
		return NewWASMCallBookUnlock(endpoint, invokeID, hashKey, kind, undo)
	case protocolcommon.DestVMFabric:
		return NewFabricCallBookUnlock(endpoint, invokeID, hashKey, kind, undo)
	default:
		return nil, fmt.Errorf("unsupported ATOM endpoint VM %s", destVM)
	}
}
