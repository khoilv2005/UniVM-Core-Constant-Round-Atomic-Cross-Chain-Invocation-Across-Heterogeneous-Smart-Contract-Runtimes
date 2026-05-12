use ubtl_frontend_fabric::{selector4, translate_source};
use ubtl_ir::{Effect, IRType, Mutability, NativeEncoding};

const HOTEL_BOOKING_FIXTURE: &str = r#"
package main

import (
    "fmt"

    "github.com/hyperledger/fabric-contract-api-go/contractapi"
)

const (
    keyMeta      = "META"
    keyAccount   = "ACCOUNT_%s"
    keyBooking   = "BOOKING_%s"
    keyLockEntry = "LOCK_%s"
    keyLockTotal = "LOCK_TOTAL"
)

type hotelMeta struct {
    Bridge   string
    Price    uint64
    Remain   uint64
    LockSize uint64
}

type lockEntry struct {
    LockedAmount  uint64
    LockBlock     uint64
    TimeoutBlocks uint64
    Active        bool
}

type HotelBooking struct{ contractapi.Contract }

func (h *HotelBooking) GetPrice(ctx contractapi.TransactionContextInterface) (uint64, error) {
    m, err := h.getMeta(ctx)
    if err != nil {
        return 0, err
    }
    return m.Price, nil
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

func (h *HotelBooking) LockState(
    ctx contractapi.TransactionContextInterface,
    id string,
    numRooms, timeoutBlocks uint64,
) (uint64, uint64, error) {
    if err := h.ensureBridge(ctx); err != nil {
        return 0, 0, err
    }
    if e, _ := h.getLockEntry(ctx, id); e != nil && e.Active {
        return 0, 0, fmt.Errorf("already locked")
    }
    av, err := h.GetAvailableRemain(ctx)
    if err != nil {
        return 0, 0, err
    }
    if av < numRooms {
        return 0, 0, fmt.Errorf("insufficient remain for lock")
    }
    m, _ := h.getMeta(ctx)
    amt := m.LockSize * m.Price
    if numRooms > 0 {
        amt = numRooms * m.Price
    }
    now := h.logicalBlock(ctx)
    if err := h.putLockEntry(ctx, id, &lockEntry{amt, now, timeoutBlocks, true}); err != nil {
        return 0, 0, err
    }
    if err := h.addU64(ctx, keyLockTotal, amt); err != nil {
        return 0, 0, err
    }
    return m.Price, m.Remain, nil
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
    return nil
}
"#;

#[test]
fn translates_fabric_chaincode_fixture_into_ir() {
    let ir = translate_source(HOTEL_BOOKING_FIXTURE).expect("fixture should translate");

    assert_eq!(ir.meta.name, "HotelBooking");
    assert_eq!(ir.storage.slots.len(), 5);
    assert_eq!(ir.cfg.blocks.len(), ir.signatures.len());

    assert_eq!(ir.storage.slots[0].id, "META");
    assert_eq!(
        ir.storage.slots[0].native_encoding,
        NativeEncoding::FabricKey {
            pattern: "META".to_string()
        }
    );
    assert_eq!(
        ir.storage.slots[1].ty,
        IRType::Map {
            key: Box::new(IRType::String),
            val: Box::new(IRType::U64)
        }
    );
    assert_eq!(
        ir.storage.slots[3].id,
        "LOCK_%s"
    );

    let get_price = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "GetPrice")
        .expect("GetPrice signature");
    assert_eq!(get_price.selector4, selector4("GetPrice()"));
    assert_eq!(get_price.inputs, vec![]);
    assert_eq!(get_price.outputs, vec![IRType::U64]);
    assert_eq!(get_price.mutability, Mutability::View);
    assert_eq!(
        get_price.effects,
        vec![Effect::Read {
            slot: "META".to_string()
        }]
    );

    let get_available = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "GetAvailableRemain")
        .expect("GetAvailableRemain signature");
    assert_eq!(get_available.inputs, vec![]);
    assert_eq!(get_available.outputs, vec![IRType::U64]);
    assert_eq!(get_available.mutability, Mutability::View);
    assert_eq!(
        get_available.effects,
        vec![
            Effect::Read {
                slot: "LOCK_TOTAL".to_string()
            },
            Effect::Read {
                slot: "META".to_string()
            }
        ]
    );

    let lock_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "LockState")
        .expect("LockState signature");
    assert_eq!(
        lock_state.inputs,
        vec![IRType::String, IRType::U64, IRType::U64]
    );
    assert_eq!(lock_state.outputs, vec![IRType::U64, IRType::U64]);
    assert_eq!(lock_state.mutability, Mutability::NonPayable);
    assert_eq!(
        lock_state.effects,
        vec![
            Effect::Read {
                slot: "LOCK_%s".to_string()
            },
            Effect::Read {
                slot: "LOCK_TOTAL".to_string()
            },
            Effect::Read {
                slot: "META".to_string()
            },
            Effect::Write {
                slot: "LOCK_%s".to_string()
            },
            Effect::Write {
                slot: "LOCK_TOTAL".to_string()
            }
        ]
    );

    let update_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "UpdateState")
        .expect("UpdateState signature");
    assert_eq!(
        update_state.inputs,
        vec![
            IRType::String,
            IRType::U64,
            IRType::String,
            IRType::U64,
            IRType::U64
        ]
    );
    assert_eq!(update_state.outputs, Vec::<IRType>::new());
    assert_eq!(update_state.mutability, Mutability::NonPayable);
    assert_eq!(
        update_state.effects,
        vec![
            Effect::Read {
                slot: "ACCOUNT_%s".to_string()
            },
            Effect::Read {
                slot: "BOOKING_%s".to_string()
            },
            Effect::Read {
                slot: "LOCK_%s".to_string()
            },
            Effect::Read {
                slot: "LOCK_TOTAL".to_string()
            },
            Effect::Read {
                slot: "META".to_string()
            },
            Effect::Write {
                slot: "ACCOUNT_%s".to_string()
            },
            Effect::Write {
                slot: "BOOKING_%s".to_string()
            },
            Effect::Write {
                slot: "LOCK_%s".to_string()
            },
            Effect::Write {
                slot: "LOCK_TOTAL".to_string()
            },
            Effect::Write {
                slot: "META".to_string()
            }
        ]
    );
}

#[test]
fn rejects_untranslatable_network_io() {
    let source = r#"
package main

import "net/http"

type HotelBooking struct{}

func (h *HotelBooking) CallExternal() error {
    _, err := http.Get("https://example.com")
    return err
}
"#;

    let err = translate_source(source).expect_err("network I/O should be rejected");
    assert!(err.contains("Untranslatable"));
    assert!(err.contains("network I/O"));
}

#[test]
fn rejects_floating_point_constructs() {
    let source = r#"
package main

type AuctionLogic struct{}

func (a *AuctionLogic) Score(x float64) (float64, error) {
    return x * 1.5, nil
}
"#;

    let err = translate_source(source).expect_err("floating point should be rejected");
    assert!(err.contains("Untranslatable"));
    assert!(err.contains("floating point"));
}

#[test]
fn rejects_unbounded_loop_constructs() {
    let source = r#"
package main

type AuctionLogic struct{}

func (a *AuctionLogic) Spin() error {
    for {
    }
    return nil
}
"#;

    let err = translate_source(source).expect_err("unbounded loop should be rejected");
    assert!(err.contains("Untranslatable"));
    assert!(err.contains("unbounded loop"));
}
