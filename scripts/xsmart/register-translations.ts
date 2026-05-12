import * as fs from "fs";
import * as path from "path";

import { ethers } from "hardhat";

import {
  banner,
  loadDeployment,
  networkName,
  readContract,
  repoRoot,
  requireContractAddress,
  sendContract,
  summary,
  writeDeployment,
  type DeploymentRecord,
} from "../common";
import {
  resolveHotelSourceContractHash,
  resolveHotelStorageMapRoot,
  sourceChainIdForVM,
  ZERO_HASH,
} from "./translation";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function translatedField(value: any): string {
  if (!value) return ZERO_ADDRESS;
  if (typeof value.translated === "string") return value.translated;
  if (typeof value[3] === "string") return value[3];
  if (typeof value["3"] === "string") return value["3"];
  return ZERO_ADDRESS;
}

async function registerHotelTranslation(rec: DeploymentRecord): Promise<void> {
  const registry = requireContractAddress(rec, "ubtlRegistry");
  const translated = requireContractAddress(rec, "hotelBookingTranslated");
  const sourceChainId = sourceChainIdForVM("fabric");
  const sourceContractHash = resolveHotelSourceContractHash();
  const irHash = String(await readContract("HotelBookingTranslated", translated, "ir_hash", []));
  const storageMapRoot = resolveHotelStorageMapRoot();
  const key = String(await readContract("UBTLRegistry", registry, "keyFor", [sourceChainId, sourceContractHash]));

  const existing = await readContract("UBTLRegistry", registry, "translations", [key]);
  const existingTranslated = translatedField(existing);
  if (existingTranslated.toLowerCase() !== ZERO_ADDRESS) {
    if (existingTranslated.toLowerCase() !== translated.toLowerCase()) {
      throw new Error(
        `translation key ${key} already bound to ${existingTranslated}, expected ${translated}`
      );
    }
    console.log(`  [skip]   translation already registered ${key} -> ${translated}`);
    return;
  }

  console.log(`  [init]   register translation key=${key}`);
  console.log(`           sourceChainId=${sourceChainId}`);
  console.log(`           sourceContractHash=${sourceContractHash}`);
  console.log(`           irHash=${irHash}`);
  console.log(`           storageMapRoot=${storageMapRoot}`);

  await sendContract("UBTLRegistry", registry, "register", [
    sourceChainId,
    sourceContractHash,
    irHash,
    translated,
    storageMapRoot,
  ]);

  const stored = await readContract("UBTLRegistry", registry, "translations", [key]);
  if (translatedField(stored).toLowerCase() !== translated.toLowerCase()) {
    throw new Error(`translation registration verification failed for key ${key}`);
  }
}

export async function registerTranslations(rec?: DeploymentRecord): Promise<DeploymentRecord> {
  const net = networkName();
  const deployment = rec ?? loadDeployment("xsmart", net);
  await registerHotelTranslation(deployment);
  writeDeployment(deployment);
  return deployment;
}

async function main() {
  const net = networkName();
  banner("xsmart", net);
  const rec = loadDeployment("xsmart", net);
  await registerTranslations(rec);
  summary(rec);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
