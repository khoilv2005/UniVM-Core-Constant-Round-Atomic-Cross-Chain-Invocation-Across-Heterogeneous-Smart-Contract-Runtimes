// HotelBooking chaincode on Fabric (bc3) for XSmartContract heterogeneous testbed.
// Interface parity with Solidity SHotel.sol+LHotel.sol so that XSmartContract
// UBTL can translate this Go chaincode to EVM bytecode.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

const (
	keyMeta      = "META"
	keyAccount   = "ACCOUNT_%s"
	keyBooking   = "BOOKING_%s"
	keyLockEntry = "LOCK_%s"
	keyLockTotal = "LOCK_TOTAL"

	hotelContractName = "HotelBooking"
	hotelIRHashHex    = "0x1471a6f5144bc6d79dfcd9410fb81ddabada6deb0664c46be1b23af558521bbb"
)

type hotelMeta struct {
	Bridge   string `json:"bridge"`
	Price    uint64 `json:"price"`
	Remain   uint64 `json:"remain"`
	LockSize uint64 `json:"lockSize"`
}
type lockEntry struct {
	LockedAmount  uint64 `json:"lockedAmount"`
	LockBlock     uint64 `json:"lockBlock"`
	TimeoutBlocks uint64 `json:"timeoutBlocks"`
	Active        bool   `json:"active"`
}

type HotelBooking struct{ contractapi.Contract }

func (h *HotelBooking) InitLedger(ctx contractapi.TransactionContextInterface,
	bridgeMSP string, price, remain, lockSize uint64) error {
	if price == 0 {
		return fmt.Errorf("price must be > 0")
	}
	if lockSize == 0 {
		lockSize = 1
	}
	if err := ctx.GetStub().PutState(keyLockTotal, []byte("0")); err != nil {
		return err
	}
	return h.putMeta(ctx, &hotelMeta{bridgeMSP, price, remain, lockSize})
}

func (h *HotelBooking) GetPrice(ctx contractapi.TransactionContextInterface) (uint64, error) {
	m, err := h.getMeta(ctx)
	if err != nil {
		return 0, err
	}
	return m.Price, nil
}
func (h *HotelBooking) GetRemain(ctx contractapi.TransactionContextInterface) (uint64, error) {
	m, err := h.getMeta(ctx)
	if err != nil {
		return 0, err
	}
	return m.Remain, nil
}
func (h *HotelBooking) GetAvailableRemain(ctx contractapi.TransactionContextInterface) (uint64, error) {
	m, err := h.getMeta(ctx)
	if err != nil {
		return 0, err
	}
	lt, _ := h.getU64(ctx, keyLockTotal)
	lockedRooms := lt / m.Price
	if lockedRooms >= m.Remain {
		return 0, nil
	}
	return m.Remain - lockedRooms, nil
}
func (h *HotelBooking) GetAccountBalance(ctx contractapi.TransactionContextInterface, user string) (uint64, error) {
	return h.getU64(ctx, fmt.Sprintf(keyAccount, user))
}
func (h *HotelBooking) GetBooking(ctx contractapi.TransactionContextInterface, user string) (uint64, error) {
	return h.getU64(ctx, fmt.Sprintf(keyBooking, user))
}
func (h *HotelBooking) GetIrHash(ctx contractapi.TransactionContextInterface) (string, error) {
	return hotelIRHashHex, nil
}
func (h *HotelBooking) IsStateLocked(ctx contractapi.TransactionContextInterface, id string) (bool, error) {
	e, _ := h.getLockEntry(ctx, id)
	if e == nil {
		return false, nil
	}
	return e.Active, nil
}
func (h *HotelBooking) GetLockedTotal(ctx contractapi.TransactionContextInterface) (uint64, error) {
	return h.getU64(ctx, keyLockTotal)
}
func (h *HotelBooking) GetLockAmount(ctx contractapi.TransactionContextInterface, id string) (uint64, error) {
	e, _ := h.getLockEntry(ctx, id)
	if e == nil {
		return 0, nil
	}
	return e.LockedAmount, nil
}
func (h *HotelBooking) GetBridge(ctx contractapi.TransactionContextInterface) (string, error) {
	m, err := h.getMeta(ctx)
	if err != nil {
		return "", err
	}
	return m.Bridge, nil
}
func (h *HotelBooking) GetLockSize(ctx contractapi.TransactionContextInterface) (uint64, error) {
	m, err := h.getMeta(ctx)
	if err != nil {
		return 0, err
	}
	return m.LockSize, nil
}

func (h *HotelBooking) BookLocal(ctx contractapi.TransactionContextInterface, user string, num uint64) (uint64, error) {
	if num == 0 {
		return 0, fmt.Errorf("zero amount")
	}
	av, err := h.GetAvailableRemain(ctx)
	if err != nil {
		return 0, err
	}
	if av < num {
		return 0, fmt.Errorf("insufficient available rooms")
	}
	m, _ := h.getMeta(ctx)
	cost := m.Price * num
	m.Remain -= num
	if err := h.putMeta(ctx, m); err != nil {
		return 0, err
	}
	if err := h.addU64(ctx, fmt.Sprintf(keyAccount, user), cost); err != nil {
		return 0, err
	}
	if err := h.addU64(ctx, fmt.Sprintf(keyBooking, user), num); err != nil {
		return 0, err
	}
	return cost, nil
}

func (h *HotelBooking) VasspEncodeState(ctx contractapi.TransactionContextInterface, id string) ([]byte, error) {
	_ = id

	meta, err := h.getMeta(ctx)
	if err != nil {
		return nil, err
	}
	lockTotal, err := h.getU64(ctx, keyLockTotal)
	if err != nil {
		return nil, err
	}

	pairs := []vasspPair{
		{
			SlotID: vasspSlotID(hotelContractName, keyMeta),
			ABIValue: vasspEncodeMetaTuple(
				meta.Bridge,
				meta.Price,
				meta.Remain,
				meta.LockSize,
			),
		},
		{
			SlotID:   vasspSlotID(hotelContractName, keyLockTotal),
			ABIValue: vasspEncodeUint256(lockTotal),
		},
	}
	return vasspEncode(pairs)
}

func (h *HotelBooking) LockState(ctx contractapi.TransactionContextInterface,
	id string, numRooms, timeoutBlocks uint64) error {
	_, _, _, err := h.lockStateInternal(ctx, id, numRooms, timeoutBlocks)
	return err
}

func (h *HotelBooking) lockStateInternal(ctx contractapi.TransactionContextInterface,
	id string, numRooms, timeoutBlocks uint64) ([]byte, string, []byte, error) {
	if err := h.ensureBridge(ctx); err != nil {
		return nil, "", nil, err
	}
	if e, _ := h.getLockEntry(ctx, id); e != nil && e.Active {
		return nil, "", nil, fmt.Errorf("already locked")
	}
	av, err := h.GetAvailableRemain(ctx)
	if err != nil {
		return nil, "", nil, err
	}
	if av < numRooms {
		return nil, "", nil, fmt.Errorf("insufficient remain for lock")
	}
	m, _ := h.getMeta(ctx)
	amt := m.LockSize * m.Price
	if numRooms > 0 {
		amt = numRooms * m.Price
	}
	now := h.logicalBlock(ctx)
	if err := h.putLockEntry(ctx, id, &lockEntry{amt, now, timeoutBlocks, true}); err != nil {
		return nil, "", nil, err
	}
	if err := h.addU64(ctx, keyLockTotal, amt); err != nil {
		return nil, "", nil, err
	}
	_ = ctx.GetStub().SetEvent("StateLocked", encodeEvent(id, numRooms, amt))
	encodedState, err := h.VasspEncodeState(ctx, id)
	if err != nil {
		return nil, "", nil, err
	}
	return encodedState, hotelIRHashHex, []byte{}, nil
}

func (h *HotelBooking) UpdateState(ctx contractapi.TransactionContextInterface,
	id string, newRemain uint64, user string, num, totalCost uint64) error {
	if err := h.ensureBridge(ctx); err != nil {
		return err
	}
	if err := h.unlockInternal(ctx, id); err != nil {
		return err
	}
	m, err := h.getMeta(ctx)
	if err != nil {
		return err
	}
	m.Remain = newRemain
	if err := h.putMeta(ctx, m); err != nil {
		return err
	}
	if err := h.addU64(ctx, fmt.Sprintf(keyAccount, user), totalCost); err != nil {
		return err
	}
	if err := h.addU64(ctx, fmt.Sprintf(keyBooking, user), num); err != nil {
		return err
	}
	return ctx.GetStub().SetEvent("StateUpdated", encodeEvent(id, num, totalCost))
}

func (h *HotelBooking) UnlockState(ctx contractapi.TransactionContextInterface, id string) error {
	if err := h.ensureBridge(ctx); err != nil {
		return err
	}
	if err := h.unlockInternal(ctx, id); err != nil {
		return err
	}
	return ctx.GetStub().SetEvent("StateUnlocked", []byte(id))
}

func (h *HotelBooking) UnlockOnTimeout(ctx contractapi.TransactionContextInterface, id string) error {
	e, _ := h.getLockEntry(ctx, id)
	if e == nil || !e.Active {
		return fmt.Errorf("not locked")
	}
	if h.logicalBlock(ctx) <= e.LockBlock+e.TimeoutBlocks {
		return fmt.Errorf("not timed out")
	}
	return h.unlockInternal(ctx, id)
}

func (h *HotelBooking) SetBridge(ctx contractapi.TransactionContextInterface, newBridge string) error {
	if err := h.ensureBridge(ctx); err != nil {
		return err
	}
	m, err := h.getMeta(ctx)
	if err != nil {
		return err
	}
	m.Bridge = newBridge
	return h.putMeta(ctx, m)
}

// ===== internal =====

func (h *HotelBooking) ensureBridge(ctx contractapi.TransactionContextInterface) error {
	m, err := h.getMeta(ctx)
	if err != nil {
		return err
	}
	msp, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return err
	}
	if msp != m.Bridge {
		return fmt.Errorf("not bridge: caller MSP=%s expected=%s", msp, m.Bridge)
	}
	return nil
}

func (h *HotelBooking) unlockInternal(ctx contractapi.TransactionContextInterface, id string) error {
	e, _ := h.getLockEntry(ctx, id)
	if e == nil || !e.Active {
		return fmt.Errorf("not locked")
	}
	if err := h.subU64(ctx, keyLockTotal, e.LockedAmount); err != nil {
		return err
	}
	return ctx.GetStub().DelState(fmt.Sprintf(keyLockEntry, id))
}

func (h *HotelBooking) logicalBlock(ctx contractapi.TransactionContextInterface) uint64 {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil || ts == nil {
		return 0
	}
	return uint64(ts.Seconds)
}

func (h *HotelBooking) getMeta(ctx contractapi.TransactionContextInterface) (*hotelMeta, error) {
	raw, err := ctx.GetStub().GetState(keyMeta)
	if err != nil || raw == nil {
		return nil, fmt.Errorf("not initialised")
	}
	var m hotelMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &m, nil
}
func (h *HotelBooking) putMeta(ctx contractapi.TransactionContextInterface, m *hotelMeta) error {
	b, _ := json.Marshal(m)
	return ctx.GetStub().PutState(keyMeta, b)
}
func (h *HotelBooking) getLockEntry(ctx contractapi.TransactionContextInterface, id string) (*lockEntry, error) {
	raw, err := ctx.GetStub().GetState(fmt.Sprintf(keyLockEntry, id))
	if err != nil || raw == nil {
		return nil, err
	}
	var e lockEntry
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, err
	}
	return &e, nil
}
func (h *HotelBooking) putLockEntry(ctx contractapi.TransactionContextInterface, id string, e *lockEntry) error {
	b, _ := json.Marshal(e)
	return ctx.GetStub().PutState(fmt.Sprintf(keyLockEntry, id), b)
}
func (h *HotelBooking) getU64(ctx contractapi.TransactionContextInterface, key string) (uint64, error) {
	raw, err := ctx.GetStub().GetState(key)
	if err != nil || raw == nil {
		return 0, err
	}
	return strconv.ParseUint(string(raw), 10, 64)
}
func (h *HotelBooking) addU64(ctx contractapi.TransactionContextInterface, key string, d uint64) error {
	cur, _ := h.getU64(ctx, key)
	return ctx.GetStub().PutState(key, []byte(strconv.FormatUint(cur+d, 10)))
}
func (h *HotelBooking) subU64(ctx contractapi.TransactionContextInterface, key string, d uint64) error {
	cur, _ := h.getU64(ctx, key)
	if d > cur {
		d = cur
	}
	return ctx.GetStub().PutState(key, []byte(strconv.FormatUint(cur-d, 10)))
}

func encodeEvent(id string, a, b uint64) []byte {
	out, _ := json.Marshal(struct {
		ID string `json:"crosschainTxId"`
		A  uint64 `json:"a"`
		B  uint64 `json:"b"`
	}{id, a, b})
	return out
}

func main() {
	cc, err := contractapi.NewChaincode(&HotelBooking{}, &XBridgeBc3{}, &AuctionLogic{})
	if err != nil {
		panic(err)
	}
	if address := os.Getenv("CHAINCODE_SERVER_ADDRESS"); address != "" {
		ccid := os.Getenv("CHAINCODE_ID")
		if ccid == "" {
			panic("CHAINCODE_ID is required when CHAINCODE_SERVER_ADDRESS is set")
		}
		server := &shim.ChaincodeServer{
			CCID:    ccid,
			Address: address,
			CC:      cc,
			TLSProps: shim.TLSProperties{
				Disabled: true,
			},
		}
		if err := server.Start(); err != nil {
			panic(err)
		}
		return
	}
	if err := cc.Start(); err != nil {
		panic(err)
	}
}
