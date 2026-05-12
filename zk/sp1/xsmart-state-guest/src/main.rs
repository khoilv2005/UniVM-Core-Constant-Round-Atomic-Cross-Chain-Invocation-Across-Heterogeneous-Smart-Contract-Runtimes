#![no_main]

use alloy_primitives::keccak256;
use alloy_sol_types::{sol, SolValue};
use ed25519_dalek::{Signature as Ed25519Signature, Verifier as _, VerifyingKey as Ed25519VerifyingKey};
use p256::ecdsa::{signature::hazmat::PrehashVerifier as _, Signature as P256Signature, VerifyingKey as P256VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

sp1_zkvm::entrypoint!(main);

sol! {
    struct PublicValues {
        bytes32 domain;
        bytes32 chainId;
        bytes32 contractId;
        bytes32 schemaHash;
        bytes32 opId;
        uint64 lockEpoch;
        uint64 stateVersion;
        bytes32 encodedStateHash;
    }
}

const DOMAIN: [u8; 32] = [
    0xc7, 0x56, 0xe2, 0x98, 0x41, 0x47, 0xa0, 0x5e,
    0x90, 0xb4, 0x1a, 0xda, 0x5c, 0x08, 0x31, 0xd8,
    0x44, 0x4f, 0x76, 0x85, 0x66, 0x10, 0xb5, 0x9b,
    0x38, 0x73, 0xb8, 0x6e, 0x21, 0x24, 0xd6, 0xc6,
];

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
enum Evidence {
    Substrate(SubstrateEvidence),
    Fabric(FabricEvidence),
}

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
struct SubstrateAuthority {
    id: Vec<u8>,
    public_key: [u8; 32],
    weight: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct SubstrateSignature {
    authority_index: u32,
    signature: Vec<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
struct FabricIdentity {
    id: Vec<u8>,
    msp_id_hash: [u8; 32],
    cert_hash: [u8; 32],
    msp_root_hash: [u8; 32],
    public_key_sec1: Vec<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
struct FabricEndorsement {
    identity_index: u32,
    signature_der: Vec<u8>,
}

pub fn main() {
    let input: GuestInput = sp1_zkvm::io::read();
    let encoded_state_hash: [u8; 32] = keccak256(&input.encoded_state).into();

    match &input.evidence {
        Evidence::Substrate(proof) => verify_substrate(proof, &encoded_state_hash),
        Evidence::Fabric(proof) => verify_fabric(proof, &encoded_state_hash),
    }

    let public_values = PublicValues {
        domain: DOMAIN.into(),
        chainId: input.chain_id.into(),
        contractId: input.contract_id.into(),
        schemaHash: input.schema_hash.into(),
        opId: input.op_id.into(),
        lockEpoch: input.lock_epoch,
        stateVersion: input.state_version,
        encodedStateHash: encoded_state_hash.into(),
    };
    sp1_zkvm::io::commit_slice(&public_values.abi_encode());
}

fn verify_substrate(proof: &SubstrateEvidence, encoded_state_hash: &[u8; 32]) {
    assert!(proof.round > 0, "GRANDPA round is zero");
    assert!(proof.finalized_block_number > 0, "finalized block number is zero");
    assert_eq!(&proof.binding_state_hash, encoded_state_hash, "state binding mismatch");
    assert!(!proof.authorities.is_empty(), "empty GRANDPA authority set");
    assert!(!proof.signatures.is_empty(), "empty GRANDPA signature set");

    let mut total_weight = 0u64;
    for authority in &proof.authorities {
        assert!(authority.weight > 0, "zero GRANDPA authority weight");
        total_weight = total_weight.checked_add(authority.weight).expect("authority weight overflow");
    }

    let payload = substrate_payload(proof);
    let mut seen = vec![false; proof.authorities.len()];
    let mut signed_weight = 0u64;
    for vote in &proof.signatures {
        let idx = vote.authority_index as usize;
        assert!(idx < proof.authorities.len(), "unknown GRANDPA authority");
        assert!(!seen[idx], "duplicate GRANDPA signature");
        let authority = &proof.authorities[idx];
        let key = Ed25519VerifyingKey::from_bytes(&authority.public_key).expect("bad GRANDPA public key");
        assert!(vote.signature.len() == 64, "bad GRANDPA signature length");
        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(&vote.signature);
        let sig = Ed25519Signature::from_bytes(&sig_bytes);
        key.verify(&payload, &sig).expect("bad GRANDPA signature");
        signed_weight = signed_weight.checked_add(authority.weight).expect("signed weight overflow");
        seen[idx] = true;
    }
    assert!(signed_weight * 3 > total_weight * 2, "GRANDPA supermajority not met");
}

fn substrate_payload(proof: &SubstrateEvidence) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"XSMART_GRANDPA_PAYLOAD_V1");
    out.extend_from_slice(&proof.set_id.to_be_bytes());
    out.extend_from_slice(&proof.round.to_be_bytes());
    out.extend_from_slice(&proof.finalized_block_number.to_be_bytes());
    out.extend_from_slice(&proof.finalized_block_hash);
    out.extend_from_slice(&proof.state_root);
    out.extend_from_slice(&proof.storage_proof_hash);
    out.extend_from_slice(&proof.binding_state_hash);
    out
}

fn verify_fabric(proof: &FabricEvidence, encoded_state_hash: &[u8; 32]) {
    assert_eq!(&proof.binding_state_hash, encoded_state_hash, "Fabric state binding mismatch");
    assert_eq!(sha256(&proof.proposal_response_payload), proof.proposal_response_payload_hash, "Fabric proposal hash mismatch");
    assert_eq!(sha256(&proof.rw_set), proof.rw_set_hash, "Fabric RW-set hash mismatch");
    assert_eq!(proof.validation_code_hash, sha256(b"VALID"), "Fabric validation code is not VALID");
    assert!(!proof.identities.is_empty(), "empty Fabric identity set");
    assert!(!proof.endorsements.is_empty(), "empty Fabric endorsement set");
    assert!(proof.min_endorsements > 0, "Fabric minimum endorsement is zero");

    let mut seen_identity = vec![false; proof.identities.len()];
    let mut accepted_msp_hashes: Vec<[u8; 32]> = Vec::new();
    for endorsement in &proof.endorsements {
        let idx = endorsement.identity_index as usize;
        assert!(idx < proof.identities.len(), "unknown Fabric endorser");
        assert!(!seen_identity[idx], "duplicate Fabric endorsement");
        let identity = &proof.identities[idx];
        assert!(identity.cert_hash != [0u8; 32], "empty Fabric certificate hash");
        assert!(identity.msp_root_hash != [0u8; 32], "empty Fabric MSP root hash");
        let key = P256VerifyingKey::from_sec1_bytes(&identity.public_key_sec1).expect("bad Fabric P-256 public key");
        let sig = P256Signature::from_der(&endorsement.signature_der).expect("bad Fabric ECDSA signature DER");
        key.verify_prehash(&sha256(&proof.proposal_response_payload), &sig).expect("bad Fabric endorsement signature");
        if !accepted_msp_hashes.contains(&identity.msp_id_hash) {
            accepted_msp_hashes.push(identity.msp_id_hash);
        }
        seen_identity[idx] = true;
    }

    assert!((proof.endorsements.len() as u64) >= proof.min_endorsements, "Fabric endorsement policy minimum not met");
    for required in &proof.required_msp_hashes {
        assert!(accepted_msp_hashes.contains(required), "required Fabric MSP missing");
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}
