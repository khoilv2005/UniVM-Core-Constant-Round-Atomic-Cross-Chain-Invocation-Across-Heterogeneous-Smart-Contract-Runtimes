pub mod cfg;
pub mod external;
pub mod hash;
pub mod signature;
pub mod storage;

use serde::{Deserialize, Serialize};

pub use cfg::{BasicBlock, BinOp, BlockId, ControlFlowGraph, ExtCallId, Literal, Op, SlotId, Terminator, VarId};
pub use external::{ExternalCall, ExternalTarget};
pub use hash::{canonical_ir, normalized_ir, semantic_hash, semantic_hash_hex};
pub use signature::{Effect, FnSignature, Mutability};
pub use storage::{IRType, NativeEncoding, StorageLayout, StorageSlot};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IR {
    pub meta: ContractMeta,
    pub storage: StorageLayout,
    pub signatures: Vec<FnSignature>,
    pub cfg: ControlFlowGraph,
    pub externals: Vec<ExternalCall>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractMeta {
    pub name: String,
    pub version: String,
    pub source_vm: SourceVm,
    pub source_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceVm {
    Evm { solc_version: String },
    Wasm { ink_version: String },
    Fabric { go_version: String },
    Any,
}

