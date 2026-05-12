mod metadata;
mod selectors;
mod wasm_cfg;

use std::fs;
use std::path::Path;

use serde_json::Value;
use tiny_keccak::{Hasher, Keccak};
use ubtl_ir::{ContractMeta, IR, SourceVm};

pub use selectors::canonical_selector4 as selector4;

pub fn translate(path: &Path) -> Result<IR, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    translate_bytes(&bytes)
}

pub fn translate_bytes(input: &[u8]) -> Result<IR, String> {
    let value: Value = serde_json::from_slice(input).map_err(|err| err.to_string())?;
    translate_value(&value, Some(input))
}

pub fn translate_value(value: &Value, raw_bytes: Option<&[u8]>) -> Result<IR, String> {
    let bundle = metadata::load_bundle(value)?;
    metadata::reject_unsupported_constructs(&bundle.metadata)?;
    let storage = metadata::extract_storage(&bundle.metadata)?;
    let signatures = metadata::extract_signatures(&bundle.metadata, &storage)?;
    let cfg = wasm_cfg::placeholder_cfg(signatures.len());

    Ok(IR {
        meta: ContractMeta {
            name: bundle.contract_name,
            version: bundle.ink_version.clone(),
            source_vm: SourceVm::Wasm {
                ink_version: bundle.ink_version,
            },
            source_hash: source_hash(raw_bytes),
        },
        storage,
        signatures,
        cfg,
        externals: Vec::new(),
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
