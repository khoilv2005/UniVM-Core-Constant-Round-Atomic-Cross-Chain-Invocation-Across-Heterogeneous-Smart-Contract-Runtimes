use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use ubtl_ir::{Effect, ExternalCall, ExternalTarget, FnSignature, IRType, Mutability};

use crate::selectors::{selector4, selector4_hex};
use crate::storage_layout::{normalize_type_string, parse_type_string, split_top_level_csv, StructMap};

#[derive(Clone, Debug)]
pub struct ArtifactBundle {
    pub solc_version: String,
    pub contracts: BTreeMap<(String, String), Value>,
    pub sources: BTreeMap<String, Value>,
}

#[derive(Clone, Debug)]
pub struct ContractRef {
    pub source_path: String,
    pub name: String,
    pub node: Value,
}

#[derive(Clone, Debug)]
pub struct ContractIndex {
    pub contracts_by_id: BTreeMap<u64, ContractRef>,
    pub contracts_by_name: BTreeMap<String, Vec<ContractRef>>,
    pub structs: StructMap,
}

pub fn load_bundle(root: &Value) -> Result<ArtifactBundle, String> {
    let solc_version = root
        .get("solcVersion")
        .and_then(Value::as_str)
        .or_else(|| root.pointer("/compiler/version").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    let mut contracts = BTreeMap::new();
    if let Some(output_contracts) = root.pointer("/output/contracts").and_then(Value::as_object) {
        flatten_nested_contracts(output_contracts, &mut contracts);
    } else if let Some(flat_contracts) = root.get("contracts").and_then(Value::as_object) {
        if flat_contracts.keys().any(|key| key.contains(':')) {
            flatten_flat_contracts(flat_contracts, &mut contracts);
        } else {
            flatten_nested_contracts(flat_contracts, &mut contracts);
        }
    }

    let mut sources = BTreeMap::new();
    if let Some(output_sources) = root.pointer("/output/sources").and_then(Value::as_object) {
        collect_sources(output_sources, &mut sources);
    } else if let Some(flat_sources) = root.get("sources").and_then(Value::as_object) {
        collect_sources(flat_sources, &mut sources);
    }

    if contracts.is_empty() {
        return Err("no contracts found in artifact bundle".to_string());
    }

    Ok(ArtifactBundle {
        solc_version,
        contracts,
        sources,
    })
}

pub fn build_index(bundle: &ArtifactBundle) -> ContractIndex {
    let mut contracts_by_id = BTreeMap::new();
    let mut contracts_by_name: BTreeMap<String, Vec<ContractRef>> = BTreeMap::new();
    let mut structs = StructMap::new();

    for (source_path, ast) in &bundle.sources {
        for node in ast
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if node.get("nodeType").and_then(Value::as_str) != Some("ContractDefinition") {
                continue;
            }

            let Some(id) = node.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(name) = node.get("name").and_then(Value::as_str) else {
                continue;
            };

            let contract = ContractRef {
                source_path: source_path.clone(),
                name: name.to_string(),
                node: node.clone(),
            };

            collect_structs(&contract, &mut structs);
            contracts_by_id.insert(id, contract.clone());
            contracts_by_name
                .entry(contract.name.clone())
                .or_default()
                .push(contract);
        }
    }

    ContractIndex {
        contracts_by_id,
        contracts_by_name,
        structs,
    }
}

pub fn resolve_contract(
    bundle: &ArtifactBundle,
    index: &ContractIndex,
    contract_name: Option<&str>,
) -> Result<(ContractRef, Value), String> {
    let selected = if let Some(name) = contract_name {
        let matches = index
            .contracts_by_name
            .get(name)
            .ok_or_else(|| format!("contract `{name}` not found in AST index"))?;
        if matches.len() != 1 {
            return Err(format!(
                "contract `{name}` is ambiguous; found {} matches",
                matches.len()
            ));
        }
        matches[0].clone()
    } else if bundle.contracts.len() == 1 {
        let ((source_path, contract), _) = bundle
            .contracts
            .iter()
            .next()
            .ok_or_else(|| "artifact bundle is empty".to_string())?;
        index
            .contracts_by_name
            .get(contract)
            .and_then(|matches| {
                matches
                    .iter()
                    .find(|item| item.source_path == *source_path)
                    .cloned()
            })
            .ok_or_else(|| format!("contract `{contract}` missing from AST sources"))?
    } else {
        return Err("multiple contracts found; pass --contract <Name>".to_string());
    };

    let artifact = bundle
        .contracts
        .get(&(selected.source_path.clone(), selected.name.clone()))
        .cloned()
        .ok_or_else(|| {
            format!(
                "artifact for `{}` at `{}` not found",
                selected.name, selected.source_path
            )
        })?;

    Ok((selected, artifact))
}

pub fn inheritance_chain(
    target: &ContractRef,
    index: &ContractIndex,
) -> Result<Vec<ContractRef>, String> {
    let mut chain = Vec::new();
    let Some(ids) = target
        .node
        .get("linearizedBaseContracts")
        .and_then(Value::as_array)
    else {
        return Ok(vec![target.clone()]);
    };

    for id in ids.iter().rev() {
        let Some(contract_id) = id.as_u64() else {
            continue;
        };
        let contract = index
            .contracts_by_id
            .get(&contract_id)
            .cloned()
            .ok_or_else(|| format!("missing contract node for id {contract_id}"))?;
        chain.push(contract);
    }

    Ok(chain)
}

pub fn build_signatures_and_externals(
    artifact: &Value,
    inheritance_chain: &[ContractRef],
    state_slots: &BTreeSet<String>,
    structs: &StructMap,
) -> Result<(Vec<FnSignature>, Vec<ExternalCall>), String> {
    let abi_items = parse_abi_items(artifact)?;
    let function_map = collect_function_map(inheritance_chain);

    let mut signatures = Vec::new();
    let mut externals = BTreeMap::new();

    for (entry_block, item) in abi_items.iter().enumerate() {
        if item.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }

        let name = required_str(item, "name")?.to_string();
        let inputs = abi_parameter_types(item.get("inputs"), structs);
        let outputs = abi_parameter_types(item.get("outputs"), structs);
        let signature = abi_signature(item)?;
        let ast_function = function_map.get(&signature);
        let (effects, function_externals) =
            analyze_effects(ast_function, &name, state_slots, structs);

        for external in function_externals {
            externals.entry(external.id.clone()).or_insert(external);
        }

        signatures.push(FnSignature {
            name,
            selector4: selector4(&signature),
            inputs,
            outputs,
            mutability: abi_mutability(item),
            effects,
            entry_block: entry_block as u32,
        });
    }

    Ok((signatures, externals.into_values().collect()))
}

fn flatten_nested_contracts(
    contracts: &serde_json::Map<String, Value>,
    out: &mut BTreeMap<(String, String), Value>,
) {
    for (source_path, value) in contracts {
        let Some(by_name) = value.as_object() else {
            continue;
        };
        for (contract_name, artifact) in by_name {
            out.insert((source_path.clone(), contract_name.clone()), artifact.clone());
        }
    }
}

fn flatten_flat_contracts(
    contracts: &serde_json::Map<String, Value>,
    out: &mut BTreeMap<(String, String), Value>,
) {
    for (key, artifact) in contracts {
        let Some((source_path, contract_name)) = key.rsplit_once(':') else {
            continue;
        };
        out.insert((source_path.to_string(), contract_name.to_string()), artifact.clone());
    }
}

fn collect_sources(sources: &serde_json::Map<String, Value>, out: &mut BTreeMap<String, Value>) {
    for (source_path, value) in sources {
        if let Some(ast) = value.get("ast") {
            out.insert(source_path.clone(), ast.clone());
        }
    }
}

fn collect_structs(contract: &ContractRef, structs: &mut StructMap) {
    for node in contract
        .node
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if node.get("nodeType").and_then(Value::as_str) != Some("StructDefinition") {
            continue;
        }

        let Some(struct_name) = node.get("name").and_then(Value::as_str) else {
            continue;
        };

        let fields = node
            .get("members")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|member| {
                let name = member.get("name").and_then(Value::as_str)?.to_string();
                let ty = member
                    .pointer("/typeDescriptions/typeString")
                    .and_then(Value::as_str)
                    .unwrap_or("bytes")
                    .to_string();
                Some((name, ty))
            })
            .collect::<Vec<_>>();

        let qualified = format!("{}.{}", contract.name, struct_name);
        structs.insert(qualified, fields.clone());
        structs.entry(struct_name.to_string()).or_insert(fields);
    }
}

fn parse_abi_items(artifact: &Value) -> Result<Vec<Value>, String> {
    match artifact.get("abi") {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(raw)) => serde_json::from_str(raw).map_err(|err| err.to_string()),
        _ => Ok(Vec::new()),
    }
}

fn collect_function_map(inheritance_chain: &[ContractRef]) -> BTreeMap<String, Value> {
    let mut functions = BTreeMap::new();

    for contract in inheritance_chain {
        for node in contract
            .node
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if node.get("nodeType").and_then(Value::as_str) != Some("FunctionDefinition")
                || node.get("kind").and_then(Value::as_str) != Some("function")
            {
                continue;
            }

            let visibility = node.get("visibility").and_then(Value::as_str).unwrap_or_default();
            if visibility != "public" && visibility != "external" {
                continue;
            }

            if let Ok(signature) = ast_signature(&node) {
                functions.insert(signature, node);
            }
        }
    }

    functions
}

fn ast_signature(function: &Value) -> Result<String, String> {
    let name = required_str(function, "name")?;
    let types = function
        .pointer("/parameters/parameters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|parameter| {
            let raw = parameter
                .pointer("/typeDescriptions/typeString")
                .and_then(Value::as_str)
                .unwrap_or("bytes");
            signature_type_from_raw(raw)
        })
        .collect::<Vec<_>>();

    Ok(format!("{name}({})", types.join(",")))
}

fn abi_signature(item: &Value) -> Result<String, String> {
    let name = required_str(item, "name")?;
    let inputs = item
        .get("inputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|input| {
            input
                .get("type")
                .and_then(Value::as_str)
                .map(signature_type_from_raw)
                .unwrap_or_else(|| "bytes".to_string())
        })
        .collect::<Vec<_>>();

    Ok(format!("{name}({})", inputs.join(",")))
}

fn abi_parameter_types(parameters: Option<&Value>, structs: &StructMap) -> Vec<IRType> {
    parameters
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|parameter| {
            let raw = parameter
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("bytes");
            parse_type_string(&signature_type_from_raw(raw), structs)
        })
        .collect()
}

fn abi_mutability(item: &Value) -> Mutability {
    match item
        .get("stateMutability")
        .and_then(Value::as_str)
        .unwrap_or("nonpayable")
    {
        "view" => Mutability::View,
        "pure" => Mutability::Pure,
        "payable" => Mutability::Payable,
        _ => Mutability::NonPayable,
    }
}

fn signature_type_from_raw(raw: &str) -> String {
    let normalized = normalize_type_string(raw);
    if normalized.starts_with("contract ") {
        return "address".to_string();
    }
    normalized
}

fn analyze_effects(
    function: Option<&Value>,
    fallback_getter_name: &str,
    state_slots: &BTreeSet<String>,
    structs: &StructMap,
) -> (Vec<Effect>, Vec<ExternalCall>) {
    let mut collector = EffectCollector {
        state_slots,
        structs,
        reads: BTreeSet::new(),
        writes: BTreeSet::new(),
        calls: BTreeSet::new(),
        externals: BTreeMap::new(),
    };

    match function.and_then(|item| item.get("body")) {
        Some(body) => collector.walk(body),
        None if state_slots.contains(fallback_getter_name) => {
            collector.reads.insert(fallback_getter_name.to_string());
        }
        None => {}
    }

    let mut effects = Vec::new();
    for slot in collector.reads {
        effects.push(Effect::Read { slot });
    }
    for slot in collector.writes {
        effects.push(Effect::Write { slot });
    }
    for external_id in collector.calls {
        effects.push(Effect::Call { external_id });
    }

    (effects, collector.externals.into_values().collect())
}

struct EffectCollector<'a> {
    state_slots: &'a BTreeSet<String>,
    structs: &'a StructMap,
    reads: BTreeSet<String>,
    writes: BTreeSet<String>,
    calls: BTreeSet<String>,
    externals: BTreeMap<String, ExternalCall>,
}

impl EffectCollector<'_> {
    fn walk(&mut self, node: &Value) {
        if let Some(node_type) = node.get("nodeType").and_then(Value::as_str) {
            match node_type {
                "Assignment" => {
                    self.handle_assignment(node);
                    return;
                }
                "FunctionCall" => {
                    self.handle_function_call(node);
                    return;
                }
                "Identifier" => {
                    if let Some(slot) = self.extract_slot_name(node) {
                        self.reads.insert(slot);
                    }
                    return;
                }
                "IndexAccess" => {
                    if let Some(slot) = self.extract_slot_name(node) {
                        self.reads.insert(slot);
                    }
                    if let Some(index) = node.get("indexExpression") {
                        self.walk(index);
                    }
                    return;
                }
                "UnaryOperation" => {
                    self.handle_unary(node);
                    return;
                }
                _ => {}
            }
        }

        match node {
            Value::Array(items) => {
                for item in items {
                    self.walk(item);
                }
            }
            Value::Object(object) => {
                for child in object.values() {
                    self.walk(child);
                }
            }
            _ => {}
        }
    }

    fn handle_assignment(&mut self, node: &Value) {
        let operator = node.get("operator").and_then(Value::as_str).unwrap_or("=");

        if let Some(lhs) = node.get("leftHandSide") {
            if let Some(slot) = self.extract_slot_name(lhs) {
                self.writes.insert(slot.clone());
                if operator != "=" {
                    self.reads.insert(slot);
                }
            }

            if let Some(index) = lhs.get("indexExpression") {
                self.walk(index);
            }
        }

        if let Some(rhs) = node.get("rightHandSide") {
            self.walk(rhs);
        }
    }

    fn handle_function_call(&mut self, node: &Value) {
        if self.is_require_call(node) {
            for arg in node
                .get("arguments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                self.walk(&arg);
            }
            return;
        }

        if let Some((slot, mutates)) = self.classify_lockpool_call(node) {
            self.reads.insert(slot.clone());
            if mutates {
                self.writes.insert(slot);
            }

            for argument in node
                .get("arguments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .skip(1)
            {
                self.walk(&argument);
            }
            return;
        }

        if let Some(external) = self.classify_external_call(node) {
            self.calls.insert(external.id.clone());
            self.externals.entry(external.id.clone()).or_insert(external);
        }

        if let Some(expression) = node.get("expression") {
            self.walk(expression);
        }
        for argument in node
            .get("arguments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            self.walk(&argument);
        }
    }

    fn handle_unary(&mut self, node: &Value) {
        if let Some(expression) = node.get("subExpression") {
            if let Some(slot) = self.extract_slot_name(expression) {
                self.reads.insert(slot.clone());
                self.writes.insert(slot);
            }
            self.walk(expression);
        }
    }

    fn extract_slot_name(&self, node: &Value) -> Option<String> {
        match node.get("nodeType").and_then(Value::as_str) {
            Some("Identifier") => {
                let name = node.get("name").and_then(Value::as_str)?;
                self.state_slots.contains(name).then(|| name.to_string())
            }
            Some("IndexAccess") => node
                .get("baseExpression")
                .and_then(|value| self.extract_slot_name(value)),
            Some("MemberAccess") => node
                .get("expression")
                .and_then(|value| self.extract_slot_name(value)),
            _ => None,
        }
    }

    fn is_require_call(&self, node: &Value) -> bool {
        node.pointer("/expression/nodeType").and_then(Value::as_str) == Some("Identifier")
            && node.pointer("/expression/name").and_then(Value::as_str) == Some("require")
    }

    fn classify_lockpool_call(&self, node: &Value) -> Option<(String, bool)> {
        let member = node.pointer("/expression/memberName").and_then(Value::as_str)?;
        let library_name = node
            .pointer("/expression/expression/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if library_name != "LockPoolLib" {
            return None;
        }

        let slot = node
            .get("arguments")
            .and_then(Value::as_array)
            .and_then(|arguments| arguments.first())
            .and_then(|value| self.extract_slot_name(value))?;

        let mutates = matches!(member, "lock" | "unlock" | "unlockOnTimeout");
        Some((slot, mutates))
    }

    fn classify_external_call(&self, node: &Value) -> Option<ExternalCall> {
        let expression = node.get("expression")?;
        if expression.get("nodeType").and_then(Value::as_str) != Some("MemberAccess") {
            return None;
        }

        let member_name = expression.get("memberName").and_then(Value::as_str)?;
        let function_type = expression
            .pointer("/typeDescriptions/typeString")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if !function_type.contains(" external ") {
            return None;
        }

        let base_name = expression
            .pointer("/expression/expression/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if base_name == "abi" || base_name == "LockPoolLib" {
            return None;
        }

        let argument_types = parse_function_arg_types(function_type, self.structs);
        let return_types = parse_function_return_types(function_type, self.structs);
        let signature = format!(
            "{member_name}({})",
            argument_types
                .iter()
                .map(ir_type_signature)
                .collect::<Vec<_>>()
                .join(",")
        );
        let selector = selector4(&signature);
        let id = format!("ext_{member_name}_{}", selector4_hex(selector));

        Some(ExternalCall {
            id,
            target: ExternalTarget::OtherContract { iface_hash: [0u8; 32] },
            selector4: selector,
            argtypes: argument_types,
            ret: return_types,
        })
    }
}

fn parse_function_arg_types(raw: &str, structs: &StructMap) -> Vec<IRType> {
    let Some(body) = raw.strip_prefix("function (") else {
        return Vec::new();
    };
    let Some((args, _)) = body.split_once(')') else {
        return Vec::new();
    };
    split_top_level_csv(args)
        .into_iter()
        .filter(|arg| !arg.trim().is_empty())
        .map(|arg| parse_type_string(arg.trim(), structs))
        .collect()
}

fn parse_function_return_types(raw: &str, structs: &StructMap) -> Vec<IRType> {
    let Some(return_start) = raw.find("returns (") else {
        return Vec::new();
    };
    let returns = &raw[return_start + "returns (".len()..];
    let Some(inner) = returns.strip_suffix(')') else {
        return Vec::new();
    };
    split_top_level_csv(inner)
        .into_iter()
        .filter(|ret| !ret.trim().is_empty())
        .map(|ret| parse_type_string(ret.trim(), structs))
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

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field `{key}`"))
}
