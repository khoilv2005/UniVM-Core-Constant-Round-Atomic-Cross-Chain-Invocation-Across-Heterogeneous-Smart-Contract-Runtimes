import { ethers } from "ethers";

export type SnapshotScalar = string | number | bigint | boolean;

export type SnapshotValue =
  | { type: "uint256"; value: SnapshotScalar }
  | { type: "bool"; value: SnapshotScalar }
  | { type: "string"; value: SnapshotScalar }
  | { type: "bytes"; value: string };

export type SnapshotEntry = {
  key: string;
  value: SnapshotValue;
};

export type SnapshotResult = {
  bytesHex: string;
  hash: string;
};

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function hexToBytes(hex: string): number[] {
  const clean = strip0x(hex);
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex length for ${hex}`);
  }
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function u32be(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32 out of range: ${value}`);
  }
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function utf8Bytes(value: string): number[] {
  return Array.from(Buffer.from(value.normalize("NFC"), "utf8"));
}

function lengthPrefixed(bytes: number[]): number[] {
  return [...u32be(bytes.length), ...bytes];
}

function uint256Bytes(value: SnapshotScalar): number[] {
  const n = BigInt(value);
  if (n < 0n || n >= (1n << 256n)) {
    throw new Error(`uint256 out of range: ${value.toString()}`);
  }
  return hexToBytes(ethers.toBeHex(n, 32));
}

function encodeValue(value: SnapshotValue): number[] {
  switch (value.type) {
    case "uint256":
      return [0x01, ...uint256Bytes(value.value)];
    case "bool":
      return [0x02, value.value === true || value.value === "true" || value.value === 1 ? 1 : 0];
    case "string":
      return [0x03, ...lengthPrefixed(utf8Bytes(String(value.value)))];
    case "bytes":
      return [0x04, ...lengthPrefixed(hexToBytes(value.value))];
    default: {
      const unreachable: never = value;
      throw new Error(`unknown snapshot type ${(unreachable as SnapshotValue).type}`);
    }
  }
}

export function canonicalSnapshot(contract: string, entries: SnapshotEntry[]): SnapshotResult {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const bytes: number[] = [];
  bytes.push(...utf8Bytes("UBTL-SNAPSHOT-V1"));
  bytes.push(...lengthPrefixed(utf8Bytes(contract)));

  for (const entry of sorted) {
    bytes.push(...lengthPrefixed(utf8Bytes(entry.key)));
    bytes.push(...encodeValue(entry.value));
  }

  const bytesHex = ethers.hexlify(Uint8Array.from(bytes));
  return {
    bytesHex,
    hash: ethers.keccak256(bytesHex),
  };
}

