use crate::cfg::BlockId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FnSignature {
    pub name: String,
    pub selector4: [u8; 4],
    pub inputs: Vec<crate::storage::IRType>,
    pub outputs: Vec<crate::storage::IRType>,
    pub mutability: Mutability,
    pub effects: Vec<Effect>,
    pub entry_block: BlockId,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Mutability {
    View,
    Pure,
    NonPayable,
    Payable,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Effect {
    Read { slot: String },
    Write { slot: String },
    Call { external_id: String },
}

