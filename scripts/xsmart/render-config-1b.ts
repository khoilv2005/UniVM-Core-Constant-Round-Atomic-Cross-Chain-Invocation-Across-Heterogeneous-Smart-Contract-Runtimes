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

function callTreeForDepth(depth: number, translated: string) {
  const nodeCount = Math.max(1, depth - 1);
  return Array.from({ length: nodeCount }, (_, index) => ({
    contractAddr: translated,
    selector: selectorOf("GetAvailableRemain()"),
    args: "0x",
    argChildIdx: [],
    children: index === 0 ? [] : [BigInt(index - 1)],
  }));
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

function targetsForDepth(depth: number, bc2Deployment: ReturnType<typeof loadDeployment>, bc3Deployment: ReturnType<typeof loadDeployment>, benchmarkUser: string) {
  const targets: any[] = [];
  if (depth >= 2) {
    targets.push({
      vm: "evm",
      chain: "bc2",
      bridge_contract: requireContractAddress(bc2Deployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc2Deployment, "sHotel")],
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        kind: "hotel",
        user: benchmarkUser,
        num: 1,
        total_cost: 100,
      },
    });
  }
  if (depth >= 3) {
    targets.push({
      vm: "evm",
      chain: "bc3",
      bridge_contract: requireContractAddress(bc3Deployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc3Deployment, "sTrain")],
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        kind: "train",
        user: benchmarkUser,
        num: 1,
        total_cost: 50,
      },
    });
  }
  if (depth >= 4) {
    targets.push({
      vm: "evm",
      chain: "bc2",
      bridge_contract: requireContractAddress(bc2Deployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc2Deployment, "sFlight")],
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        kind: "flight",
        user: benchmarkUser,
        num: 1,
        total_cost: 200,
      },
    });
  }
  if (depth >= 5) {
    targets.push({
      vm: "evm",
      chain: "bc3",
      bridge_contract: requireContractAddress(bc3Deployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc3Deployment, "sTaxi")],
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        kind: "taxi",
        user: benchmarkUser,
        num: 1,
        total_cost: 20,
      },
    });
  }
  return targets;
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

  const translated = requireContractAddress(bc1Deployment, "hotelBookingTranslated");
  for (const depth of [2, 3, 4, 5]) {
    const configPath = path.join(relayerConfigDir(), `config-xsmart-1b-d${depth}.yaml`);
    const manifestPath = path.join(manifestsDir("xsmart"), `travel-evm-1b-d${depth}.generated.json`);
    const targets = targetsForDepth(depth, bc2Deployment, bc3Deployment, benchmarkUser);
    const callTreeNodes = callTreeForDepth(depth, translated);
    const manifest = {
      workflow_id: `xsmart-travel-evm-1b-d${depth}`,
      service_id: "travel",
      root_chain: "bc1",
      root_chain_id: 1,
      depth_axis: "call-tree-edge-depth-plus-service-targets",
      call_tree_node_count: callTreeNodes.length,
      root_node_index: callTreeNodes.length - 1,
      execute_threshold: targets.length,
      update_ack_threshold: targets.length,
      call_tree_blob: encodeTree(callTreeNodes, BigInt(callTreeNodes.length - 1)),
      translation_keys: [hotelTranslationKey()],
      peer_ir_hashes: [resolveHotelTranslatedIRHashFromSource()],
      targets,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const yaml = `title: "XSmart Relayer Configuration (RQ1b depth ${depth})"

protocol: "xsmart"

relayer:
  id: "xsmart-relayer-1b-d${depth}"
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
      xbridging_contract: "${requireContractAddress(bc2Deployment, "xBridgingContract")}"
    bc3:
      xbridging_contract: "${requireContractAddress(bc3Deployment, "xBridgingContract")}"

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
    console.log(`Rendered XSmart 1b manifest: ${manifestPath}`);
    console.log(`Rendered XSmart 1b config: ${configPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
