use ubtl_ir::{BasicBlock, ControlFlowGraph, Terminator};

pub fn placeholder_cfg(block_count: usize) -> ControlFlowGraph {
    let blocks = (0..block_count)
        .map(|id| BasicBlock {
            id: id as u32,
            preds: Vec::new(),
            ops: Vec::new(),
            term: Terminator::Return(Vec::new()),
        })
        .collect();

    ControlFlowGraph { blocks }
}
