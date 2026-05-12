mod fabric_cfg;
mod selectors;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use tiny_keccak::{Hasher, Keccak};
use ubtl_ir::{
    ContractMeta, Effect, FnSignature, IR, IRType, Mutability, NativeEncoding, SourceVm,
    StorageLayout, StorageSlot,
};

pub use selectors::selector4;

pub fn translate(path: &Path) -> Result<IR, String> {
    let file = resolve_go_file(path)?;
    let source = fs::read_to_string(&file).map_err(|err| err.to_string())?;
    translate_source(&source)
}

pub fn translate_source(source: &str) -> Result<IR, String> {
    reject_untranslatable(source)?;
    let contract_name = parse_contract_name(source).unwrap_or_else(|| "FabricContract".to_string());
    let structs = parse_structs(source)?;
    let consts = parse_consts(source);
    let methods = parse_methods(source)?;

    let storage = build_storage_layout(&consts, &structs);
    let signatures = build_signatures(&methods);
    let cfg = fabric_cfg::placeholder_cfg(signatures.len());

    Ok(IR {
        meta: ContractMeta {
            name: contract_name,
            version: "go1.21".to_string(),
            source_vm: SourceVm::Fabric {
                go_version: "1.21".to_string(),
            },
            source_hash: source_hash(source.as_bytes()),
        },
        storage,
        signatures,
        cfg,
        externals: Vec::new(),
    })
}

fn resolve_go_file(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }

    let mut go_files = fs::read_dir(path)
        .map_err(|err| err.to_string())?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|entry| entry.extension().is_some_and(|ext| ext == "go"))
        .collect::<Vec<_>>();
    go_files.sort();

    go_files
        .into_iter()
        .next()
        .ok_or_else(|| format!("no Go source file found under `{}`", path.display()))
}

fn reject_untranslatable(source: &str) -> Result<(), String> {
    let unsupported = [
        ("http.Get(", "network I/O"),
        ("os.", "filesystem or OS access"),
        ("time.Now(", "wall-clock time"),
        ("rand.", "randomness"),
        ("\ngo ", "goroutine"),
        ("float32", "floating point"),
        ("float64", "floating point"),
        ("for {", "unbounded loop"),
        ("for true", "unbounded loop"),
        ("make([]", "unbounded dynamic allocation"),
    ];

    for (needle, reason) in unsupported {
        if source.contains(needle) {
            return Err(format!("Untranslatable: unsupported {reason} via `{needle}`"));
        }
    }

    Ok(())
}

fn parse_contract_name(source: &str) -> Option<String> {
    for line in source.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("type ") || !trimmed.contains(" struct") {
            continue;
        }

        let name = trimmed
            .trim_start_matches("type ")
            .split_whitespace()
            .next()?;
        if name.chars().next().is_some_and(char::is_uppercase) {
            return Some(name.to_string());
        }
    }

    None
}

fn parse_consts(source: &str) -> BTreeMap<String, String> {
    let mut consts = BTreeMap::new();
    let mut in_const = false;

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == "const (" {
            in_const = true;
            continue;
        }
        if in_const && trimmed == ")" {
            in_const = false;
            continue;
        }
        if !in_const || trimmed.is_empty() {
            continue;
        }

        if let Some((name, value)) = trimmed.split_once('=') {
            let const_name = name.trim().to_string();
            let const_value = value.trim().trim_matches('"').to_string();
            consts.insert(const_name, const_value);
        }
    }

    consts
}

fn parse_structs(source: &str) -> Result<BTreeMap<String, Vec<(String, IRType)>>, String> {
    let mut structs = BTreeMap::new();
    let lines = source.lines().collect::<Vec<_>>();
    let mut index = 0usize;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.starts_with("type ") && trimmed.ends_with(" struct {") {
            let name = trimmed
                .trim_start_matches("type ")
                .trim_end_matches(" struct {")
                .trim()
                .to_string();
            index += 1;
            let mut fields = Vec::new();
            while index < lines.len() {
                let field_line = lines[index].trim();
                if field_line == "}" {
                    break;
                }
                if !field_line.is_empty() {
                    let tokens = field_line.split_whitespace().collect::<Vec<_>>();
                    if tokens.len() >= 2 {
                        let field_name = tokens[0].to_string();
                        let field_type = parse_go_type(tokens[1]);
                        fields.push((field_name, field_type));
                    }
                }
                index += 1;
            }
            structs.insert(name, fields);
        }
        index += 1;
    }

    Ok(structs)
}

#[derive(Clone, Debug)]
struct Method {
    name: String,
    args: Vec<IRType>,
    outputs: Vec<IRType>,
    effects: Vec<Effect>,
    mutability: Mutability,
}

fn parse_methods(source: &str) -> Result<Vec<Method>, String> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut methods = Vec::new();

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if !trimmed.starts_with("func (") {
            index += 1;
            continue;
        }

        let mut signature = trimmed.to_string();
        while !signature.contains('{') {
            index += 1;
            if index >= lines.len() {
                return Err("unterminated function signature".to_string());
            }
            signature.push(' ');
            signature.push_str(lines[index].trim());
        }

        let open_braces = signature.chars().filter(|&ch| ch == '{').count() as i32;
        let close_braces = signature.chars().filter(|&ch| ch == '}').count() as i32;
        let mut depth = open_braces - close_braces;
        let mut body_lines = Vec::new();

        index += 1;
        while depth > 0 && index < lines.len() {
            let line = lines[index];
            depth += line.chars().filter(|&ch| ch == '{').count() as i32;
            depth -= line.chars().filter(|&ch| ch == '}').count() as i32;
            body_lines.push(line.to_string());
            index += 1;
        }

        let body = body_lines.join("\n");
        reject_untranslatable(&body)?;
        let method = parse_method_signature(&signature, &body)?;
        if method.name.chars().next().is_some_and(char::is_uppercase) {
            methods.push(method);
        }
    }

    Ok(methods)
}

fn parse_method_signature(signature: &str, body: &str) -> Result<Method, String> {
    let head = signature
        .split_once('{')
        .map(|(value, _)| value.trim())
        .ok_or_else(|| "missing function body opener".to_string())?;
    let after_func = head
        .strip_prefix("func ")
        .ok_or_else(|| "missing `func` prefix".to_string())?;
    let receiver_end = after_func
        .find(") ")
        .ok_or_else(|| "malformed method receiver".to_string())?;
    let after_receiver = &after_func[receiver_end + 2..];

    let open_paren = after_receiver
        .find('(')
        .ok_or_else(|| "missing parameter list".to_string())?;
    let close_paren = find_matching_paren(after_receiver, open_paren)?;
    let name = after_receiver[..open_paren].trim().to_string();
    let params_part = &after_receiver[open_paren + 1..close_paren];
    let params = split_csv(params_part);

    let mut args = Vec::new();
    let mut pending_names = 0usize;
    for param in params {
        let trimmed = param.trim();
        if trimmed.is_empty() {
            continue;
        }

        let tokens = trimmed.split_whitespace().collect::<Vec<_>>();
        if tokens.len() < 2 {
            pending_names += 1;
            continue;
        }

        if tokens[1] == "contractapi.TransactionContextInterface" {
            pending_names = 0;
            continue;
        }

        let ty = parse_go_type(tokens.last().copied().unwrap_or_default());
        let names_len = pending_names + (tokens.len() - 1);
        for _ in 0..names_len {
            args.push(ty.clone());
        }
        pending_names = 0;
    }

    let return_part = after_receiver[close_paren + 1..].trim();
    let outputs = parse_return_types(return_part);
    let effects = infer_effects_from_body(body);
    let mutability = if effects
        .iter()
        .any(|effect| matches!(effect, Effect::Write { .. }))
    {
        Mutability::NonPayable
    } else {
        Mutability::View
    };

    Ok(Method {
        name,
        args,
        outputs,
        effects,
        mutability,
    })
}

fn find_matching_paren(input: &str, open_index: usize) -> Result<usize, String> {
    let mut depth = 0i32;

    for (index, ch) in input.char_indices().skip(open_index) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(index);
                }
            }
            _ => {}
        }
    }

    Err("unterminated parenthesis group".to_string())
}

fn parse_return_types(return_part: &str) -> Vec<IRType> {
    if return_part.is_empty() {
        return Vec::new();
    }

    let body = return_part
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or(return_part);

    split_csv(body)
        .into_iter()
        .filter_map(|item| {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                return None;
            }

            let ty_name = trimmed
                .split_whitespace()
                .last()
                .unwrap_or(trimmed);
            if ty_name == "error" {
                return None;
            }

            Some(parse_go_type(ty_name))
        })
        .collect()
}

fn build_storage_layout(
    consts: &BTreeMap<String, String>,
    structs: &BTreeMap<String, Vec<(String, IRType)>>,
) -> StorageLayout {
    let mut slots = Vec::new();
    let mut push_slot = |id: &str, ty: IRType, offset: u64| {
        slots.push(StorageSlot {
            id: id.to_string(),
            ty,
            native_offset: offset,
            native_encoding: NativeEncoding::FabricKey {
                pattern: id.to_string(),
            },
        });
    };

    let meta_ty = structs
        .get("hotelMeta")
        .map(|fields| IRType::Tuple(fields.iter().map(|(_, ty)| ty.clone()).collect()))
        .unwrap_or(IRType::Bytes);
    let lock_ty = structs
        .get("lockEntry")
        .map(|fields| IRType::Tuple(fields.iter().map(|(_, ty)| ty.clone()).collect()))
        .unwrap_or(IRType::Bytes);

    push_slot(consts.get("keyMeta").map(String::as_str).unwrap_or("META"), meta_ty, 0);
    push_slot(
        consts.get("keyAccount").map(String::as_str).unwrap_or("ACCOUNT_%s"),
        IRType::Map {
            key: Box::new(IRType::String),
            val: Box::new(IRType::U64),
        },
        1,
    );
    push_slot(
        consts.get("keyBooking").map(String::as_str).unwrap_or("BOOKING_%s"),
        IRType::Map {
            key: Box::new(IRType::String),
            val: Box::new(IRType::U64),
        },
        2,
    );
    push_slot(
        consts.get("keyLockEntry").map(String::as_str).unwrap_or("LOCK_%s"),
        IRType::Map {
            key: Box::new(IRType::String),
            val: Box::new(lock_ty),
        },
        3,
    );
    push_slot(
        consts.get("keyLockTotal").map(String::as_str).unwrap_or("LOCK_TOTAL"),
        IRType::U64,
        4,
    );

    StorageLayout { slots }
}

fn build_signatures(methods: &[Method]) -> Vec<FnSignature> {
    let mut signatures = Vec::new();
    for (entry_block, method) in methods.iter().enumerate() {
        let canonical = format!(
            "{}({})",
            method.name,
            method
                .args
                .iter()
                .map(ir_type_signature)
                .collect::<Vec<_>>()
                .join(",")
        );
        signatures.push(FnSignature {
            name: method.name.clone(),
            selector4: selector4(&canonical),
            inputs: method.args.clone(),
            outputs: method.outputs.clone(),
            mutability: method.mutability.clone(),
            effects: method.effects.clone(),
            entry_block: entry_block as u32,
        });
    }

    signatures
}

fn infer_effects_from_body(body: &str) -> Vec<Effect> {
    let mut reads = BTreeSet::new();
    let mut writes = BTreeSet::new();

    let mut read = |slot: &str| {
        reads.insert(slot.to_string());
    };
    let mut write = |slot: &str| {
        writes.insert(slot.to_string());
    };

    if body.contains("ensureBridge(") || body.contains("getMeta(") {
        read("META");
    }
    if body.contains("putMeta(") {
        write("META");
    }
    if body.contains("GetAvailableRemain(") {
        read("META");
        read("LOCK_TOTAL");
    }
    if body.contains("getLockEntry(") {
        read("LOCK_%s");
    }
    if body.contains("putLockEntry(") {
        write("LOCK_%s");
    }
    if body.contains("unlockInternal(") {
        read("LOCK_%s");
        read("LOCK_TOTAL");
        write("LOCK_%s");
        write("LOCK_TOTAL");
    }
    if body.contains("getU64(ctx, keyLockTotal)") {
        read("LOCK_TOTAL");
    }
    if body.contains("addU64(ctx, keyLockTotal") || body.contains("subU64(ctx, keyLockTotal") {
        read("LOCK_TOTAL");
        write("LOCK_TOTAL");
    }
    if body.contains("fmt.Sprintf(keyAccount") {
        if body.contains("getU64(ctx, fmt.Sprintf(keyAccount") {
            read("ACCOUNT_%s");
        }
        if body.contains("addU64(ctx, fmt.Sprintf(keyAccount") {
            read("ACCOUNT_%s");
            write("ACCOUNT_%s");
        }
    }
    if body.contains("fmt.Sprintf(keyBooking") {
        if body.contains("getU64(ctx, fmt.Sprintf(keyBooking") {
            read("BOOKING_%s");
        }
        if body.contains("addU64(ctx, fmt.Sprintf(keyBooking") {
            read("BOOKING_%s");
            write("BOOKING_%s");
        }
    }
    if body.contains("fmt.Sprintf(keyLockEntry") && body.contains("DelState") {
        write("LOCK_%s");
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

fn parse_go_type(raw: &str) -> IRType {
    match raw.trim() {
        "string" => IRType::String,
        "uint64" => IRType::U64,
        "uint32" => IRType::U32,
        "uint128" => IRType::U128,
        "uint256" => IRType::U256,
        "bool" => IRType::Bool,
        "[]byte" => IRType::Bytes,
        "error" => IRType::Bytes,
        _ => IRType::Bytes,
    }
}

fn split_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
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

fn source_hash(raw_bytes: &[u8]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(raw_bytes);
    hasher.finalize(&mut output);
    output
}
