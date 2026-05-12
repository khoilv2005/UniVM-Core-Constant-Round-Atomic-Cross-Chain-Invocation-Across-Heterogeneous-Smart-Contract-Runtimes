#![recursion_limit = "512"]

use serde_json::json;
use ubtl_frontend_evm::{selector4, translate_value};
use ubtl_ir::{Effect, IRType};

#[test]
fn translates_s_hotel_fixture_with_fallback_storage_and_effects() {
    let root = shotel_fixture(None);
    let ir = translate_value(&root, None, Some("SHotel")).expect("translation should succeed");

    let storage_ids = ir
        .storage
        .slots
        .iter()
        .map(|slot| slot.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        storage_ids,
        vec![
            "bridgingContract",
            "lockSize",
            "_lockPool",
            "authorizedProviders",
            "price",
            "remain",
            "addrLHotel",
            "accounts",
            "bookings"
        ]
    );

    let lock_pool_slot = ir
        .storage
        .slots
        .iter()
        .find(|slot| slot.id == "_lockPool")
        .expect("_lockPool slot should exist");
    assert!(matches!(lock_pool_slot.ty, IRType::Tuple(_)));

    let get_price = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "getPrice")
        .expect("getPrice signature should exist");
    assert_eq!(get_price.selector4, selector4("getPrice()"));
    assert_eq!(
        get_price.effects,
        vec![Effect::Read {
            slot: "price".to_string()
        }]
    );

    let lock_state = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "lockState")
        .expect("lockState signature should exist");
    assert_eq!(lock_state.selector4, selector4("lockState(bytes)"));
    assert!(lock_state.effects.contains(&Effect::Read {
        slot: "_lockPool".to_string()
    }));
    assert!(lock_state.effects.contains(&Effect::Read {
        slot: "remain".to_string()
    }));
    assert!(lock_state.effects.contains(&Effect::Write {
        slot: "_lockPool".to_string()
    }));

    let book_local = ir
        .signatures
        .iter()
        .find(|signature| signature.name == "bookLocal")
        .expect("bookLocal signature should exist");
    assert!(book_local.effects.contains(&Effect::Read {
        slot: "addrLHotel".to_string()
    }));
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "remain".to_string()
    }));
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "accounts".to_string()
    }));
    assert!(book_local.effects.contains(&Effect::Write {
        slot: "bookings".to_string()
    }));
    assert!(book_local.effects.iter().any(|effect| matches!(
        effect,
        Effect::Call { external_id } if external_id.starts_with("ext_book_")
    )));

    assert!(
        ir.externals
            .iter()
            .any(|external| external.selector4 == selector4("book(uint256,uint256,uint256)"))
    );
}

#[test]
fn prefers_storage_layout_offsets_when_present() {
    let root = shotel_fixture(Some(json!({
        "storage": [
            {"label": "bridgingContract", "slot": "0", "type": "t_address"},
            {"label": "lockSize", "slot": "1", "type": "t_uint256"},
            {"label": "_lockPool", "slot": "2", "type": "t_struct$_LockPool_$1_storage"},
            {"label": "authorizedProviders", "slot": "4", "type": "t_mapping$_t_address_$_t_bool_$"},
            {"label": "price", "slot": "9", "type": "t_uint256"},
            {"label": "remain", "slot": "10", "type": "t_uint256"},
            {"label": "addrLHotel", "slot": "11", "type": "t_address"},
            {"label": "accounts", "slot": "12", "type": "t_mapping$_t_address_$_t_uint256_$"},
            {"label": "bookings", "slot": "13", "type": "t_mapping$_t_address_$_t_uint256_$"}
        ],
        "types": {
            "t_address": {"label": "address", "encoding": "inplace"},
            "t_uint256": {"label": "uint256", "encoding": "inplace"},
            "t_bool": {"label": "bool", "encoding": "inplace"},
            "t_mapping$_t_address_$_t_bool_$": {
                "label": "mapping(address => bool)",
                "encoding": "mapping",
                "key": "t_address",
                "value": "t_bool"
            },
            "t_mapping$_t_address_$_t_uint256_$": {
                "label": "mapping(address => uint256)",
                "encoding": "mapping",
                "key": "t_address",
                "value": "t_uint256"
            },
            "t_mapping$_t_uint256_$_t_struct$_LockBag_$2_storage_$": {
                "label": "mapping(uint256 => struct LockPoolLib.LockBag)",
                "encoding": "mapping",
                "key": "t_uint256",
                "value": "t_struct$_LockBag_$2_storage"
            },
            "t_struct$_LockBag_$2_storage": {
                "label": "struct LockPoolLib.LockBag",
                "encoding": "inplace",
                "members": [
                    {"label": "amount", "slot": "0", "type": "t_uint256"},
                    {"label": "timeoutBlocks", "slot": "1", "type": "t_uint256"}
                ]
            },
            "t_struct$_LockPool_$1_storage": {
                "label": "struct LockPoolLib.LockPool",
                "encoding": "inplace",
                "members": [
                    {"label": "bags", "slot": "0", "type": "t_mapping$_t_uint256_$_t_struct$_LockBag_$2_storage_$"},
                    {"label": "lockedTotal", "slot": "1", "type": "t_uint256"}
                ]
            }
        }
    })));

    let ir = translate_value(&root, None, Some("SHotel")).expect("translation should succeed");
    let price_slot = ir
        .storage
        .slots
        .iter()
        .find(|slot| slot.id == "price")
        .expect("price slot should exist");
    assert_eq!(price_slot.native_offset, 9);
}

#[test]
fn rejects_raw_bytecode_without_source_metadata() {
    let root = json!({
        "contracts": {
            "Raw.sol": {
                "Raw": {
                    "abi": [],
                    "evm": {"deployedBytecode": {"object": "0x6000"}}
                }
            }
        }
    });

    let err = translate_value(&root, None, Some("Raw"))
        .expect_err("raw bytecode without source metadata should be rejected");
    assert!(err.contains("not found in AST index") || err.contains("missing from AST sources"));
}

fn shotel_fixture(storage_layout: Option<serde_json::Value>) -> serde_json::Value {
    let mut shotel_artifact = json!({
        "abi": [
            {"type": "function", "name": "getPrice", "inputs": [], "outputs": [{"type": "uint256"}], "stateMutability": "view"},
            {"type": "function", "name": "bookLocal", "inputs": [{"name": "userAddr", "type": "address"}, {"name": "num", "type": "uint256"}], "outputs": [{"type": "uint256"}], "stateMutability": "nonpayable"},
            {"type": "function", "name": "lockState", "inputs": [{"name": "args", "type": "bytes"}], "outputs": [{"type": "uint256"}, {"type": "uint256"}], "stateMutability": "nonpayable"},
            {"type": "function", "name": "accounts", "inputs": [{"name": "", "type": "address"}], "outputs": [{"type": "uint256"}], "stateMutability": "view"}
        ],
        "evm": {
            "deployedBytecode": {
                "generatedSources": []
            }
        }
    });
    if let Some(layout) = storage_layout {
        shotel_artifact["storageLayout"] = layout;
    }

    json!({
        "solcVersion": "0.8.28",
        "output": {
            "contracts": {
                "contracts/xsmart/bc1/examples/SHotel.sol": {
                    "SHotel": shotel_artifact
                }
            },
            "sources": {
                "contracts/xsmart/bc1/lib/LockPoolLib.sol": {
                    "ast": {
                        "nodeType": "SourceUnit",
                        "nodes": [
                            {
                                "id": 300,
                                "nodeType": "ContractDefinition",
                                "name": "LockPoolLib",
                                "contractKind": "library",
                                "nodes": [
                                    {
                                        "nodeType": "StructDefinition",
                                        "name": "LockBag",
                                        "members": [
                                            {"name": "amount", "typeDescriptions": {"typeString": "uint256"}},
                                            {"name": "timeoutBlocks", "typeDescriptions": {"typeString": "uint256"}}
                                        ]
                                    },
                                    {
                                        "nodeType": "StructDefinition",
                                        "name": "LockPool",
                                        "members": [
                                            {"name": "bags", "typeDescriptions": {"typeString": "mapping(uint256 => struct LockPoolLib.LockBag)"}},
                                            {"name": "lockedTotal", "typeDescriptions": {"typeString": "uint256"}}
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                },
                "contracts/xsmart/bc1/StateContractBase.sol": {
                    "ast": {
                        "nodeType": "SourceUnit",
                        "nodes": [
                            {
                                "id": 100,
                                "nodeType": "ContractDefinition",
                                "name": "StateContractBase",
                                "nodes": [
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "bridgingContract", "typeDescriptions": {"typeString": "address"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "lockSize", "typeDescriptions": {"typeString": "uint256"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "_lockPool", "typeDescriptions": {"typeString": "struct LockPoolLib.LockPool storage ref"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "authorizedProviders", "typeDescriptions": {"typeString": "mapping(address => bool)"}}
                                ]
                            }
                        ]
                    }
                },
                "contracts/xsmart/bc1/examples/SHotel.sol": {
                    "ast": {
                        "nodeType": "SourceUnit",
                        "nodes": [
                            {
                                "id": 200,
                                "nodeType": "ContractDefinition",
                                "name": "SHotel",
                                "linearizedBaseContracts": [200, 100],
                                "nodes": [
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "price", "typeDescriptions": {"typeString": "uint256"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "remain", "typeDescriptions": {"typeString": "uint256"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "addrLHotel", "typeDescriptions": {"typeString": "address"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "accounts", "typeDescriptions": {"typeString": "mapping(address => uint256)"}},
                                    {"nodeType": "VariableDeclaration", "stateVariable": true, "name": "bookings", "typeDescriptions": {"typeString": "mapping(address => uint256)"}},
                                    {
                                        "nodeType": "FunctionDefinition",
                                        "kind": "function",
                                        "visibility": "external",
                                        "name": "getPrice",
                                        "parameters": {"parameters": []},
                                        "body": {
                                            "nodeType": "Block",
                                            "statements": [
                                                {"nodeType": "Identifier", "name": "price"}
                                            ]
                                        }
                                    },
                                    {
                                        "nodeType": "FunctionDefinition",
                                        "kind": "function",
                                        "visibility": "external",
                                        "name": "bookLocal",
                                        "parameters": {
                                            "parameters": [
                                                {"typeDescriptions": {"typeString": "address"}},
                                                {"typeDescriptions": {"typeString": "uint256"}}
                                            ]
                                        },
                                        "body": {
                                            "nodeType": "Block",
                                            "statements": [
                                                {
                                                    "nodeType": "FunctionCall",
                                                    "expression": {
                                                        "nodeType": "MemberAccess",
                                                        "memberName": "book",
                                                        "typeDescriptions": {"typeString": "function (uint256,uint256,uint256) pure external returns (uint256,uint256)"},
                                                        "expression": {
                                                            "nodeType": "FunctionCall",
                                                            "kind": "typeConversion",
                                                            "expression": {"nodeType": "Identifier", "name": "LHotel"},
                                                            "arguments": [{"nodeType": "Identifier", "name": "addrLHotel"}]
                                                        }
                                                    },
                                                    "arguments": [
                                                        {"nodeType": "Identifier", "name": "price", "typeDescriptions": {"typeString": "uint256"}},
                                                        {"nodeType": "Identifier", "name": "remain", "typeDescriptions": {"typeString": "uint256"}},
                                                        {"nodeType": "Identifier", "name": "num", "typeDescriptions": {"typeString": "uint256"}}
                                                    ]
                                                },
                                                {
                                                    "nodeType": "Assignment",
                                                    "operator": "=",
                                                    "leftHandSide": {"nodeType": "Identifier", "name": "remain"},
                                                    "rightHandSide": {"nodeType": "Identifier", "name": "newRemain"}
                                                },
                                                {
                                                    "nodeType": "Assignment",
                                                    "operator": "+=",
                                                    "leftHandSide": {
                                                        "nodeType": "IndexAccess",
                                                        "baseExpression": {"nodeType": "Identifier", "name": "accounts"},
                                                        "indexExpression": {"nodeType": "Identifier", "name": "userAddr"}
                                                    },
                                                    "rightHandSide": {"nodeType": "Identifier", "name": "totalCost"}
                                                },
                                                {
                                                    "nodeType": "Assignment",
                                                    "operator": "+=",
                                                    "leftHandSide": {
                                                        "nodeType": "IndexAccess",
                                                        "baseExpression": {"nodeType": "Identifier", "name": "bookings"},
                                                        "indexExpression": {"nodeType": "Identifier", "name": "userAddr"}
                                                    },
                                                    "rightHandSide": {"nodeType": "Identifier", "name": "num"}
                                                }
                                            ]
                                        }
                                    },
                                    {
                                        "nodeType": "FunctionDefinition",
                                        "kind": "function",
                                        "visibility": "external",
                                        "name": "lockState",
                                        "parameters": {
                                            "parameters": [
                                                {"typeDescriptions": {"typeString": "bytes calldata"}}
                                            ]
                                        },
                                        "body": {
                                            "nodeType": "Block",
                                            "statements": [
                                                {
                                                    "nodeType": "FunctionCall",
                                                    "expression": {
                                                        "nodeType": "MemberAccess",
                                                        "memberName": "getLockedTotal",
                                                        "expression": {"nodeType": "Identifier", "name": "LockPoolLib"}
                                                    },
                                                    "arguments": [
                                                        {"nodeType": "Identifier", "name": "_lockPool"}
                                                    ]
                                                },
                                                {"nodeType": "Identifier", "name": "remain"},
                                                {
                                                    "nodeType": "FunctionCall",
                                                    "expression": {
                                                        "nodeType": "MemberAccess",
                                                        "memberName": "lock",
                                                        "expression": {"nodeType": "Identifier", "name": "LockPoolLib"}
                                                    },
                                                    "arguments": [
                                                        {"nodeType": "Identifier", "name": "_lockPool"},
                                                        {"nodeType": "Identifier", "name": "crossChainTxId"},
                                                        {"nodeType": "Identifier", "name": "amountToLock"},
                                                        {"nodeType": "Identifier", "name": "timeoutBlocks"}
                                                    ]
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        }
    })
}
