use serde::{Deserialize, Serialize};

pub type BlockId = u32;
pub type VarId = String;
pub type SlotId = String;
pub type ExtCallId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlFlowGraph {
    pub blocks: Vec<BasicBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasicBlock {
    pub id: BlockId,
    pub preds: Vec<BlockId>,
    pub ops: Vec<Op>,
    pub term: Terminator,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Literal {
    U256(String),
    U128(u128),
    U64(u64),
    U32(u32),
    Bool(bool),
    Address(String),
    Bytes(Vec<u8>),
    String(String),
    Tuple(Vec<Literal>),
    Unit,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    Const {
        dest: VarId,
        value: Literal,
    },
    Load {
        dest: VarId,
        slot: SlotId,
    },
    Store {
        slot: SlotId,
        value: VarId,
    },
    Bin {
        dest: VarId,
        op: BinOp,
        lhs: VarId,
        rhs: VarId,
    },
    Call {
        external_id: ExtCallId,
        args: Vec<VarId>,
        dests: Vec<VarId>,
    },
    Require {
        cond: VarId,
        reason: Option<String>,
    },
    EmitEvent {
        name: String,
        args: Vec<VarId>,
    },
    Assign {
        dest: VarId,
        src: VarId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Terminator {
    Jump(BlockId),
    Branch {
        cond: VarId,
        then_blk: BlockId,
        else_blk: BlockId,
    },
    Return(Vec<VarId>),
    Revert(Option<String>),
}

impl Terminator {
    pub fn successors(&self) -> Vec<BlockId> {
        match self {
            Self::Jump(target) => vec![*target],
            Self::Branch {
                then_blk,
                else_blk,
                ..
            } => vec![*then_blk, *else_blk],
            Self::Return(_) | Self::Revert(_) => Vec::new(),
        }
    }
}

