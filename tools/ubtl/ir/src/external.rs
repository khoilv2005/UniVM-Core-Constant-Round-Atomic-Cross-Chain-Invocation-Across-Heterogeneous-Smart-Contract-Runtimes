use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalCall {
    pub id: String,
    pub target: ExternalTarget,
    pub selector4: [u8; 4],
    pub argtypes: Vec<crate::storage::IRType>,
    pub ret: Vec<crate::storage::IRType>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ExternalTarget {
    NativeBuiltin(String),
    OtherContract { iface_hash: [u8; 32] },
}

