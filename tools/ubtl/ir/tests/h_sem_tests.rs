use ubtl_ir::{
    semantic_hash, BasicBlock, BinOp, ContractMeta, ControlFlowGraph, Effect, ExternalCall,
    ExternalTarget, FnSignature, IR, IRType, Literal, Mutability, NativeEncoding, Op, SourceVm,
    StorageLayout, StorageSlot, Terminator,
};

fn sample_ir() -> IR {
    IR {
        meta: ContractMeta {
            name: "TrainBooking".into(),
            version: "1.0.0".into(),
            source_vm: SourceVm::Evm {
                solc_version: "0.8.28".into(),
            },
            source_hash: [7u8; 32],
        },
        storage: StorageLayout {
            slots: vec![
                StorageSlot {
                    id: "remain".into(),
                    ty: IRType::U64,
                    native_offset: 1,
                    native_encoding: NativeEncoding::EvmSlot { keccak_base: 256 },
                },
                StorageSlot {
                    id: "accounts[user]".into(),
                    ty: IRType::U256,
                    native_offset: 5,
                    native_encoding: NativeEncoding::EvmSlot { keccak_base: 256 },
                },
            ],
        },
        signatures: vec![FnSignature {
            name: "book_local".into(),
            selector4: [0x12, 0x34, 0x56, 0x78],
            inputs: vec![IRType::Address, IRType::U64],
            outputs: vec![IRType::U256],
            mutability: Mutability::NonPayable,
            effects: vec![
                Effect::Write {
                    slot: "accounts[user]".into(),
                },
                Effect::Read {
                    slot: "remain".into(),
                },
                Effect::Call {
                    external_id: "pricing".into(),
                },
            ],
            entry_block: 42,
        }],
        cfg: ControlFlowGraph {
            blocks: vec![
                BasicBlock {
                    id: 42,
                    preds: vec![],
                    ops: vec![
                        Op::Load {
                            dest: "tmpRemain".into(),
                            slot: "remain".into(),
                        },
                        Op::Const {
                            dest: "one".into(),
                            value: Literal::U64(1),
                        },
                        Op::Bin {
                            dest: "nextRemain".into(),
                            op: BinOp::Sub,
                            lhs: "tmpRemain".into(),
                            rhs: "one".into(),
                        },
                    ],
                    term: Terminator::Jump(99),
                },
                BasicBlock {
                    id: 99,
                    preds: vec![42],
                    ops: vec![
                        Op::Call {
                            external_id: "pricing".into(),
                            args: vec!["one".into()],
                            dests: vec!["cost".into()],
                        },
                        Op::Store {
                            slot: "accounts[user]".into(),
                            value: "cost".into(),
                        },
                    ],
                    term: Terminator::Return(vec!["cost".into()]),
                },
            ],
        },
        externals: vec![ExternalCall {
            id: "pricing".into(),
            target: ExternalTarget::NativeBuiltin("pricing".into()),
            selector4: [0xaa, 0xbb, 0xcc, 0xdd],
            argtypes: vec![IRType::U64],
            ret: vec![IRType::U256],
        }],
    }
}

fn cross_block_dataflow_ir(entry: u32, exit: u32) -> IR {
    IR {
        meta: ContractMeta {
            name: "CrossBlock".into(),
            version: "1.0.0".into(),
            source_vm: SourceVm::Evm {
                solc_version: "0.8.28".into(),
            },
            source_hash: [3u8; 32],
        },
        storage: StorageLayout {
            slots: vec![StorageSlot {
                id: "slot".into(),
                ty: IRType::U64,
                native_offset: 0,
                native_encoding: NativeEncoding::EvmSlot { keccak_base: 256 },
            }],
        },
        signatures: vec![FnSignature {
            name: "run".into(),
            selector4: [1, 2, 3, 4],
            inputs: vec![],
            outputs: vec![IRType::U64],
            mutability: Mutability::NonPayable,
            effects: vec![
                Effect::Write { slot: "slot".into() },
                Effect::Read { slot: "slot".into() },
            ],
            entry_block: entry,
        }],
        cfg: ControlFlowGraph {
            blocks: vec![
                BasicBlock {
                    id: entry,
                    preds: vec![],
                    ops: vec![Op::Const {
                        dest: "x".into(),
                        value: Literal::U64(1),
                    }],
                    term: Terminator::Jump(exit),
                },
                BasicBlock {
                    id: exit,
                    preds: vec![entry],
                    ops: vec![
                        Op::Store {
                            slot: "slot".into(),
                            value: "x".into(),
                        },
                        Op::Load {
                            dest: "out".into(),
                            slot: "slot".into(),
                        },
                    ],
                    term: Terminator::Return(vec!["out".into()]),
                },
            ],
        },
        externals: vec![],
    }
}

fn op_swap_ir(first_use_a: bool) -> IR {
    let store_ops = if first_use_a {
        vec![
            Op::Store {
                slot: "slot".into(),
                value: "a".into(),
            },
            Op::Store {
                slot: "slot".into(),
                value: "b".into(),
            },
        ]
    } else {
        vec![
            Op::Store {
                slot: "slot".into(),
                value: "b".into(),
            },
            Op::Store {
                slot: "slot".into(),
                value: "a".into(),
            },
        ]
    };

    let mut ops = vec![
        Op::Const {
            dest: "a".into(),
            value: Literal::U64(1),
        },
        Op::Const {
            dest: "b".into(),
            value: Literal::U64(2),
        },
    ];
    ops.extend(store_ops);
    ops.push(Op::Load {
        dest: "out".into(),
        slot: "slot".into(),
    });

    IR {
        meta: ContractMeta {
            name: "OpSwap".into(),
            version: "1.0.0".into(),
            source_vm: SourceVm::Evm {
                solc_version: "0.8.28".into(),
            },
            source_hash: [4u8; 32],
        },
        storage: StorageLayout {
            slots: vec![StorageSlot {
                id: "slot".into(),
                ty: IRType::U64,
                native_offset: 0,
                native_encoding: NativeEncoding::EvmSlot { keccak_base: 256 },
            }],
        },
        signatures: vec![FnSignature {
            name: "run".into(),
            selector4: [9, 9, 9, 9],
            inputs: vec![],
            outputs: vec![IRType::U64],
            mutability: Mutability::NonPayable,
            effects: vec![Effect::Write { slot: "slot".into() }],
            entry_block: 0,
        }],
        cfg: ControlFlowGraph {
            blocks: vec![BasicBlock {
                id: 0,
                preds: vec![],
                ops,
                term: Terminator::Return(vec!["out".into()]),
            }],
        },
        externals: vec![],
    }
}

#[test]
fn semantic_hash_ignores_source_specific_metadata() {
    let evm = sample_ir();
    let mut wasm = sample_ir();
    wasm.meta.name = "train_booking".into();
    wasm.meta.version = "ink-5".into();
    wasm.meta.source_vm = SourceVm::Wasm {
        ink_version: "5.1.1".into(),
    };
    wasm.meta.source_hash = [9u8; 32];
    wasm.storage.slots[0].native_offset = 999;
    wasm.storage.slots[0].native_encoding = NativeEncoding::WasmMap {
        hash: "Blake2b_128".into(),
    };

    assert_eq!(semantic_hash(&evm), semantic_hash(&wasm));
}

#[test]
fn semantic_hash_ignores_order_block_ids_and_var_names() {
    let original = sample_ir();
    let mut shuffled = sample_ir();

    shuffled.storage.slots.swap(0, 1);
    shuffled.signatures[0].effects.swap(0, 2);
    shuffled.externals[0].id = "external_17".into();
    shuffled.signatures[0].effects[0] = Effect::Call {
        external_id: "external_17".into(),
    };
    shuffled.signatures[0].entry_block = 7;
    shuffled.cfg.blocks = vec![
        BasicBlock {
            id: 8,
            preds: vec![7],
            ops: vec![
                Op::Call {
                    external_id: "external_17".into(),
                    args: vec!["c1".into()],
                    dests: vec!["ret0".into()],
                },
                Op::Store {
                    slot: "accounts[user]".into(),
                    value: "ret0".into(),
                },
            ],
            term: Terminator::Return(vec!["ret0".into()]),
        },
        BasicBlock {
            id: 7,
            preds: vec![],
            ops: vec![
                Op::Load {
                    dest: "r0".into(),
                    slot: "remain".into(),
                },
                Op::Const {
                    dest: "c1".into(),
                    value: Literal::U64(1),
                },
                Op::Bin {
                    dest: "r1".into(),
                    op: BinOp::Sub,
                    lhs: "r0".into(),
                    rhs: "c1".into(),
                },
            ],
            term: Terminator::Jump(8),
        },
    ];

    assert_eq!(semantic_hash(&original), semantic_hash(&shuffled));
}

#[test]
fn semantic_hash_changes_when_semantics_change() {
    let baseline = sample_ir();
    let mut changed = sample_ir();
    changed.cfg.blocks[1].term = Terminator::Return(vec!["one".into()]);

    assert_ne!(semantic_hash(&baseline), semantic_hash(&changed));
}

#[test]
fn semantic_hash_handles_cross_block_dataflow() {
    let original = cross_block_dataflow_ir(10, 20);
    let reordered = cross_block_dataflow_ir(99, 100);

    assert_eq!(semantic_hash(&original), semantic_hash(&reordered));
}

#[test]
fn semantic_hash_changes_when_op_order_swapped_within_block() {
    let original = op_swap_ir(true);
    let swapped = op_swap_ir(false);

    assert_ne!(semantic_hash(&original), semantic_hash(&swapped));
}

#[test]
fn semantic_hash_changes_when_external_target_changes() {
    let original = sample_ir();
    let mut changed = sample_ir();
    changed.externals[0].target = ExternalTarget::OtherContract {
        iface_hash: [1u8; 32],
    };

    assert_ne!(semantic_hash(&original), semantic_hash(&changed));
}

#[test]
fn semantic_hash_unchanged_under_dead_block_reorder() {
    let mut original = sample_ir();
    original.cfg.blocks.push(BasicBlock {
        id: 777,
        preds: vec![],
        ops: vec![Op::Const {
            dest: "dead".into(),
            value: Literal::U64(99),
        }],
        term: Terminator::Return(vec!["dead".into()]),
    });

    let mut reordered = sample_ir();
    reordered.cfg.blocks = vec![
        BasicBlock {
            id: 777,
            preds: vec![],
            ops: vec![Op::Const {
                dest: "unused".into(),
                value: Literal::U64(42),
            }],
            term: Terminator::Return(vec!["unused".into()]),
        },
        reordered.cfg.blocks[0].clone(),
        reordered.cfg.blocks[1].clone(),
    ];

    assert_eq!(semantic_hash(&original), semantic_hash(&reordered));
}
