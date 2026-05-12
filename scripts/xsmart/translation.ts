import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { repoRoot } from "../common";

export const ZERO_HASH = "0x" + "00".repeat(32);

type HotelIrArtifact = {
  meta?: {
    source_hash?: number[];
  };
};

type StorageMapArtifact = {
  contract: string;
  slots: Array<{
    ir_id: string;
    evm_slot: number;
    offset?: number | null;
    ty: string;
  }>;
};

export function ubtlOutDir(): string {
  return path.join(repoRoot(), "tools", "ubtl", "out");
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function bytes32FromByteArray(values: number[]): string {
  if (values.length !== 32) {
    throw new Error(`expected 32-byte array, got ${values.length}`);
  }
  return ethers.hexlify(Uint8Array.from(values));
}

export function computeStorageMapRoot(storageMap: StorageMapArtifact): string {
  const canonical = {
    contract: String(storageMap.contract),
    slots: [...storageMap.slots]
      .map((slot) => ({
        ir_id: String(slot.ir_id),
        evm_slot: Number(slot.evm_slot),
        offset: slot.offset == null ? null : Number(slot.offset),
        ty: String(slot.ty),
      }))
      .sort((a, b) => {
        const byId = a.ir_id.localeCompare(b.ir_id);
        if (byId !== 0) return byId;
        return a.evm_slot - b.evm_slot;
      }),
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(canonical)));
}

export function sha256Bytes32(value: Uint8Array): string {
  return "0x" + crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256Bytes32(fs.readFileSync(filePath));
}

export function sha256Files(filePaths: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of [...filePaths].sort()) {
    hash.update(path.basename(filePath));
    hash.update("\n");
    hash.update(fs.readFileSync(filePath));
    hash.update("\n");
  }
  return "0x" + hash.digest("hex");
}

export function normalizeEvmAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}

export function normalizeWasmAccount(value: string): string {
  return String(value).trim();
}

export function normalizeFabricIdentifier(value: string): string {
  const trimmed = String(value).trim();
  const known: Record<string, string> = {
    "xbridge_bc3": "XBridgeBc3",
    "hotel_booking": "HotelBooking",
  };
  const lower = trimmed.toLowerCase();
  return known[lower] || trimmed;
}

export function normalizeEndpointForVM(vm: "evm" | "wasm" | "fabric", value: string): string {
  switch (vm) {
    case "evm":
      return normalizeEvmAddress(value);
    case "wasm":
      return normalizeWasmAccount(value);
    case "fabric":
      return normalizeFabricIdentifier(value);
    default:
      return String(value).trim();
  }
}

export function sourceChainIdForVM(vm: "evm" | "wasm" | "fabric"): number {
  switch (vm) {
    case "evm":
      return Number(process.env.XSMART_EVM_SOURCE_CHAIN_ID || "1");
    case "wasm":
      return Number(process.env.XSMART_WASM_SOURCE_CHAIN_ID || process.env.BC2_WASM_CHAIN_ID || "1338");
    case "fabric":
      return Number(process.env.XSMART_FABRIC_SOURCE_CHAIN_ID || process.env.BC3_FABRIC_CHAIN_ID || "3");
    default:
      return 0;
  }
}

export function resolveHotelSourceContractHash(): string {
  const explicit = process.env.XSMART_BC3_SOURCE_HASH?.trim();
  if (explicit) {
    return explicit;
  }

  const irPath = path.join(ubtlOutDir(), "hotel.ir.json");
  if (fs.existsSync(irPath)) {
    const irArtifact = readJsonFile<HotelIrArtifact>(irPath);
    const sourceHash = irArtifact.meta?.source_hash;
    if (sourceHash && sourceHash.length === 32) {
      return bytes32FromByteArray(sourceHash);
    }
  }

  const packagePath = process.env.XSMART_BC3_PACKAGE_PATH?.trim();
  if (packagePath && fs.existsSync(packagePath)) {
    return sha256File(packagePath);
  }

  const bc3Dir = path.join(repoRoot(), "contracts", "xsmart", "bc3");
  const sources = [
    path.join(bc3Dir, "hotel_booking.go"),
    path.join(bc3Dir, "xbridge_bc3.go"),
    path.join(bc3Dir, "vassp.go"),
  ].filter((file) => fs.existsSync(file));
  if (sources.length === 0) {
    throw new Error("unable to derive hotel source contract hash");
  }
  return sha256Files(sources);
}

export function resolveHotelStorageMapRoot(): string {
  const explicit = process.env.XSMART_STORAGE_MAP_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  const storageMapPath = path.join(ubtlOutDir(), "HotelBookingTranslated.storage_map.json");
  if (!fs.existsSync(storageMapPath)) {
    return ZERO_HASH;
  }
  const storageMap = readJsonFile<StorageMapArtifact>(storageMapPath);
  return computeStorageMapRoot(storageMap);
}

export function resolveHotelTranslatedIRHashFromSource(): string {
  const sourcePath = path.join(
    repoRoot(),
    "contracts",
    "xsmart",
    "bc1",
    "examples",
    "HotelBookingTranslated.sol"
  );
  const source = fs.readFileSync(sourcePath, "utf-8");
  const match = source.match(
    /UBTL_IR_HASH\s*=\s*bytes32\((0x[0-9a-fA-F]{64})\)/
  );
  if (!match) {
    throw new Error(`Unable to locate UBTL_IR_HASH in ${sourcePath}`);
  }
  return match[1];
}

