use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use ubtl_ir::{Effect, FnSignature, IRType, Mutability, NativeEncoding, StorageLayout, StorageSlot};

use crate::selectors::canonical_selector4;

#[derive(Clone, Debug)]
pub struct MetadataBundle {
    pub contract_name: String,
    pub ink_version: String,
    pub metadata: Value,
}

pub fn load_bundle(root: &Value) -> Result<MetadataBundle, String> {
    let metadata = if root.get("spec").is_some() && root.get("storage").is_some() {
        root.clone()
    } else if let Some(metadata) = root.get("metadata") {
        metadata.clone()
    } else {
        return Err("missing ink! metadata root".to_string());
    };

    let contract_name = root
        .pointer("/contract/name")
        .and_then(Value::as_str)
        .or_else(|| metadata.pointer("/contract/name").and_then(Value::as_str))
        .unwrap_or("InkContract")
        .to_string();
    let ink_version = root
        .pointer("/version")
        .and_then(Value::as_str)
        .or_else(|| root.pointer("/source/compiler").and_then(Value::as_str))
        .or_else(|| metadata.pointer("/version").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string();

    Ok(MetadataBundle {
        contract_name,
        ink_version,
        metadata,
    })
}

pub fn reject_unsupported_constructs(metadata: &Value) -> Result<(), String> {
    fn walk(value: &Value) -> Result<(), String> {
        if value.pointer("/def/sequence").is_some() {
            return Err("Untranslatable: unbounded sequence type".to_string());
        }
        if let Some(primitive) = value.pointer("/def/primitive").and_then(Value::as_str) {
            if matches!(primitive, "f32" | "f64") {
                return Err("Untranslatable: floating point type".to_string());
            }
        }

        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item)?;
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    walk(item)?;
                }
            }
            _ => {}
        }

        Ok(())
    }

    walk(metadata)
}

pub fn extract_storage(metadata: &Value) -> Result<StorageLayout, String> {
    let registry = TypeRegistry::from_root(metadata);
    let layout = metadata
        .pointer("/storage/root/layout")
        .or_else(|| metadata.pointer("/storage/layout"))
        .ok_or_else(|| "missing storage layout".to_string())?;

    let mut slots = Vec::new();
    let mut offset = 0u64;
    collect_storage_slots(layout, None, &registry, &mut slots, &mut offset);

    Ok(StorageLayout { slots })
}

pub fn extract_signatures(
    metadata: &Value,
    storage: &StorageLayout,
) -> Result<Vec<FnSignature>, String> {
    let registry = TypeRegistry::from_root(metadata);
    let state_slots = storage
        .slots
        .iter()
        .map(|slot| slot.id.clone())
        .collect::<BTreeSet<_>>();
    let messages = metadata
        .pointer("/spec/messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut signatures = Vec::new();
    for (entry_block, message) in messages.iter().enumerate() {
        let name = message_name(message)?;
        let inputs = abi_types_from_args(message.get("args"), &registry);
        let outputs = return_types_from_message(message, &registry);
        let signature = canonical_signature(&name, &inputs);
        let effects = infer_effects(&name, &state_slots);

        signatures.push(FnSignature {
            name,
            selector4: canonical_selector4(&signature),
            inputs,
            outputs,
            mutability: message_mutability(message),
            effects,
            entry_block: entry_block as u32,
        });
    }

    Ok(signatures)
}

fn collect_storage_slots(
    layout: &Value,
    preferred_name: Option<String>,
    registry: &TypeRegistry,
    slots: &mut Vec<StorageSlot>,
    next_offset: &mut u64,
) {
    if let Some(root) = layout.get("root") {
        if let Some(root_layout) = root.get("layout") {
            collect_storage_slots(root_layout, preferred_name, registry, slots, next_offset);
            return;
        }
        collect_storage_slots(root, preferred_name, registry, slots, next_offset);
        return;
    }

    if let Some(struct_fields) = layout.pointer("/struct/fields").and_then(Value::as_array) {
        for field in struct_fields {
            let field_name = field
                .get("name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let next_name = field_name.or_else(|| preferred_name.clone());
            if let Some(child_layout) = field.get("layout") {
                collect_storage_slots(child_layout, next_name, registry, slots, next_offset);
            }
        }
        return;
    }

    if let Some(leaf) = layout.get("leaf") {
        let ty = leaf
            .get("ty")
            .map(|ty_ref| registry.resolve_type_ref(ty_ref))
            .unwrap_or(IRType::Bytes);
        let id = preferred_name.unwrap_or_else(|| {
            let name = slots.len();
            format!("slot{name}")
        });
        slots.push(StorageSlot {
            id,
            ty,
            native_offset: *next_offset,
            native_encoding: NativeEncoding::WasmMap {
                hash: "Blake2b_128".to_string(),
            },
        });
        *next_offset += 1;
        return;
    }

    if let Some(cell_layout) = layout.get("layout") {
        collect_storage_slots(cell_layout, preferred_name, registry, slots, next_offset);
    }
}

fn message_name(message: &Value) -> Result<String, String> {
    if let Some(label) = message.get("label") {
        match label {
            Value::String(value) => return Ok(value.clone()),
            Value::Array(parts) => {
                let joined = parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("_");
                if !joined.is_empty() {
                    return Ok(joined);
                }
            }
            _ => {}
        }
    }

    Err("message is missing label".to_string())
}

fn abi_types_from_args(args: Option<&Value>, registry: &TypeRegistry) -> Vec<IRType> {
    args.and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|arg| {
            arg.get("type")
                .map(|ty_ref| registry.resolve_type_ref(ty_ref))
                .unwrap_or(IRType::Bytes)
        })
        .collect()
}

fn return_types_from_message(message: &Value, registry: &TypeRegistry) -> Vec<IRType> {
    match message.get("returnType") {
        Some(return_type) => {
            let resolved = registry.resolve_return_type(return_type);
            if matches!(resolved, IRType::Tuple(ref items) if items.is_empty()) {
                Vec::new()
            } else {
                vec![resolved]
            }
        }
        None => Vec::new(),
    }
}

fn message_mutability(message: &Value) -> Mutability {
    if message
        .get("mutates")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Mutability::NonPayable
    } else {
        Mutability::View
    }
}

fn canonical_signature(name: &str, inputs: &[IRType]) -> String {
    let args = inputs
        .iter()
        .map(ir_type_signature)
        .collect::<Vec<_>>()
        .join(",");
    format!("{name}({args})")
}

fn ir_type_signature(ty: &IRType) -> String {
    match ty {
        IRType::U256 => "uint256".to_string(),
        IRType::U128 => "uint128".to_string(),
        IRType::U64 => "uint64".to_string(),
        IRType::U32 => "uint32".to_string(),
        IRType::Bool => "bool".to_string(),
        IRType::Address => "address".to_string(),
        IRType::Bytes => "bytes".to_string(),
        IRType::String => "string".to_string(),
        IRType::Map { .. } => "bytes".to_string(),
        IRType::Tuple(items) => format!(
            "tuple({})",
            items
                .iter()
                .map(ir_type_signature)
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn infer_effects(name: &str, state_slots: &BTreeSet<String>) -> Vec<Effect> {
    let mut reads = BTreeSet::new();
    let mut writes = BTreeSet::new();

    let mut read = |slot: &str| {
        if state_slots.contains(slot) {
            reads.insert(slot.to_string());
        }
    };
    let mut write = |slot: &str| {
        if state_slots.contains(slot) {
            writes.insert(slot.to_string());
        }
    };

    match name {
        "get_price" => read("price"),
        "get_remain" => read("remain"),
        "get_available_remain" => {
            read("remain");
            read("locked_total");
            read("price");
        }
        "get_account_balance" => read("accounts"),
        "get_booking" => read("bookings"),
        "is_state_locked" => read("locks"),
        "book_local" => {
            read("remain");
            read("locked_total");
            read("price");
            read("accounts");
            read("bookings");
            write("remain");
            write("accounts");
            write("bookings");
        }
        "lock_state" => {
            read("bridge");
            read("locks");
            read("remain");
            read("locked_total");
            read("price");
            read("lock_size");
            write("locks");
            write("locked_total");
        }
        "update_state" => {
            read("bridge");
            read("locks");
            read("accounts");
            read("bookings");
            write("locks");
            write("locked_total");
            write("remain");
            write("accounts");
            write("bookings");
        }
        "unlock_state" => {
            read("bridge");
            read("locks");
            write("locks");
            write("locked_total");
        }
        "unlock_on_timeout" => {
            read("locks");
            write("locks");
            write("locked_total");
        }
        "set_bridge" => {
            read("bridge");
            write("bridge");
        }
        _ => {
            if let Some(slot) = name.strip_prefix("get_") {
                if state_slots.contains(slot) {
                    read(slot);
                }
            }
        }
    }

    let mut effects = Vec::new();
    for slot in reads {
        effects.push(Effect::Read { slot });
    }
    for slot in writes {
        effects.push(Effect::Write { slot });
    }
    effects
}

struct TypeRegistry {
    by_id: BTreeMap<u64, Value>,
}

impl TypeRegistry {
    fn from_root(root: &Value) -> Self {
        let mut by_id = BTreeMap::new();
        for entry in root
            .get("types")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if let Some(id) = entry.get("id").and_then(Value::as_u64) {
                by_id.insert(id, entry);
            }
        }

        Self { by_id }
    }

    fn resolve_return_type(&self, ty_ref: &Value) -> IRType {
        let resolved = self.resolve_type_ref(ty_ref);
        match resolved {
            IRType::Tuple(items) if items.is_empty() => IRType::Tuple(Vec::new()),
            other => other,
        }
    }

    fn resolve_type_ref(&self, ty_ref: &Value) -> IRType {
        if let Some(id) = ty_ref.as_u64() {
            return self.resolve_type_id(id);
        }
        if let Some(id) = ty_ref.get("type").and_then(Value::as_u64) {
            return self.resolve_type_id(id);
        }
        IRType::Bytes
    }

    fn resolve_type_id(&self, id: u64) -> IRType {
        let Some(entry) = self.by_id.get(&id) else {
            return IRType::Bytes;
        };
        let type_value = entry.get("type").unwrap_or(entry);
        self.resolve_type_value(type_value)
    }

    fn resolve_type_value(&self, ty: &Value) -> IRType {
        let path = ty
            .get("path")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        let path_name = path.join("::");
        let last = path.last().map(String::as_str).unwrap_or_default();

        if matches!(last, "AccountId" | "AccountId32") {
            return IRType::Address;
        }
        if last == "Balance" {
            return IRType::U128;
        }
        if last == "BlockNumber" {
            return IRType::U32;
        }
        if last == "Mapping" {
            let params = ty
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if params.len() >= 2 {
                return IRType::Map {
                    key: Box::new(self.resolve_type_ref(&params[0])),
                    val: Box::new(self.resolve_type_ref(&params[1])),
                };
            }
            return IRType::Bytes;
        }
        if last == "Result" {
            let params = ty
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(ok) = params.first() {
                return self.resolve_type_ref(ok);
            }
            return IRType::Bytes;
        }
        if last == "Option" {
            let params = ty
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(inner) = params.first() {
                return self.resolve_type_ref(inner);
            }
            return IRType::Bytes;
        }

        if let Some(primitive) = ty.pointer("/def/primitive").and_then(Value::as_str) {
            return match primitive {
                "u128" => IRType::U128,
                "u64" => IRType::U64,
                "u32" => IRType::U32,
                "u16" | "u8" => IRType::U32,
                "bool" => IRType::Bool,
                "str" => IRType::String,
                _ => IRType::Bytes,
            };
        }

        if ty.pointer("/def/sequence").is_some() {
            return IRType::Bytes;
        }

        if let Some(fields) = ty.pointer("/def/tuple/fields").and_then(Value::as_array) {
            return IRType::Tuple(fields.iter().map(|field| self.resolve_type_ref(field)).collect());
        }

        if let Some(fields) = ty.pointer("/def/composite/fields").and_then(Value::as_array) {
            if path_name.contains("Result") {
                let params = ty
                    .get("params")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some(ok) = params.first() {
                    return self.resolve_type_ref(ok);
                }
            }
            return IRType::Tuple(fields.iter().map(|field| {
                field.get("type")
                    .map(|value| self.resolve_type_ref(value))
                    .unwrap_or(IRType::Bytes)
            }).collect());
        }

        IRType::Bytes
    }
}
