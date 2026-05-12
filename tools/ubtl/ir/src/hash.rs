use crate::cfg::{BasicBlock, BlockId, ControlFlowGraph, Op, Terminator, VarId};
use crate::external::{ExternalCall, ExternalTarget};
use crate::signature::{Effect, FnSignature};
use crate::{ContractMeta, IR, SourceVm, StorageSlot};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use tiny_keccak::{Hasher, Keccak};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CanonicalIR {
    storage: Vec<CanonicalStorageSlot>,
    signatures: Vec<CanonicalFnSignature>,
    cfg: CanonicalControlFlowGraph,
    externals: Vec<CanonicalExternalCall>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct CanonicalStorageSlot {
    id: String,
    ty: crate::storage::IRType,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CanonicalFnSignature {
    selector4: [u8; 4],
    inputs: Vec<crate::storage::IRType>,
    outputs: Vec<crate::storage::IRType>,
    mutability: crate::signature::Mutability,
    effects: Vec<CanonicalEffect>,
    entry_block: BlockId,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
enum CanonicalEffect {
    Read { slot: String },
    Write { slot: String },
    Call { external_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CanonicalControlFlowGraph {
    blocks: Vec<CanonicalBasicBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CanonicalBasicBlock {
    id: BlockId,
    preds: Vec<BlockId>,
    ops: Vec<CanonicalOp>,
    term: CanonicalTerminator,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
enum CanonicalOp {
    Const { dest: String, value: crate::cfg::Literal },
    Load { dest: String, slot: String },
    Store { slot: String, value: String },
    Bin {
        dest: String,
        op: crate::cfg::BinOp,
        lhs: String,
        rhs: String,
    },
    Call {
        external_id: String,
        args: Vec<String>,
        dests: Vec<String>,
    },
    Require {
        cond: String,
        reason: Option<String>,
    },
    EmitEvent {
        name: String,
        args: Vec<String>,
    },
    Assign {
        dest: String,
        src: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
enum CanonicalTerminator {
    Jump(BlockId),
    Branch {
        cond: String,
        then_blk: BlockId,
        else_blk: BlockId,
    },
    Return(Vec<String>),
    Revert(Option<String>),
}

pub fn normalized_ir(ir: &IR) -> IR {
    let mut out = ir.clone();
    out.meta = ContractMeta {
        name: out.meta.name.trim().to_string(),
        version: String::new(),
        source_vm: SourceVm::Any,
        source_hash: [0; 32],
    };
    out.storage.slots.sort_by(|lhs, rhs| lhs.id.cmp(&rhs.id));
    out.signatures.sort_by(|lhs, rhs| lhs.selector4.cmp(&rhs.selector4));
    out
}

pub fn canonical_ir(ir: &IR) -> Vec<u8> {
    let normalized = normalized_ir(ir);
    let external_map = canonical_external_map(&normalized.externals);
    let block_map = canonical_block_map(&normalized.cfg, &normalized.signatures);
    let renamer = canonical_var_renamer(&normalized.cfg, &normalized.signatures, &block_map);
    let blocks = canonical_blocks(&normalized.cfg, &block_map, &external_map, &renamer);
    let signatures = canonical_signatures(&normalized.signatures, &block_map, &external_map);
    let externals = canonical_externals(&normalized.externals, &external_map);
    let storage = canonical_storage(&normalized.storage.slots);

    let payload = CanonicalIR {
        storage,
        signatures,
        cfg: CanonicalControlFlowGraph { blocks },
        externals,
    };

    let mut out = Vec::new();
    ciborium::into_writer(&payload, &mut out).expect("canonical CBOR encoding must succeed");
    out
}

pub fn semantic_hash(ir: &IR) -> [u8; 32] {
    let canonical = canonical_ir(ir);
    let mut hasher = Keccak::v256();
    hasher.update(&canonical);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

pub fn semantic_hash_hex(ir: &IR) -> String {
    let hash = semantic_hash(ir);
    let mut out = String::from("0x");
    for byte in hash {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn canonical_storage(slots: &[StorageSlot]) -> Vec<CanonicalStorageSlot> {
    let mut out: Vec<_> = slots
        .iter()
        .map(|slot| CanonicalStorageSlot {
            id: slot.id.clone(),
            ty: slot.ty.clone(),
        })
        .collect();
    out.sort();
    out
}

fn canonical_external_map(externals: &[ExternalCall]) -> BTreeMap<String, String> {
    let mut indexed: Vec<_> = externals.iter().collect();
    indexed.sort_by(|lhs, rhs| {
        lhs.selector4
            .cmp(&rhs.selector4)
            .then_with(|| lhs.target.cmp(&rhs.target))
    });

    indexed
        .into_iter()
        .enumerate()
        .map(|(idx, external)| (external.id.clone(), format!("e{idx}")))
        .collect()
}

fn canonical_externals(
    externals: &[ExternalCall],
    external_map: &BTreeMap<String, String>,
) -> Vec<CanonicalExternalCall> {
    let mut indexed: Vec<_> = externals.iter().collect();
    indexed.sort_by(|lhs, rhs| {
        lhs.selector4
            .cmp(&rhs.selector4)
            .then_with(|| lhs.target.cmp(&rhs.target))
    });

    indexed
        .into_iter()
        .map(|external| CanonicalExternalCall {
            id: external_map
                .get(&external.id)
                .cloned()
                .expect("external id must exist in canonical map"),
            target: external.target.clone(),
            selector4: external.selector4,
            argtypes: external.argtypes.clone(),
            ret: external.ret.clone(),
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct CanonicalExternalCall {
    id: String,
    target: ExternalTarget,
    selector4: [u8; 4],
    argtypes: Vec<crate::storage::IRType>,
    ret: Vec<crate::storage::IRType>,
}

fn canonical_block_map(cfg: &ControlFlowGraph, signatures: &[FnSignature]) -> BTreeMap<BlockId, BlockId> {
    let block_by_id: BTreeMap<_, _> = cfg.blocks.iter().map(|block| (block.id, block)).collect();
    let mut visited = BTreeSet::new();
    let mut post_order = Vec::new();

    let mut seen_entries = BTreeSet::new();
    for entry in signatures.iter().map(|sig| sig.entry_block) {
        if !block_by_id.contains_key(&entry) || !seen_entries.insert(entry) {
            continue;
        }
        dfs_post_order(entry, &block_by_id, &mut visited, &mut post_order);
    }

    post_order
        .into_iter()
        .enumerate()
        .map(|(new_id, old_id)| (old_id, new_id as BlockId))
        .collect()
}

fn dfs_post_order(
    start: BlockId,
    block_by_id: &BTreeMap<BlockId, &BasicBlock>,
    visited: &mut BTreeSet<BlockId>,
    post_order: &mut Vec<BlockId>,
) {
    if !visited.insert(start) {
        return;
    }
    if let Some(block) = block_by_id.get(&start) {
        for succ in block.term.successors() {
            dfs_post_order(succ, block_by_id, visited, post_order);
        }
    }
    post_order.push(start);
}

fn canonical_var_renamer(
    cfg: &ControlFlowGraph,
    signatures: &[FnSignature],
    block_map: &BTreeMap<BlockId, BlockId>,
) -> VarRenamer {
    let block_by_id: BTreeMap<_, _> = cfg.blocks.iter().map(|block| (block.id, block)).collect();
    let mut visited = BTreeSet::new();
    let mut order = Vec::new();
    let mut seen_entries = BTreeSet::new();

    for entry in signatures.iter().map(|sig| sig.entry_block) {
        if !block_map.contains_key(&entry) || !seen_entries.insert(entry) {
            continue;
        }
        dfs_pre_order(entry, &block_by_id, &mut visited, &mut order);
    }

    let mut builder = VarRenamerBuilder::default();
    for block_id in order {
        if let Some(block) = block_by_id.get(&block_id) {
            for op in &block.ops {
                collect_op_vars(op, &mut builder);
            }
            collect_terminator_vars(&block.term, &mut builder);
        }
    }

    builder.finish()
}

fn dfs_pre_order(
    start: BlockId,
    block_by_id: &BTreeMap<BlockId, &BasicBlock>,
    visited: &mut BTreeSet<BlockId>,
    order: &mut Vec<BlockId>,
) {
    if !visited.insert(start) {
        return;
    }
    order.push(start);
    if let Some(block) = block_by_id.get(&start) {
        for succ in block.term.successors() {
            dfs_pre_order(succ, block_by_id, visited, order);
        }
    }
}

fn collect_op_vars(op: &Op, builder: &mut VarRenamerBuilder) {
    match op {
        Op::Const { dest, .. } | Op::Load { dest, .. } => {
            builder.touch(dest);
        }
        Op::Store { value, .. } => {
            builder.touch(value);
        }
        Op::Bin { dest, lhs, rhs, .. } => {
            builder.touch(lhs);
            builder.touch(rhs);
            builder.touch(dest);
        }
        Op::Call { args, dests, .. } => {
            for arg in args {
                builder.touch(arg);
            }
            for dest in dests {
                builder.touch(dest);
            }
        }
        Op::Require { cond, .. } => {
            builder.touch(cond);
        }
        Op::EmitEvent { args, .. } => {
            for arg in args {
                builder.touch(arg);
            }
        }
        Op::Assign { dest, src } => {
            builder.touch(src);
            builder.touch(dest);
        }
    }
}

fn collect_terminator_vars(term: &Terminator, builder: &mut VarRenamerBuilder) {
    match term {
        Terminator::Jump(_) | Terminator::Revert(_) => {}
        Terminator::Branch { cond, .. } => builder.touch(cond),
        Terminator::Return(vars) => {
            for var in vars {
                builder.touch(var);
            }
        }
    }
}

fn canonical_blocks(
    cfg: &ControlFlowGraph,
    block_map: &BTreeMap<BlockId, BlockId>,
    external_map: &BTreeMap<String, String>,
    renamer: &VarRenamer,
) -> Vec<CanonicalBasicBlock> {
    let mut preds_map: BTreeMap<BlockId, Vec<BlockId>> =
        block_map.values().copied().map(|id| (id, Vec::new())).collect();

    for block in &cfg.blocks {
        let Some(&src) = block_map.get(&block.id) else {
            continue;
        };
        for succ in block.term.successors() {
            let Some(&dst) = block_map.get(&succ) else {
                continue;
            };
            preds_map.entry(dst).or_default().push(src);
        }
    }

    let block_by_new_id: BTreeMap<_, _> = cfg
        .blocks
        .iter()
        .filter(|block| block_map.contains_key(&block.id))
        .map(|block| (block_map[&block.id], block))
        .collect();

    let mut new_ids: Vec<_> = block_by_new_id.keys().copied().collect();
    new_ids.sort_unstable();

    new_ids
        .into_iter()
        .map(|new_id| {
            let block = block_by_new_id[&new_id];
            let mut preds = preds_map.remove(&new_id).unwrap_or_default();
            preds.sort_unstable();
            preds.dedup();

            CanonicalBasicBlock {
                id: new_id,
                preds,
                ops: block
                    .ops
                    .iter()
                    .map(|op| canonical_op(op, renamer, external_map))
                    .collect(),
                term: canonical_terminator(&block.term, renamer, block_map),
            }
        })
        .collect()
}

fn canonical_signatures(
    signatures: &[FnSignature],
    block_map: &BTreeMap<BlockId, BlockId>,
    external_map: &BTreeMap<String, String>,
) -> Vec<CanonicalFnSignature> {
    let mut out: Vec<_> = signatures
        .iter()
        .map(|sig| CanonicalFnSignature {
            selector4: sig.selector4,
            inputs: sig.inputs.clone(),
            outputs: sig.outputs.clone(),
            mutability: sig.mutability.clone(),
            effects: canonical_effects(&sig.effects, external_map),
            entry_block: *block_map
                .get(&sig.entry_block)
                .expect("signature entry block must exist in canonical block map"),
        })
        .collect();
    out.sort_by(|lhs, rhs| lhs.selector4.cmp(&rhs.selector4));
    out
}

fn canonical_effects(
    effects: &[Effect],
    external_map: &BTreeMap<String, String>,
) -> Vec<CanonicalEffect> {
    let mut out: Vec<_> = effects
        .iter()
        .map(|effect| match effect {
            Effect::Read { slot } => CanonicalEffect::Read { slot: slot.clone() },
            Effect::Write { slot } => CanonicalEffect::Write { slot: slot.clone() },
            Effect::Call { external_id } => CanonicalEffect::Call {
                external_id: external_map
                    .get(external_id)
                    .cloned()
                    .unwrap_or_else(|| external_id.clone()),
            },
        })
        .collect();
    out.sort();
    out
}

fn canonical_op(
    op: &Op,
    renamer: &VarRenamer,
    external_map: &BTreeMap<String, String>,
) -> CanonicalOp {
    match op {
        Op::Const { dest, value } => CanonicalOp::Const {
            dest: renamer.assign(dest),
            value: value.clone(),
        },
        Op::Load { dest, slot } => CanonicalOp::Load {
            dest: renamer.assign(dest),
            slot: slot.clone(),
        },
        Op::Store { slot, value } => CanonicalOp::Store {
            slot: slot.clone(),
            value: renamer.use_var(value),
        },
        Op::Bin { dest, op, lhs, rhs } => {
            let lhs = renamer.use_var(lhs);
            let rhs = renamer.use_var(rhs);
            CanonicalOp::Bin {
                dest: renamer.assign(dest),
                op: op.clone(),
                lhs,
                rhs,
            }
        }
        Op::Call {
            external_id,
            args,
            dests,
        } => CanonicalOp::Call {
            external_id: external_map
                .get(external_id)
                .cloned()
                .unwrap_or_else(|| external_id.clone()),
            args: args.iter().map(|arg| renamer.use_var(arg)).collect(),
            dests: dests.iter().map(|dest| renamer.assign(dest)).collect(),
        },
        Op::Require { cond, reason } => CanonicalOp::Require {
            cond: renamer.use_var(cond),
            reason: reason.clone(),
        },
        Op::EmitEvent { name, args } => CanonicalOp::EmitEvent {
            name: canonical_event_name(name),
            args: args.iter().map(|arg| renamer.use_var(arg)).collect(),
        },
        Op::Assign { dest, src } => {
            let src = renamer.use_var(src);
            CanonicalOp::Assign {
                dest: renamer.assign(dest),
                src,
            }
        }
    }
}

fn canonical_terminator(
    term: &Terminator,
    renamer: &VarRenamer,
    block_map: &BTreeMap<BlockId, BlockId>,
) -> CanonicalTerminator {
    match term {
        Terminator::Jump(target) => CanonicalTerminator::Jump(block_map[target]),
        Terminator::Branch {
            cond,
            then_blk,
            else_blk,
        } => CanonicalTerminator::Branch {
            cond: renamer.use_var(cond),
            then_blk: block_map[then_blk],
            else_blk: block_map[else_blk],
        },
        Terminator::Return(vars) => {
            CanonicalTerminator::Return(vars.iter().map(|var| renamer.use_var(var)).collect())
        }
        Terminator::Revert(reason) => CanonicalTerminator::Revert(reason.clone()),
    }
}

fn canonical_event_name(name: &str) -> String {
    let normalized: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    if normalized.is_empty() {
        "event".to_string()
    } else {
        normalized
    }
}

#[derive(Default)]
struct VarRenamerBuilder {
    ids: BTreeMap<VarId, String>,
    next: usize,
}

impl VarRenamerBuilder {
    fn touch(&mut self, original: &str) {
        if self.ids.contains_key(original) {
            return;
        }
        let renamed = format!("v{}", self.next);
        self.next += 1;
        self.ids.insert(original.to_string(), renamed);
    }

    fn finish(self) -> VarRenamer {
        VarRenamer { ids: self.ids }
    }
}

struct VarRenamer {
    ids: BTreeMap<VarId, String>,
}

impl VarRenamer {
    fn assign(&self, original: &str) -> String {
        self.ids
            .get(original)
            .cloned()
            .expect("assigned variable must have a canonical id")
    }

    fn use_var(&self, original: &str) -> String {
        self.ids
            .get(original)
            .cloned()
            .expect("used variable must have a canonical id")
    }
}
