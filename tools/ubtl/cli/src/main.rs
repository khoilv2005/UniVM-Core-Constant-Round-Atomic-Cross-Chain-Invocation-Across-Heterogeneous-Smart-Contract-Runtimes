use std::env;
use std::error::Error;
use std::fs;
use std::path::Path;

use ubtl_ir::IR;

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("hash") => run_hash(&args),
        Some("translate") => run_translate(&args),
        Some("backend-emit") => run_backend_emit(&args),
        _ => {
            eprintln!("usage:");
            eprintln!("  ubtl hash <ir.json>");
            eprintln!(
                "  ubtl translate <artifact.json> --kind evm|wasm|fabric --out <ir.json> [--contract <Name>]"
            );
            eprintln!(
                "  ubtl backend-emit <ir.json> --target evm --out <contract.sol> [--storage-map <map.json>]"
            );
            std::process::exit(2);
        }
    }
}

fn run_hash(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.len() != 3 {
        eprintln!("usage: ubtl hash <ir.json>");
        std::process::exit(2);
    }

    let input = fs::read_to_string(&args[2])?;
    let ir: IR = serde_json::from_str(&input)?;
    println!("{}", ubtl_ir::semantic_hash_hex(&ir));
    Ok(())
}

fn run_translate(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.len() < 6 {
        eprintln!(
            "usage: ubtl translate <artifact.json> --kind evm|wasm|fabric --out <ir.json> [--contract <Name>]"
        );
        std::process::exit(2);
    }

    let input = &args[2];
    let mut kind: Option<&str> = None;
    let mut out: Option<&str> = None;
    let mut contract: Option<&str> = None;

    let mut index = 3usize;
    while index < args.len() {
        match args[index].as_str() {
            "--kind" => {
                kind = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--out" => {
                out = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--contract" => {
                contract = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            other => {
                return Err(format!("unknown argument `{other}`").into());
            }
        }
    }

    let kind = kind.ok_or("missing --kind")?;
    let out = out.ok_or("missing --out")?;

    let ir = match kind {
        "evm" => ubtl_frontend_evm::translate(Path::new(input), contract)?,
        "wasm" => {
            if contract.is_some() {
                return Err("--contract is not supported for --kind wasm".into());
            }
            ubtl_frontend_wasm::translate(Path::new(input))?
        }
        "fabric" => {
            if contract.is_some() {
                return Err("--contract is not supported for --kind fabric".into());
            }
            ubtl_frontend_fabric::translate(Path::new(input))?
        }
        other => {
            return Err(format!("unsupported translate kind `{other}`").into());
        }
    };

    if let Some(parent) = Path::new(out).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(out, serde_json::to_string_pretty(&ir)?)?;
    Ok(())
}

fn run_backend_emit(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.len() < 6 {
        eprintln!(
            "usage: ubtl backend-emit <ir.json> --target evm --out <contract.sol> [--storage-map <map.json>]"
        );
        std::process::exit(2);
    }

    let input = &args[2];
    let mut target: Option<&str> = None;
    let mut out: Option<&str> = None;
    let mut storage_map: Option<&str> = None;

    let mut index = 3usize;
    while index < args.len() {
        match args[index].as_str() {
            "--target" => {
                target = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--out" => {
                out = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--storage-map" => {
                storage_map = args.get(index + 1).map(String::as_str);
                index += 2;
            }
            other => {
                return Err(format!("unknown argument `{other}`").into());
            }
        }
    }

    let target = target.ok_or("missing --target")?;
    let out = out.ok_or("missing --out")?;

    if target != "evm" {
        return Err(format!("unsupported backend target `{target}`").into());
    }

    let input = fs::read_to_string(input)?;
    let ir: IR = serde_json::from_str(&input)?;
    let generated = ubtl_backend_evm::emit(&ir)?;

    if let Some(parent) = Path::new(out).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(out, generated.solidity)?;

    if let Some(storage_map_path) = storage_map {
        if let Some(parent) = Path::new(storage_map_path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(storage_map_path, serde_json::to_string_pretty(&generated.storage_map)?)?;
    }

    Ok(())
}
