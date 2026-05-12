mod ast;
mod selectors;
mod storage_layout;
mod yul_ssa;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::Value;
use tiny_keccak::{Hasher, Keccak};
use ubtl_ir::{ContractMeta, IR, SourceVm};

pub use selectors::selector4;

pub fn translate(path: &Path, contract_name: Option<&str>) -> Result<IR, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    translate_bytes(&bytes, contract_name)
}

pub fn translate_bytes(input: &[u8], contract_name: Option<&str>) -> Result<IR, String> {
    let value: Value = serde_json::from_slice(input).map_err(|err| err.to_string())?;
    translate_value(&value, Some(input), contract_name)
}

pub fn translate_value(
    value: &Value,
    raw_bytes: Option<&[u8]>,
    contract_name: Option<&str>,
) -> Result<IR, String> {
    let bundle = ast::load_bundle(value)?;
    let index = ast::build_index(&bundle);
    let (target, artifact) = ast::resolve_contract(&bundle, &index, contract_name)?;
    let inheritance_chain = ast::inheritance_chain(&target, &index)?;
    let inheritance_nodes = inheritance_chain
        .iter()
        .map(|contract| &contract.node)
        .collect::<Vec<_>>();

    let storage = storage_layout::parse_storage_layout_or_fallback(
        &artifact,
        &inheritance_nodes,
        &index.structs,
    )?;
    let state_slots = storage
        .slots
        .iter()
        .map(|slot| slot.id.clone())
        .collect::<BTreeSet<_>>();
    let (signatures, externals) = ast::build_signatures_and_externals(
        &artifact,
        &inheritance_chain,
        &state_slots,
        &index.structs,
    )?;
    let cfg = yul_ssa::placeholder_cfg(signatures.len());

    Ok(IR {
        meta: ContractMeta {
            name: target.name,
            version: bundle.solc_version.clone(),
            source_vm: SourceVm::Evm {
                solc_version: bundle.solc_version,
            },
            source_hash: source_hash(raw_bytes),
        },
        storage,
        signatures,
        cfg,
        externals,
    })
}

fn source_hash(raw_bytes: Option<&[u8]>) -> [u8; 32] {
    let Some(bytes) = raw_bytes else {
        return [0u8; 32];
    };

    let mut output = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(bytes);
    hasher.finalize(&mut output);
    output
}
