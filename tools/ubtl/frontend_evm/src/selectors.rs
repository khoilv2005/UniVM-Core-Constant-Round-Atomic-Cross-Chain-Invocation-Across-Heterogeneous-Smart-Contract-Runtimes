use tiny_keccak::{Hasher, Keccak};

pub fn selector4(signature: &str) -> [u8; 4] {
    let mut hasher = Keccak::v256();
    hasher.update(signature.as_bytes());

    let mut output = [0u8; 32];
    hasher.finalize(&mut output);

    [output[0], output[1], output[2], output[3]]
}

pub fn selector4_hex(selector: [u8; 4]) -> String {
    format!(
        "0x{:02x}{:02x}{:02x}{:02x}",
        selector[0], selector[1], selector[2], selector[3]
    )
}
