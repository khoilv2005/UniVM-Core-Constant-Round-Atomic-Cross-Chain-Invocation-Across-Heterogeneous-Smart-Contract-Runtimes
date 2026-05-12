use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use ubtl_ir::{IRType, NativeEncoding, StorageLayout, StorageSlot};

pub type StructMap = BTreeMap<String, Vec<(String, String)>>;

pub fn parse_storage_layout_or_fallback(
    artifact: &Value,
    inheritance_chain: &[&Value],
    structs: &StructMap,
) -> Result<StorageLayout, String> {
    match artifact.get("storageLayout") {
        Some(layout) if layout.is_object() => parse_storage_layout(layout, structs),
        _ => fallback_storage_layout(inheritance_chain, structs),
    }
}

pub fn normalize_type_string(raw: &str) -> String {
    let mut normalized = raw.trim().to_string();
    for suffix in [
        " storage ref",
        " storage pointer",
        " storage_ptr",
        " memory ptr",
        " memory",
        " calldata",
        " storage",
    ] {
        normalized = normalized.replace(suffix, "");
    }

    while normalized.contains("  ") {
        normalized = normalized.replace("  ", " ");
    }

    normalized.trim().to_string()
}

pub fn parse_type_string(raw: &str, structs: &StructMap) -> IRType {
    let normalized = normalize_type_string(raw);

    if let Some(inner) = normalized
        .strip_prefix("mapping(")
        .and_then(|value| value.strip_suffix(')'))
    {
        if let Some((key, value)) = split_top_level_once(inner, "=>") {
            return IRType::Map {
                key: Box::new(parse_type_string(key.trim(), structs)),
                val: Box::new(parse_type_string(value.trim(), structs)),
            };
        }
    }

    if let Some(inner) = normalized
        .strip_prefix("tuple(")
        .and_then(|value| value.strip_suffix(')'))
    {
        let members = split_top_level_csv(inner)
            .into_iter()
            .filter(|item| !item.trim().is_empty())
            .map(|item| parse_type_string(item.trim(), structs))
            .collect();
        return IRType::Tuple(members);
    }

    if let Some(struct_name) = normalized.strip_prefix("struct ") {
        if let Some(fields) = structs
            .get(struct_name)
            .or_else(|| structs.get(struct_name.rsplit('.').next().unwrap_or(struct_name)))
        {
            return IRType::Tuple(
                fields
                    .iter()
                    .map(|(_, ty)| parse_type_string(ty, structs))
                    .collect(),
            );
        }
        return IRType::Bytes;
    }

    match normalized.as_str() {
        "uint256" | "uint" => IRType::U256,
        "uint128" => IRType::U128,
        "uint64" => IRType::U64,
        "uint32" => IRType::U32,
        "bool" => IRType::Bool,
        "address" | "address payable" => IRType::Address,
        "string" => IRType::String,
        "bytes" => IRType::Bytes,
        other if other.starts_with("bytes") => IRType::Bytes,
        other if other.starts_with("contract ") => IRType::Address,
        _ => IRType::Bytes,
    }
}

fn parse_storage_layout(layout: &Value, structs: &StructMap) -> Result<StorageLayout, String> {
    let types = layout
        .get("types")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut slots = Vec::new();
    for entry in layout
        .get("storage")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = required_str(&entry, "label")?.to_string();
        let native_offset = parse_u64(required_str(&entry, "slot")?)?;
        let type_id = required_str(&entry, "type")?;

        let ty = match types.get(type_id) {
            Some(type_entry) => ir_type_from_layout_type(type_id, type_entry, &types, structs)?,
            None => parse_type_string(type_id, structs),
        };

        let native_encoding = if type_id.contains("mapping") {
            NativeEncoding::EvmSlot { keccak_base: 1 }
        } else {
            NativeEncoding::EvmSlot { keccak_base: 0 }
        };

        slots.push(StorageSlot {
            id,
            ty,
            native_offset,
            native_encoding,
        });
    }

    Ok(StorageLayout { slots })
}

fn ir_type_from_layout_type(
    type_id: &str,
    type_entry: &Value,
    types: &Map<String, Value>,
    structs: &StructMap,
) -> Result<IRType, String> {
    let label = type_entry
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(type_id);

    if type_entry
        .get("encoding")
        .and_then(Value::as_str)
        .is_some_and(|encoding| encoding == "mapping")
    {
        let key = required_str(type_entry, "key")?;
        let value = required_str(type_entry, "value")?;
        let key_ty = match types.get(key) {
            Some(value) => ir_type_from_layout_type(key, value, types, structs)?,
            None => parse_type_string(key, structs),
        };
        let value_ty = match types.get(value) {
            Some(value_entry) => ir_type_from_layout_type(value, value_entry, types, structs)?,
            None => parse_type_string(value, structs),
        };

        return Ok(IRType::Map {
            key: Box::new(key_ty),
            val: Box::new(value_ty),
        });
    }

    if label.starts_with("struct ") {
        if let Some(members) = type_entry.get("members").and_then(Value::as_array) {
            let mut items = Vec::new();
            for member in members {
                let member_type_id = required_str(member, "type")?;
                let member_ty = match types.get(member_type_id) {
                    Some(member_type) => {
                        ir_type_from_layout_type(member_type_id, member_type, types, structs)?
                    }
                    None => parse_type_string(member_type_id, structs),
                };
                items.push(member_ty);
            }
            return Ok(IRType::Tuple(items));
        }
    }

    Ok(parse_type_string(label, structs))
}

fn fallback_storage_layout(
    inheritance_chain: &[&Value],
    structs: &StructMap,
) -> Result<StorageLayout, String> {
    let mut seen = BTreeSet::new();
    let mut slots = Vec::new();

    for contract in inheritance_chain {
        for node in contract
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if node
                .get("nodeType")
                .and_then(Value::as_str)
                != Some("VariableDeclaration")
                || !node
                    .get("stateVariable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                continue;
            }

            let id = required_str(&node, "name")?.to_string();
            if !seen.insert(id.clone()) {
                continue;
            }

            let ty_str = node
                .pointer("/typeDescriptions/typeString")
                .and_then(Value::as_str)
                .unwrap_or("bytes");
            let normalized = normalize_type_string(ty_str);

            slots.push(StorageSlot {
                id,
                ty: parse_type_string(&normalized, structs),
                native_offset: slots.len() as u64,
                native_encoding: NativeEncoding::EvmSlot {
                    keccak_base: u16::from(normalized.starts_with("mapping(")),
                },
            });
        }
    }

    Ok(StorageLayout { slots })
}

fn split_top_level_once<'a>(input: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0i32;
    let bytes = input.as_bytes();
    let needle_bytes = needle.as_bytes();

    let mut index = 0usize;
    while index + needle_bytes.len() <= bytes.len() {
        match bytes[index] as char {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }

        if depth == 0 && &bytes[index..index + needle_bytes.len()] == needle_bytes {
            return Some((&input[..index], &input[index + needle.len()..]));
        }

        index += 1;
    }

    None
}

pub fn split_top_level_csv(input: &str) -> Vec<String> {
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut items = Vec::new();

    for (index, ch) in input.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                items.push(input[start..index].trim().to_string());
                start = index + 1;
            }
            _ => {}
        }
    }

    if start <= input.len() {
        let tail = input[start..].trim();
        if !tail.is_empty() {
            items.push(tail.to_string());
        }
    }

    items
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field `{key}`"))
}

fn parse_u64(raw: &str) -> Result<u64, String> {
    if let Some(hex) = raw.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).map_err(|err| err.to_string())
    } else {
        raw.parse::<u64>().map_err(|err| err.to_string())
    }
}
