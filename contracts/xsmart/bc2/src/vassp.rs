use ink::env::hash::{HashOutput, Keccak256};
use ink::prelude::vec;
use ink::prelude::vec::Vec;

pub type SlotId = [u8; 32];
pub type Pair = (SlotId, Vec<u8>);

pub fn slot_id_for(contract_name: &str, slot_name: &str, keys: &[Vec<u8>]) -> SlotId {
    let mut packed = Vec::new();
    packed.extend_from_slice(b"VASSP");
    packed.extend_from_slice(contract_name.as_bytes());
    packed.extend_from_slice(slot_name.as_bytes());
    for key in keys {
        packed.extend_from_slice(key);
    }

    let mut out = <Keccak256 as HashOutput>::Type::default();
    ink::env::hash_bytes::<Keccak256>(&packed, &mut out);
    out
}

pub fn encode_uint256_u128(value: u128) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

pub fn encode_uint256_u64(value: u64) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

pub fn encode(pairs: &[Pair]) -> Vec<u8> {
    let mut encoded_pairs = Vec::with_capacity(pairs.len());
    for (slot_id, abi_value) in pairs {
        let pair_items = vec![
            encode_bytes(slot_id.as_slice()),
            encode_bytes(abi_value.as_slice()),
        ];
        encoded_pairs.push(encode_list(&pair_items));
    }
    encode_list(&encoded_pairs)
}

fn encode_bytes(value: &[u8]) -> Vec<u8> {
    if value.len() == 1 && value[0] < 0x80 {
        return value.to_vec();
    }
    if value.len() <= 55 {
        let capacity = 1usize.saturating_add(value.len());
        let prefix_len = u8::try_from(value.len()).expect("short RLP byte string length fits in u8");
        let prefix = 0x80u8.checked_add(prefix_len).expect("short RLP byte string prefix fits in u8");
        let mut out = Vec::with_capacity(capacity);
        out.push(prefix);
        out.extend_from_slice(value);
        return out;
    }

    let len_bytes = encode_length(value.len());
    let capacity = 1usize
        .saturating_add(len_bytes.len())
        .saturating_add(value.len());
    let len_of_len = u8::try_from(len_bytes.len()).expect("RLP length-of-length fits in u8");
    let prefix = 0xb7u8.checked_add(len_of_len).expect("long RLP byte string prefix fits in u8");
    let mut out = Vec::with_capacity(capacity);
    out.push(prefix);
    out.extend_from_slice(&len_bytes);
    out.extend_from_slice(value);
    out
}

fn encode_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload_len: usize = items.iter().map(Vec::len).sum();
    let mut payload = Vec::with_capacity(payload_len);
    for item in items {
        payload.extend_from_slice(item);
    }

    if payload.len() <= 55 {
        let capacity = 1usize.saturating_add(payload.len());
        let prefix_len = u8::try_from(payload.len()).expect("short RLP list length fits in u8");
        let prefix = 0xc0u8.checked_add(prefix_len).expect("short RLP list prefix fits in u8");
        let mut out = Vec::with_capacity(capacity);
        out.push(prefix);
        out.extend_from_slice(&payload);
        return out;
    }

    let len_bytes = encode_length(payload.len());
    let capacity = 1usize
        .saturating_add(len_bytes.len())
        .saturating_add(payload.len());
    let len_of_len = u8::try_from(len_bytes.len()).expect("RLP list length-of-length fits in u8");
    let prefix = 0xf7u8.checked_add(len_of_len).expect("long RLP list prefix fits in u8");
    let mut out = Vec::with_capacity(capacity);
    out.push(prefix);
    out.extend_from_slice(&len_bytes);
    out.extend_from_slice(&payload);
    out
}

fn encode_length(value: usize) -> Vec<u8> {
    if value == 0 {
        return vec![0];
    }

    let bytes = value.to_be_bytes();
    let first_non_zero = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len().saturating_sub(1));
    bytes[first_non_zero..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_hex(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn slot_id_is_deterministic() {
        let keys = vec![vec![0x12, 0x34], vec![0xab, 0xcd]];
        let slot = slot_id_for("TrainBooking", "locks", &keys);
        assert_eq!(
            as_hex(slot),
            "e845427a65db66ee163d980ea10ebd7c57f07952776739c2c26af09c33258ba1"
        );
    }

    #[test]
    fn uint256_words_are_left_padded() {
        assert_eq!(
            as_hex(encode_uint256_u64(0x1234)),
            "0000000000000000000000000000000000000000000000000000000000001234"
        );
        assert_eq!(
            as_hex(encode_uint256_u128(10)),
            "000000000000000000000000000000000000000000000000000000000000000a"
        );
    }

    #[test]
    fn encode_single_pair_matches_expected_shape() {
        let slot = [0x11u8; 32];
        let encoded = encode(&[(slot, vec![0x12, 0x34])]);
        assert_eq!(
            as_hex(encoded),
            "e5e4a01111111111111111111111111111111111111111111111111111111111111111821234"
        );
    }
}
