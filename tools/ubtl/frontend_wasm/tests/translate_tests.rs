#![recursion_limit = "512"]

use serde_json::json;
use ubtl_frontend_wasm::{selector4, translate_value};
use ubtl_ir::{Effect, IRType, NativeEncoding};

#[test]
fn translates_ink_metadata_fixture_into_storage_and_signatures() {
    let root = train_booking_fixture();
    let ir = translate_value(&root, None).expect("translation should succeed");

    let slots = ir
        .storage
        .slots
        .iter()
        .map(|slot| (slot.id.clone(), slot.ty.clone(), slot.native_offset))
        .collect::<Vec<_>>();

    assert_eq!(slots.len(), 8);
    assert_eq!(slots[0].0, "bridge");
    assert!(matches!(slots[0].1, IRType::Address));
    assert_eq!(slots[2].0, "remain");
    assert!(matches!(slots[2].1, IRType::U64));
    assert_eq!(slots[3].0, "locks");
    assert!(matches!(slots[3].1, IRType::Map { .. }));
    assert_eq!(slots[4].0, "locked_total");
    assert!(matches!(slots[4].1, IRType::U128));

    for slot in &ir.storage.slots {
        assert!(matches!(
            slot.native_encoding,
            NativeEncoding::WasmMap { .. }
        ));
    }

    let get_price = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "get_price")
        .expect("get_price should exist");
    assert_eq!(get_price.selector4, selector4("get_price()"));
    assert_eq!(
        get_price.effects,
        vec![Effect::Read {
            slot: "price".to_string()
        }]
    );
    assert_eq!(get_price.outputs, vec![IRType::U128]);

    let lock_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "lock_state")
        .expect("lock_state should exist");
    assert_eq!(
        lock_state.selector4,
        selector4("lock_state(uint64,uint64,uint32)")
    );
    assert!(lock_state.effects.contains(&Effect::Read {
        slot: "bridge".to_string()
    }));
    assert!(lock_state.effects.contains(&Effect::Read {
        slot: "lock_size".to_string()
    }));
    assert!(lock_state.effects.contains(&Effect::Write {
        slot: "locks".to_string()
    }));
    assert!(lock_state.effects.contains(&Effect::Write {
        slot: "locked_total".to_string()
    }));
    assert_eq!(lock_state.outputs, vec![IRType::Tuple(vec![IRType::U128, IRType::U64])]);

    let book_local = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "book_local")
        .expect("book_local should exist");
    assert_eq!(
        book_local.selector4,
        selector4("book_local(address,uint64)")
    );
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "remain".to_string()
    }));
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "accounts".to_string()
    }));
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "bookings".to_string()
    }));
}

#[test]
fn unwraps_result_return_types_from_metadata_registry() {
    let root = train_booking_fixture();
    let ir = translate_value(&root, None).expect("translation should succeed");

    let update_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "update_state")
        .expect("update_state should exist");
    assert!(update_state.outputs.is_empty());

    let unlock_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "unlock_state")
        .expect("unlock_state should exist");
    assert!(unlock_state.outputs.is_empty());
}

#[test]
fn rejects_floating_point_metadata_types() {
    let mut root = train_booking_fixture();
    root["metadata"]["types"].as_array_mut().unwrap().push(json!({
        "id": 99,
        "type": {"path": [], "params": [], "def": {"primitive": "f64"}}
    }));

    let err = translate_value(&root, None).expect_err("floating point metadata should be rejected");
    assert!(err.contains("Untranslatable"));
    assert!(err.contains("floating point"));
}

#[test]
fn rejects_unbounded_sequence_metadata_types() {
    let mut root = train_booking_fixture();
    root["metadata"]["types"].as_array_mut().unwrap().push(json!({
        "id": 100,
        "type": {"path": [], "params": [], "def": {"sequence": {"type": 3}}}
    }));

    let err = translate_value(&root, None).expect_err("unbounded sequence metadata should be rejected");
    assert!(err.contains("Untranslatable"));
    assert!(err.contains("unbounded sequence"));
}

fn train_booking_fixture() -> serde_json::Value {
    json!({
        "version": "ink! 5.0.0",
        "contract": {
            "name": "TrainBooking"
        },
        "metadata": {
            "types": [
                {"id": 1, "type": {"path": ["ink_primitives", "types", "AccountId"], "params": [], "def": {"composite": {"fields": []}}}},
                {"id": 2, "type": {"path": [], "params": [], "def": {"primitive": "u128"}}},
                {"id": 3, "type": {"path": [], "params": [], "def": {"primitive": "u64"}}},
                {"id": 4, "type": {"path": [], "params": [], "def": {"primitive": "u32"}}},
                {"id": 5, "type": {"path": [], "params": [], "def": {"primitive": "bool"}}},
                {"id": 6, "type": {"path": ["train_booking", "LockEntry"], "params": [], "def": {"composite": {"fields": [
                    {"name": "locked_amount", "type": 2},
                    {"name": "lock_block", "type": 4},
                    {"name": "timeout_blocks", "type": 4},
                    {"name": "active", "type": 5}
                ]}}}},
                {"id": 7, "type": {"path": ["ink", "storage", "Mapping"], "params": [{"type": 3}, {"type": 6}], "def": {"composite": {"fields": []}}}},
                {"id": 8, "type": {"path": ["ink", "storage", "Mapping"], "params": [{"type": 1}, {"type": 2}], "def": {"composite": {"fields": []}}}},
                {"id": 9, "type": {"path": ["ink", "storage", "Mapping"], "params": [{"type": 1}, {"type": 3}], "def": {"composite": {"fields": []}}}},
                {"id": 10, "type": {"path": ["core", "result", "Result"], "params": [{"type": 2}, {"type": 12}], "def": {"variant": {}}}},
                {"id": 11, "type": {"path": ["core", "result", "Result"], "params": [{"type": 13}, {"type": 12}], "def": {"variant": {}}}},
                {"id": 12, "type": {"path": ["train_booking", "Error"], "params": [], "def": {"variant": {}}}},
                {"id": 13, "type": {"path": [], "params": [], "def": {"tuple": {"fields": [{"type": 2}, {"type": 3}]}}}},
                {"id": 15, "type": {"path": [], "params": [], "def": {"tuple": {"fields": []}}}},
                {"id": 14, "type": {"path": ["core", "result", "Result"], "params": [{"type": 15}, {"type": 12}], "def": {"variant": {}}}}
            ],
            "storage": {
                "root": {
                    "layout": {
                        "struct": {
                            "fields": [
                                {"name": "bridge", "layout": {"leaf": {"ty": 1}}},
                                {"name": "price", "layout": {"leaf": {"ty": 2}}},
                                {"name": "remain", "layout": {"leaf": {"ty": 3}}},
                                {"name": "locks", "layout": {"leaf": {"ty": 7}}},
                                {"name": "locked_total", "layout": {"leaf": {"ty": 2}}},
                                {"name": "accounts", "layout": {"leaf": {"ty": 8}}},
                                {"name": "bookings", "layout": {"leaf": {"ty": 9}}},
                                {"name": "lock_size", "layout": {"leaf": {"ty": 3}}}
                            ]
                        }
                    }
                }
            },
            "spec": {
                "messages": [
                    {
                        "label": "get_price",
                        "mutates": false,
                        "args": [],
                        "returnType": {"type": 2}
                    },
                    {
                        "label": "book_local",
                        "mutates": true,
                        "args": [
                            {"label": "user", "type": {"type": 1}},
                            {"label": "num", "type": {"type": 3}}
                        ],
                        "returnType": {"type": 10}
                    },
                    {
                        "label": "lock_state",
                        "mutates": true,
                        "args": [
                            {"label": "id", "type": {"type": 3}},
                            {"label": "num", "type": {"type": 3}},
                            {"label": "timeout", "type": {"type": 4}}
                        ],
                        "returnType": {"type": 11}
                    },
                    {
                        "label": "update_state",
                        "mutates": true,
                        "args": [
                            {"label": "id", "type": {"type": 3}},
                            {"label": "new_remain", "type": {"type": 3}},
                            {"label": "user", "type": {"type": 1}},
                            {"label": "num", "type": {"type": 3}},
                            {"label": "total_cost", "type": {"type": 2}}
                        ],
                        "returnType": {"type": 14}
                    },
                    {
                        "label": "unlock_state",
                        "mutates": true,
                        "args": [
                            {"label": "id", "type": {"type": 3}}
                        ],
                        "returnType": {"type": 14}
                    }
                ]
            }
        }
    })
}
