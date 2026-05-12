use alloy_primitives::{keccak256, FixedBytes};
use alloy_sol_types::SolValue;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sp1_sdk::blocking::{utils, Elf, ProveRequest, Prover, ProverClient, SP1Stdin};
use sp1_sdk::HashableKey;
use sp1_sdk::ProvingKey;
use std::{env, fs, path::PathBuf, time::Instant};

#[derive(Debug, Deserialize, Serialize, Clone)]
struct StateImportWitness {
    chain_id: String,
    contract_id: String,
    schema_hash: String,
    op_id: String,
    lock_epoch: u64,
    state_version: u64,
    encoded_state: String,
    evidence: WireEvidence,
}

#[derive(Debug, Serialize)]
struct ProverOutput {
    backend: String,
    proof_mode: String,
    program_vkey: String,
    public_values: String,
    proof: String,
    adapter_proof: String,
    encoded_state_hash: String,
    prove_ms: u128,
}

#[derive(Debug, Serialize)]
struct GuestInput {
    chain_id: [u8; 32],
    contract_id: [u8; 32],
    schema_hash: [u8; 32],
    op_id: [u8; 32],
    lock_epoch: u64,
    state_version: u64,
    encoded_state: Vec<u8>,
    evidence: Evidence,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireEvidence {
    Substrate {
        set_id: u64,
        round: u64,
        finalized_block_number: u64,
        finalized_block_hash: String,
        state_root: String,
        storage_proof_hash: String,
        authorities: Vec<WireSubstrateAuthority>,
        signatures: Vec<WireSubstrateSignature>,
        binding_state_hash: String,
    },
    Fabric {
        channel_id_hash: String,
        chaincode_name_hash: String,
        chaincode_version_hash: String,
        namespace_hash: String,
        tx_id_hash: String,
        block_hash: String,
        validation_code_hash: String,
        proposal_response_payload: String,
        proposal_response_payload_hash: String,
        rw_set: String,
        rw_set_hash: String,
        identities: Vec<WireFabricIdentity>,
        endorsements: Vec<WireFabricEndorsement>,
        required_msp_hashes: Vec<String>,
        min_endorsements: u64,
        binding_state_hash: String,
    },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WireSubstrateAuthority {
    id: String,
    public_key: String,
    weight: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WireSubstrateSignature {
    authority_index: u32,
    signature: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WireFabricIdentity {
    id: String,
    msp_id_hash: String,
    cert_hash: String,
    msp_root_hash: String,
    public_key_sec1: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WireFabricEndorsement {
    identity_index: u32,
    signature_der: String,
}

#[derive(Debug, Serialize)]
enum Evidence {
    Substrate(SubstrateEvidence),
    Fabric(FabricEvidence),
}

#[derive(Debug, Serialize)]
struct SubstrateEvidence {
    set_id: u64,
    round: u64,
    finalized_block_number: u64,
    finalized_block_hash: [u8; 32],
    state_root: [u8; 32],
    storage_proof_hash: [u8; 32],
    authorities: Vec<SubstrateAuthority>,
    signatures: Vec<SubstrateSignature>,
    binding_state_hash: [u8; 32],
}

#[derive(Debug, Serialize)]
struct SubstrateAuthority {
    id: Vec<u8>,
    public_key: [u8; 32],
    weight: u64,
}

#[derive(Debug, Serialize)]
struct SubstrateSignature {
    authority_index: u32,
    signature: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct FabricEvidence {
    channel_id_hash: [u8; 32],
    chaincode_name_hash: [u8; 32],
    chaincode_version_hash: [u8; 32],
    namespace_hash: [u8; 32],
    tx_id_hash: [u8; 32],
    block_hash: [u8; 32],
    validation_code_hash: [u8; 32],
    proposal_response_payload: Vec<u8>,
    proposal_response_payload_hash: [u8; 32],
    rw_set: Vec<u8>,
    rw_set_hash: [u8; 32],
    identities: Vec<FabricIdentity>,
    endorsements: Vec<FabricEndorsement>,
    required_msp_hashes: Vec<[u8; 32]>,
    min_endorsements: u64,
    binding_state_hash: [u8; 32],
}

#[derive(Debug, Serialize)]
struct FabricIdentity {
    id: Vec<u8>,
    msp_id_hash: [u8; 32],
    cert_hash: [u8; 32],
    msp_root_hash: [u8; 32],
    public_key_sec1: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct FabricEndorsement {
    identity_index: u32,
    signature_der: Vec<u8>,
}

fn main() -> Result<()> {
    utils::setup_logger();

    let witness_path = arg_or_env(1, "XSMART_STATE_IMPORT_WITNESS")?;
    let elf_path = env::var("XSMART_SP1_ELF")
        .map(PathBuf::from)
        .context("XSMART_SP1_ELF must point to the compiled SP1 guest ELF")?;
    let out_path = env::var("XSMART_SP1_PROOF_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("sp1-state-import-proof.json"));
    let proof_mode = env::var("XSMART_SP1_PROOF_MODE")
        .unwrap_or_else(|_| "plonk".to_string())
        .to_lowercase();

    let witness: StateImportWitness = serde_json::from_slice(
        &fs::read(&witness_path).with_context(|| format!("read witness {}", witness_path))?,
    )?;
    let input = GuestInput {
        chain_id: hex32(&witness.chain_id)?,
        contract_id: hex32(&witness.contract_id)?,
        schema_hash: hex32(&witness.schema_hash)?,
        op_id: hex32(&witness.op_id)?,
        lock_epoch: witness.lock_epoch,
        state_version: witness.state_version,
        encoded_state: hex_bytes(&witness.encoded_state)?,
        evidence: convert_evidence(witness.evidence)?,
    };

    let elf = Elf::from(fs::read(&elf_path).with_context(|| format!("read ELF {}", elf_path.display()))?);
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(elf).context("SP1 setup")?;
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let start = Instant::now();
    let proof = match proof_mode.as_str() {
        "groth16" => client.prove(&pk, stdin).groth16().run()?,
        "plonk" => client.prove(&pk, stdin).plonk().run()?,
        other => return Err(anyhow!("unsupported XSMART_SP1_PROOF_MODE {other}; use plonk or groth16")),
    };
    let prove_ms = start.elapsed().as_millis();
    client.verify(&proof, pk.verifying_key(), None).context("SP1 local verification")?;

    let public_values = proof.public_values.to_vec();
    let proof_bytes = proof.bytes();
    let adapter_proof = (public_values.clone(), proof_bytes.clone()).abi_encode();
    let encoded_state_hash: FixedBytes<32> = keccak256(&input.encoded_state);

    let out = ProverOutput {
        backend: "sp1".to_string(),
        proof_mode,
        program_vkey: pk.verifying_key().bytes32(),
        public_values: hex0x(&public_values),
        proof: hex0x(&proof_bytes),
        adapter_proof: hex0x(&adapter_proof),
        encoded_state_hash: hex0x(encoded_state_hash.as_slice()),
        prove_ms,
    };

    fs::write(&out_path, serde_json::to_vec_pretty(&out)?)?;
    println!("{}", serde_json::to_string_pretty(&out)?);
    eprintln!("wrote {}", out_path.display());
    Ok(())
}

fn arg_or_env(index: usize, name: &str) -> Result<String> {
    env::args()
        .nth(index)
        .or_else(|| env::var(name).ok())
        .ok_or_else(|| anyhow!("missing argument {index} or {name}"))
}

fn hex32(value: &str) -> Result<[u8; 32]> {
    let bytes = hex_bytes(value)?;
    if bytes.len() != 32 {
        return Err(anyhow!("expected bytes32, got {} bytes for {value}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn hex_bytes(value: &str) -> Result<Vec<u8>> {
    let trimmed = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    Ok(hex::decode(trimmed)?)
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn convert_evidence(evidence: WireEvidence) -> Result<Evidence> {
    Ok(match evidence {
        WireEvidence::Substrate {
            set_id,
            round,
            finalized_block_number,
            finalized_block_hash,
            state_root,
            storage_proof_hash,
            authorities,
            signatures,
            binding_state_hash,
        } => Evidence::Substrate(SubstrateEvidence {
            set_id,
            round,
            finalized_block_number,
            finalized_block_hash: hex32(&finalized_block_hash)?,
            state_root: hex32(&state_root)?,
            storage_proof_hash: hex32(&storage_proof_hash)?,
            authorities: authorities.into_iter().map(|a| {
                Ok(SubstrateAuthority {
                    id: a.id.into_bytes(),
                    public_key: hex32(&a.public_key)?,
                    weight: a.weight,
                })
            }).collect::<Result<Vec<_>>>()?,
            signatures: signatures.into_iter().map(|s| {
                Ok(SubstrateSignature {
                    authority_index: s.authority_index,
                    signature: hex_bytes(&s.signature)?,
                })
            }).collect::<Result<Vec<_>>>()?,
            binding_state_hash: hex32(&binding_state_hash)?,
        }),
        WireEvidence::Fabric {
            channel_id_hash,
            chaincode_name_hash,
            chaincode_version_hash,
            namespace_hash,
            tx_id_hash,
            block_hash,
            validation_code_hash,
            proposal_response_payload,
            proposal_response_payload_hash,
            rw_set,
            rw_set_hash,
            identities,
            endorsements,
            required_msp_hashes,
            min_endorsements,
            binding_state_hash,
        } => Evidence::Fabric(FabricEvidence {
            channel_id_hash: hex32(&channel_id_hash)?,
            chaincode_name_hash: hex32(&chaincode_name_hash)?,
            chaincode_version_hash: hex32(&chaincode_version_hash)?,
            namespace_hash: hex32(&namespace_hash)?,
            tx_id_hash: hex32(&tx_id_hash)?,
            block_hash: hex32(&block_hash)?,
            validation_code_hash: hex32(&validation_code_hash)?,
            proposal_response_payload: hex_bytes(&proposal_response_payload)?,
            proposal_response_payload_hash: hex32(&proposal_response_payload_hash)?,
            rw_set: hex_bytes(&rw_set)?,
            rw_set_hash: hex32(&rw_set_hash)?,
            identities: identities.into_iter().map(|i| {
                Ok(FabricIdentity {
                    id: i.id.into_bytes(),
                    msp_id_hash: hex32(&i.msp_id_hash)?,
                    cert_hash: hex32(&i.cert_hash)?,
                    msp_root_hash: hex32(&i.msp_root_hash)?,
                    public_key_sec1: hex_bytes(&i.public_key_sec1)?,
                })
            }).collect::<Result<Vec<_>>>()?,
            endorsements: endorsements.into_iter().map(|e| {
                Ok(FabricEndorsement {
                    identity_index: e.identity_index,
                    signature_der: hex_bytes(&e.signature_der)?,
                })
            }).collect::<Result<Vec<_>>>()?,
            required_msp_hashes: required_msp_hashes.iter().map(|v| hex32(v)).collect::<Result<Vec<_>>>()?,
            min_endorsements,
            binding_state_hash: hex32(&binding_state_hash)?,
        }),
    })
}
