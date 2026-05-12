use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct StorageLayout {
    pub slots: Vec<StorageSlot>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct StorageSlot {
    pub id: String,
    pub ty: IRType,
    pub native_offset: u64,
    pub native_encoding: NativeEncoding,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum NativeEncoding {
    EvmSlot { keccak_base: u16 },
    WasmMap { hash: String },
    FabricKey { pattern: String },
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum IRType {
    U256,
    U128,
    U64,
    U32,
    Bool,
    Address,
    Bytes,
    String,
    Map { key: Box<IRType>, val: Box<IRType> },
    Tuple(Vec<IRType>),
}

