import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  PRIVATE_KEYS,
  chainRuntimeConfig,
  ensureDir,
  loadDeployment,
  manifestsDir,
  relayerConfigDir,
  requireContractAddress,
  toPortablePath,
} from "../common";
import {
  resolveHotelSourceContractHash,
  resolveHotelTranslatedIRHashFromSource,
  sourceChainIdForVM,
} from "./translation";

function selectorOf(signature: string): string {
  return ethers.id(signature).slice(0, 10);
}

function encodeTree(
  nodes: Array<{
    contractAddr: string;
    selector: string;
    args: string;
    argChildIdx: bigint[];
    children: bigint[];
  }>,
  rootIndex: bigint,
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    [
      "tuple(address contractAddr, bytes4 selector, bytes args, uint256[] argChildIdx, uint256[] children)[]",
      "uint256",
    ],
    [nodes, rootIndex],
  );
}

function hotelTranslationKey(): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["uint256", "bytes32"],
      [sourceChainIdForVM("fabric"), resolveHotelSourceContractHash()],
    ),
  );
}

async function main() {
  const bc1Deployment = loadDeployment("xsmart", "bc1-1a");
  const bc2Deployment = loadDeployment("xsmart", "bc2-evm");
  const bc3Deployment = loadDeployment("xsmart", "bc3-evm");
  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");
  const benchmarkUser = new ethers.Wallet(
    PRIVATE_KEYS.relayer.startsWith("0x") ? PRIVATE_KEYS.relayer : `0x${PRIVATE_KEYS.relayer}`,
  ).address;

  ensureDir(relayerConfigDir());
  ensureDir(manifestsDir("xsmart"));

  const configPath = path.join(relayerConfigDir(), "config-xsmart-1a.yaml");
  const manifestPath = path.join(
    manifestsDir("xsmart"),
    "travel-evm-1a.generated.json",
  );

  const translated = requireContractAddress(bc1Deployment, "hotelBookingTranslated");
  const bc2Bridge = requireContractAddress(bc2Deployment, "xBridgingContract");
  const bc3Bridge = requireContractAddress(bc3Deployment, "xBridgingContract");
  const bc2Hotel = requireContractAddress(bc2Deployment, "sHotel");
  const bc3Train = requireContractAddress(bc3Deployment, "sTrain");

  const manifest = {
    workflow_id: "xsmart-travel-evm-1a",
    service_id: "travel",
    root_chain: "bc1",
    root_chain_id: 1,
    root_node_index: 0,
    execute_threshold: 2,
    update_ack_threshold: 2,
    call_tree_blob: encodeTree(
      [
        {
          contractAddr: translated,
          selector: selectorOf("GetAvailableRemain()"),
          args: "0x",
          argChildIdx: [],
          children: [],
        },
      ],
      0n,
    ),
    translation_keys: [hotelTranslationKey()],
    peer_ir_hashes: [resolveHotelTranslatedIRHashFromSource()],
    targets: [
      {
        vm: "evm",
        chain: "bc2",
        bridge_contract: bc2Bridge,
        state_contracts: [bc2Hotel],
        lock_num: 1,
        timeout_blocks: 30,
        update: {
          kind: "hotel",
          user: benchmarkUser,
          num: 1,
          total_cost: 100,
        },
      },
      {
        vm: "evm",
        chain: "bc3",
        bridge_contract: bc3Bridge,
        state_contracts: [bc3Train],
        lock_num: 1,
        timeout_blocks: 30,
        update: {
          kind: "train",
          user: benchmarkUser,
          num: 1,
          total_cost: 50,
        },
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const yaml = `title: "XSmart Relayer Configuration (RQ1a EVM)"

protocol: "xsmart"

relayer:
  id: "xsmart-relayer-1a"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.relayer}"

chains:
  bc1:
    name: "${bc1.name}"
    vm: "evm"
    chain_id: ${bc1.chainId}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
  bc2:
    name: "${bc2.name}"
    vm: "evm"
    chain_id: ${bc2.chainId}
    rpc_url: "${bc2.rpcUrl}"
    http_url: "${bc2.httpUrl}"
  bc3:
    name: "${bc3.name}"
    vm: "evm"
    chain_id: ${bc3.chainId}
    rpc_url: "${bc3.rpcUrl}"
    http_url: "${bc3.httpUrl}"

contracts:
  xsmart:
    bc1:
      xbridging_contract: "${requireContractAddress(bc1Deployment, "xBridgingContract")}"
      ubtl_registry: "${requireContractAddress(bc1Deployment, "ubtlRegistry")}"
      relayer_manager: "${requireContractAddress(bc1Deployment, "relayerManager")}"
      light_client: "${requireContractAddress(bc1Deployment, "lightClient")}"
    bc2:
      xbridging_contract: "${bc2Bridge}"
    bc3:
      xbridging_contract: "${bc3Bridge}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 1

relay:
  timeout_seconds: 120
  max_pending: 100

xsmart:
  manifest: "${toPortablePath(manifestPath)}"
  service_id: "travel"
  wasm_lock_num: 1
  wasm_timeout_blocks: 30
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered XSmart 1a relayer config: ${configPath}`);
  console.log(`Rendered XSmart 1a manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
