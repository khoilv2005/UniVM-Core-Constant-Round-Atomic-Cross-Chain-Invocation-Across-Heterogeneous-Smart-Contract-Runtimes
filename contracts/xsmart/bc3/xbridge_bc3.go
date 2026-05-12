// XBridgeBc3 chaincode on Fabric (bc3) for XSmartContract heterogeneous testbed.
// Minimal bridge wrapper mirroring the ink! bc2 bridge: receive lock/update/
// rollback requests from the relayer, invoke HotelBooking, and emit Fabric-side
// events for relayer fan-in.
package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type XBridgeBc3 struct{ contractapi.Contract }

type bridgeMeta struct {
	RelayerMSP    string `json:"relayerMSP"`
	StateContract string `json:"stateContract"`
}

const (
	bridgeMetaKey    = "XBRIDGE_META"
	fabricStateName  = "hotel_booking"
	fabricBridgeName = "xbridge_bc3"
	keyBridgePending = "XBRIDGE_PENDING_%s"
)

type bridgePendingOp struct {
	AmountA uint64 `json:"amountA"`
	AmountB uint64 `json:"amountB"`
	Kind    string `json:"kind"`
	User    string `json:"user"`
	Active  bool   `json:"active"`
}

func (x *XBridgeBc3) InitLedger(
	ctx contractapi.TransactionContextInterface,
	relayerMSP string,
	stateContract string,
) error {
	if relayerMSP == "" {
		return fmt.Errorf("relayer MSP is required")
	}
	if stateContract == "" {
		stateContract = fabricStateName
	}
	return x.putMeta(ctx, &bridgeMeta{
		RelayerMSP:    relayerMSP,
		StateContract: stateContract,
	})
}

func (x *XBridgeBc3) RelayerMSP(ctx contractapi.TransactionContextInterface) (string, error) {
	meta, err := x.getMeta(ctx)
	if err != nil {
		return "", err
	}
	return meta.RelayerMSP, nil
}

func (x *XBridgeBc3) StateContract(ctx contractapi.TransactionContextInterface) (string, error) {
	meta, err := x.getMeta(ctx)
	if err != nil {
		return "", err
	}
	return meta.StateContract, nil
}

func (x *XBridgeBc3) SetRelayerMSP(
	ctx contractapi.TransactionContextInterface,
	relayerMSP string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	meta, err := x.getMeta(ctx)
	if err != nil {
		return err
	}
	meta.RelayerMSP = relayerMSP
	return x.putMeta(ctx, meta)
}

func (x *XBridgeBc3) SetStateContract(
	ctx contractapi.TransactionContextInterface,
	stateContract string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	meta, err := x.getMeta(ctx)
	if err != nil {
		return err
	}
	meta.StateContract = stateContract
	return x.putMeta(ctx, meta)
}

func (x *XBridgeBc3) ReceiveLockRequest(
	ctx contractapi.TransactionContextInterface,
	crossChainTxID string,
	num uint64,
	timeoutBlocks uint64,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}

	state := &HotelBooking{}
	encodedState, irHash, proof, err := state.lockStateInternal(
		ctx,
		crossChainTxID,
		num,
		timeoutBlocks,
	)
	if err != nil {
		return err
	}

	payload, _ := json.Marshal(struct {
		CrossChainTxID string `json:"crossChainTxId"`
		StateContract  string `json:"stateContract"`
		LockedState    string `json:"lockedState"`
		IrHash         string `json:"irHash"`
		Proof          string `json:"proof"`
	}{
		CrossChainTxID: crossChainTxID,
		StateContract:  fabricStateName,
		LockedState:    "0x" + bytesToHex(encodedState),
		IrHash:         irHash,
		Proof:          "0x" + bytesToHex(proof),
	})
	_ = ctx.GetStub().SetEvent("CrossChainLockResponse", payload)

	return nil
}

func (x *XBridgeBc3) ReceiveUpdateRequest(
	ctx contractapi.TransactionContextInterface,
	crossChainTxID string,
	newRemain uint64,
	user string,
	num uint64,
	totalCost uint64,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}

	state := &HotelBooking{}
	if err := state.UpdateState(ctx, crossChainTxID, newRemain, user, num, totalCost); err != nil {
		return err
	}

	payload, _ := json.Marshal(struct {
		CrossChainTxID string `json:"crossChainTxId"`
		StateContract  string `json:"stateContract"`
		Success        bool   `json:"success"`
	}{
		CrossChainTxID: crossChainTxID,
		StateContract:  fabricStateName,
		Success:        true,
	})
	return ctx.GetStub().SetEvent("CrossChainUpdateAck", payload)
}

func (x *XBridgeBc3) ReceiveRollbackRequest(
	ctx contractapi.TransactionContextInterface,
	crossChainTxID string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}

	state := &HotelBooking{}
	if err := state.UnlockState(ctx, crossChainTxID); err != nil {
		return err
	}

	payload, _ := json.Marshal(struct {
		CrossChainTxID string `json:"crossChainTxId"`
		StateContract  string `json:"stateContract"`
	}{
		CrossChainTxID: crossChainTxID,
		StateContract:  fabricStateName,
	})
	return ctx.GetStub().SetEvent("CrossChainRollback", payload)
}

func (x *XBridgeBc3) ReceiveTimeoutRollback(
	ctx contractapi.TransactionContextInterface,
	crossChainTxID string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}

	state := &HotelBooking{}
	if err := state.UnlockOnTimeout(ctx, crossChainTxID); err != nil {
		return err
	}

	payload, _ := json.Marshal(struct {
		CrossChainTxID string `json:"crossChainTxId"`
		StateContract  string `json:"stateContract"`
	}{
		CrossChainTxID: crossChainTxID,
		StateContract:  fabricStateName,
	})
	return ctx.GetStub().SetEvent("CrossChainRollback", payload)
}

func (x *XBridgeBc3) GPACTSegment(
	ctx contractapi.TransactionContextInterface,
	txID string,
	callTreeHash string,
	chainID uint64,
	segmentID uint64,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	state := &HotelBooking{}
	if _, _, _, err := state.lockStateInternal(ctx, txID, 1, 30); err != nil {
		return err
	}
	if err := x.putPending(ctx, txID, &bridgePendingOp{
		AmountA: 1,
		AmountB: 0,
		Kind:    "hotel",
		User:    x.relayerUser(ctx),
		Active:  true,
	}); err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		CrosschainTxID string `json:"crosschainTxId"`
		ChainID        uint64 `json:"chainId"`
		SegmentID      uint64 `json:"segmentId"`
		CallTreeHash   string `json:"callTreeHash"`
		Success        bool   `json:"success"`
		Locked         bool   `json:"locked"`
		Result         string `json:"result"`
	}{
		CrosschainTxID: txID,
		ChainID:        chainID,
		SegmentID:      segmentID,
		CallTreeHash:   callTreeHash,
		Success:        true,
		Locked:         true,
		Result:         "0x",
	})
	return ctx.GetStub().SetEvent("SegmentEvent", payload)
}

func (x *XBridgeBc3) GPACTSignalling(
	ctx contractapi.TransactionContextInterface,
	txID string,
	callTreeHash string,
	chainID uint64,
	segmentID uint64,
	commit bool,
	abortTx bool,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	state := &HotelBooking{}
	if commit && !abortTx {
		pending, err := x.getPending(ctx, txID)
		if err != nil {
			return err
		}
		if err := state.UnlockState(ctx, txID); err != nil {
			return err
		}
		if _, err := state.BookLocal(ctx, pending.User, pending.AmountA); err != nil {
			return err
		}
		if err := x.deletePending(ctx, txID); err != nil {
			return err
		}
	} else {
		if err := state.UnlockState(ctx, txID); err != nil {
			return err
		}
		if err := x.deletePending(ctx, txID); err != nil {
			return err
		}
	}
	payload, _ := json.Marshal(struct {
		CrosschainTxID string `json:"crosschainTxId"`
		ChainID        uint64 `json:"chainId"`
		SegmentID      uint64 `json:"segmentId"`
		CallTreeHash   string `json:"callTreeHash"`
		Commit         bool   `json:"commit"`
		AbortTx        bool   `json:"abortTx"`
	}{
		CrosschainTxID: txID,
		ChainID:        chainID,
		SegmentID:      segmentID,
		CallTreeHash:   callTreeHash,
		Commit:         commit,
		AbortTx:        abortTx,
	})
	return ctx.GetStub().SetEvent("SignallingEvent", payload)
}

func (x *XBridgeBc3) GPACTTimeoutUnlock(
	ctx contractapi.TransactionContextInterface,
	txID string,
	chainID uint64,
	segmentID uint64,
) error {
	return x.GPACTSignalling(ctx, txID, "", chainID, segmentID, false, true)
}

func (x *XBridgeBc3) AtomLockDo(
	ctx contractapi.TransactionContextInterface,
	invokeID string,
	lockHash string,
	kind string,
	user string,
	amountA uint64,
	amountB uint64,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	state := &HotelBooking{}
	amount := amountA
	if amount == 0 {
		amount = amountB
	}
	if amount == 0 {
		return fmt.Errorf("zero atom lock amount")
	}
	if _, _, _, err := state.lockStateInternal(ctx, invokeID, amount, 30); err != nil {
		return err
	}
	if err := x.putPending(ctx, invokeID, &bridgePendingOp{
		AmountA: amountA,
		AmountB: amountB,
		Kind:    kind,
		User:    user,
		Active:  true,
	}); err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		InvokeID string `json:"invokeId"`
		LockHash string `json:"lockHash"`
		Kind     string `json:"kind"`
		User     string `json:"user"`
		AmountA  uint64 `json:"amountA"`
		AmountB  uint64 `json:"amountB"`
	}{
		InvokeID: invokeID,
		LockHash: lockHash,
		Kind:     kind,
		User:     user,
		AmountA:  amountA,
		AmountB:  amountB,
	})
	return ctx.GetStub().SetEvent(atomFabricEventName(kind, "Locked"), payload)
}

func (x *XBridgeBc3) AtomUnlock(
	ctx contractapi.TransactionContextInterface,
	invokeID string,
	hashKeyHex string,
	kind string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	state := &HotelBooking{}
	pending, err := x.getPending(ctx, invokeID)
	if err != nil {
		return err
	}
	if err := state.UnlockState(ctx, invokeID); err != nil {
		return err
	}
	amount := pending.AmountA
	if amount == 0 {
		amount = pending.AmountB
	}
	if _, err := state.BookLocal(ctx, pending.User, amount); err != nil {
		return err
	}
	if err := x.deletePending(ctx, invokeID); err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		InvokeID   string `json:"invokeId"`
		HashKeyHex string `json:"hashKeyHex"`
		Kind       string `json:"kind"`
		Undo       bool   `json:"undo"`
	}{
		InvokeID:   invokeID,
		HashKeyHex: hashKeyHex,
		Kind:       kind,
		Undo:       false,
	})
	return ctx.GetStub().SetEvent(atomFabricEventName(kind, "Unlocked"), payload)
}

func (x *XBridgeBc3) AtomUndoUnlock(
	ctx contractapi.TransactionContextInterface,
	invokeID string,
	hashKeyHex string,
	kind string,
) error {
	if err := x.ensureRelayer(ctx); err != nil {
		return err
	}
	state := &HotelBooking{}
	if err := state.UnlockState(ctx, invokeID); err != nil {
		return err
	}
	if err := x.deletePending(ctx, invokeID); err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		InvokeID   string `json:"invokeId"`
		HashKeyHex string `json:"hashKeyHex"`
		Kind       string `json:"kind"`
		Undo       bool   `json:"undo"`
	}{
		InvokeID:   invokeID,
		HashKeyHex: hashKeyHex,
		Kind:       kind,
		Undo:       true,
	})
	return ctx.GetStub().SetEvent(atomFabricEventName(kind, "UndoUnlocked"), payload)
}

func (x *XBridgeBc3) ensureRelayer(ctx contractapi.TransactionContextInterface) error {
	meta, err := x.getMeta(ctx)
	if err != nil {
		return err
	}
	msp, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return err
	}
	if msp != meta.RelayerMSP {
		return fmt.Errorf("not relayer: caller MSP=%s expected=%s", msp, meta.RelayerMSP)
	}
	return nil
}

func (x *XBridgeBc3) getMeta(ctx contractapi.TransactionContextInterface) (*bridgeMeta, error) {
	raw, err := ctx.GetStub().GetState(bridgeMetaKey)
	if err != nil || raw == nil {
		return nil, fmt.Errorf("xbridge not initialised")
	}
	var meta bridgeMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func (x *XBridgeBc3) putMeta(ctx contractapi.TransactionContextInterface, meta *bridgeMeta) error {
	raw, _ := json.Marshal(meta)
	return ctx.GetStub().PutState(bridgeMetaKey, raw)
}

func (x *XBridgeBc3) pendingKey(id string) string {
	return fmt.Sprintf(keyBridgePending, id)
}

func (x *XBridgeBc3) putPending(ctx contractapi.TransactionContextInterface, id string, pending *bridgePendingOp) error {
	raw, _ := json.Marshal(pending)
	return ctx.GetStub().PutState(x.pendingKey(id), raw)
}

func (x *XBridgeBc3) getPending(ctx contractapi.TransactionContextInterface, id string) (*bridgePendingOp, error) {
	raw, err := ctx.GetStub().GetState(x.pendingKey(id))
	if err != nil || raw == nil {
		return nil, fmt.Errorf("pending op not found: %s", id)
	}
	var pending bridgePendingOp
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}
	if !pending.Active {
		return nil, fmt.Errorf("pending op inactive: %s", id)
	}
	return &pending, nil
}

func (x *XBridgeBc3) deletePending(ctx contractapi.TransactionContextInterface, id string) error {
	return ctx.GetStub().DelState(x.pendingKey(id))
}

func (x *XBridgeBc3) relayerUser(ctx contractapi.TransactionContextInterface) string {
	id, err := ctx.GetClientIdentity().GetID()
	if err != nil || id == "" {
		return "fabric-relayer"
	}
	return id
}

func bytesToHex(value []byte) string {
	const table = "0123456789abcdef"
	out := make([]byte, len(value)*2)
	for i, b := range value {
		out[i*2] = table[b>>4]
		out[i*2+1] = table[b&0x0f]
	}
	return string(out)
}

func atomFabricEventName(kind string, suffix string) string {
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
