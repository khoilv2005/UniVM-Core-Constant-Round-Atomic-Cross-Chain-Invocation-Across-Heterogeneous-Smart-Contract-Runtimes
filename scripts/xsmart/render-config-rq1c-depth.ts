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
} from "../common";
import {
  normalizeEndpointForVM,
  resolveHotelSourceContractHash,
  resolveHotelTranslatedIRHashFromSource,
  sourceChainIdForVM,
} from "./translation";

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
  if (envValue && envValue.trim() !== "") return envValue;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return defaultValue;
}

function toPortable(value: string): string {
  return value.split(path.sep).join("/");
}

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
  return ethers.AbiCoder.defaultAbiCoder().encode(
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
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32"],
      [sourceChainIdForVM("fabric"), resolveHotelSourceContractHash()],
    ),
  );
}

async function main() {
  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`RQ1c heterogeneous depth renderer supports d=2..5, got ${depth}`);
  }

  const bc1Deployment = loadDeployment("xsmart", "bc1");
  const bc2Deployment = loadDeployment("xsmart", "bc2");
  const bc3Deployment = loadDeployment("xsmart", "bc3");
  const bc2EvmDeployment = loadDeployment("xsmart", "bc2-evm");
  const bc3EvmDeployment = loadDeployment("xsmart", "bc3-evm");
  const bc1 = chainRuntimeConfig("bc1");
  const bc2Evm = chainRuntimeConfig("bc2");
  const bc3Evm = chainRuntimeConfig("bc3");
  const benchmarkUser = new ethers.Wallet(
    PRIVATE_KEYS.relayer.startsWith("0x") ? PRIVATE_KEYS.relayer : `0x${PRIVATE_KEYS.relayer}`,
  ).address;

  ensureDir(relayerConfigDir());
  ensureDir(manifestsDir("xsmart"));

  const configPath = path.join(relayerConfigDir(), `config-xsmart-rq1c-d${depth}.yaml`);
  const manifestPath = path.join(manifestsDir("xsmart"), `travel-hetero-d${depth}.generated.json`);
  const translated = requireContractAddress(bc1Deployment, "hotelBookingTranslated");
  const callTreeNodes = callTreeForDepth(depth, translated);

  const bc2WasmHttp =
    process.env.BC2_WASM_HTTP_URL ||
    bc2Deployment.contracts["bc2RpcHttp"] ||
    "http://170.64.194.4:18545";
  const bc2WasmWs =
    process.env.BC2_WASM_WS_URL ||
    bc2Deployment.contracts["bc2RpcWs"] ||
    "ws://170.64.194.4:18545";
  const bc2MetadataPath =
    process.env.XSMART_BC2_METADATA_PATH ||
    bc2Deployment.contracts["bc2BridgeMetadataPath"] ||
    toPortable(path.join(process.cwd(), "contracts", "xsmart", "bc2", "bridge", "target", "ink", "xbridge_bc2.contract"));
  const bc2AccountEndpoint =
    process.env.XSMART_BC2_ACCOUNT_ENDPOINT ||
    bc2Deployment.contracts["xBridgeBc2"] ||
    "";
  const bc2SubmitterURI =
    process.env.XSMART_BC2_SURI ||
    bc2Deployment.contracts["bc2SubmitterURI"] ||
    "//Alice";

  const bc3FabricGatewayEndpoint =
    process.env.XSMART_FORCE_LOCAL_BC3_SIMULATOR === "1"
      ? ""
      : process.env.BC3_FABRIC_GATEWAY_ENDPOINT ||
        bc3Deployment.contracts["bc3FabricGatewayEndpoint"] ||
        "";
  const bc3FabricChannel =
    process.env.BC3_FABRIC_CHANNEL ||
    bc3Deployment.contracts["bc3FabricChannel"] ||
    "";
  const bc3FabricChaincode =
    process.env.BC3_FABRIC_CHAINCODE ||
    bc3Deployment.contracts["bc3FabricChaincode"] ||
    "";
  const bc3FabricMSPID =
    process.env.BC3_FABRIC_MSP_ID ||
    bc3Deployment.contracts["bc3FabricMSPID"] ||
    "";
  const bc3FabricUserCertPath =
    process.env.BC3_FABRIC_USER_CERT_PATH ||
    bc3Deployment.contracts["bc3FabricUserCertPath"] ||
    "";
  const bc3FabricUserKeyPath =
    process.env.BC3_FABRIC_USER_KEY_PATH ||
    bc3Deployment.contracts["bc3FabricUserKeyPath"] ||
    "";
  const bc3FabricTLSCertPath =
    process.env.BC3_FABRIC_TLS_CERT_PATH ||
    bc3Deployment.contracts["bc3FabricTLSCertPath"] ||
    "";
  const bc3FabricPeerName =
    process.env.BC3_FABRIC_PEER_NAME ||
    bc3Deployment.contracts["bc3FabricPeerName"] ||
    "";
  const bc3AccountEndpoint =
    process.env.XSMART_BC3_ACCOUNT_ENDPOINT ||
    bc3Deployment.contracts["xBridgeBc3"] ||
    "";
  const proofMode = (
    process.env.XSMART_RQ1C_PROOF_MODE ||
    process.env.XSMART_PROOF_MODE ||
    "production_proof"
  ).trim().toLowerCase().replace(/-/g, "_");
  const requireNonEVMProofs = proofMode !== "trusted_normalized" && proofMode !== "trusted";

  const targets: any[] = [
    {
      vm: "wasm",
      chain: "bc2",
      contract: "xbridge_bc2",
      endpoint: normalizeEndpointForVM("wasm", bc2AccountEndpoint),
      state_contract: bc2Deployment.contracts["trainBooking"] || "",
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        user: process.env.XSMART_BC2_USER || "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        num: 1,
        total_cost: 50,
      },
    },
    {
      vm: "fabric",
      chain: "bc3",
      contract: "xbridge_bc3",
      endpoint: normalizeEndpointForVM("fabric", bc3AccountEndpoint),
      state_contract: bc3Deployment.contracts["hotelBooking"] || "HotelBooking",
      lock_num: 1,
      timeout_blocks: 30,
      update: {
        user: "fabric-user",
        num: 1,
        total_cost: 100,
      },
    },
  ];

  if (depth >= 3) {
    targets.push({
      vm: "evm",
      chain: "bc2evm",
      bridge_contract: requireContractAddress(bc2EvmDeployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc2EvmDeployment, "sFlight")],
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
  if (depth >= 4) {
    targets.push({
      vm: "evm",
      chain: "bc3evm",
      bridge_contract: requireContractAddress(bc3EvmDeployment, "xBridgingContract"),
      state_contracts: [requireContractAddress(bc3EvmDeployment, "sTaxi")],
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

  const manifest = {
    workflow_id: `xsmart-hetero-rq1c-d${depth}`,
    service_id: "travel",
    root_chain: "bc1",
    root_chain_id: 1,
    depth_axis: "heterogeneous-target-count",
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

  const bc2WasmChainId = Number(process.env.BC2_WASM_CHAIN_ID || bc2Deployment.contracts["bc2ChainId"] || "1338");
  const bc3FabricChainId = Number(process.env.BC3_FABRIC_CHAIN_ID || bc3Deployment.contracts["bc3ChainId"] || "3003");
  const yaml = `title: "XSmart RQ1c Heterogeneous Depth ${depth}"

protocol: "xsmart"

relayer:
  id: "xsmart-rq1c-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.relayer}"
  checkpoint_file: "./var/xsmart-ckpt.json"

chains:
  bc1:
    name: "${bc1.name}"
    vm: "evm"
    chain_id: ${bc1.chainId}
    finality_blocks: 4
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"

  bc2:
    name: "WASM Train Chain"
    vm: "wasm"
    chain_id: ${bc2WasmChainId}
    finality_blocks: 1
    rpc_url: "${bc2WasmHttp}"
    ws_url: "${bc2WasmWs}"
    metadata_path: "${bc2MetadataPath}"
    account_endpoint: "${normalizeEndpointForVM("wasm", bc2AccountEndpoint)}"
    submitter_uri: "${bc2SubmitterURI}"

  bc3:
    name: "Fabric Hotel Chain"
    vm: "fabric"
    chain_id: ${bc3FabricChainId}
    finality_blocks: 1
    rpc_url: "${process.env.BC3_FABRIC_HTTP_URL || bc3Deployment.contracts["bc3FabricHttp"] || "http://127.0.0.1:18645"}"
    http_url: "${process.env.BC3_FABRIC_HTTP_URL || bc3Deployment.contracts["bc3FabricHttp"] || "http://127.0.0.1:18645"}"
    account_endpoint: "${normalizeEndpointForVM("fabric", bc3AccountEndpoint)}"
    fabric_gateway_endpoint: "${bc3FabricGatewayEndpoint}"
    fabric_channel: "${bc3FabricChannel}"
    fabric_chaincode: "${bc3FabricChaincode}"
    fabric_msp_id: "${bc3FabricMSPID}"
    fabric_user_cert_path: "${toPortable(bc3FabricUserCertPath)}"
    fabric_user_key_path: "${toPortable(bc3FabricUserKeyPath)}"
    fabric_tls_cert_path: "${toPortable(bc3FabricTLSCertPath)}"
    fabric_peer_name: "${bc3FabricPeerName}"

${depth >= 3 ? `  bc2evm:
    name: "EVM Payment/Flight Chain"
    vm: "evm"
    chain_id: 22
    finality_blocks: 4
    rpc_url: "${bc2Evm.rpcUrl}"
    http_url: "${bc2Evm.httpUrl}"
` : ""}${depth >= 4 ? `  bc3evm:
    name: "EVM Loyalty/Taxi Chain"
    vm: "evm"
    chain_id: 33
    finality_blocks: 4
    rpc_url: "${bc3Evm.rpcUrl}"
    http_url: "${bc3Evm.httpUrl}"
` : ""}
contracts:
  xsmart:
    bc1:
      xbridging_contract: "${requireContractAddress(bc1Deployment, "xBridgingContract")}"
      ubtl_registry: "${requireContractAddress(bc1Deployment, "ubtlRegistry")}"
      relayer_manager: "${requireContractAddress(bc1Deployment, "relayerManager")}"
      light_client: "${requireContractAddress(bc1Deployment, "lightClient")}"
${depth >= 3 ? `    bc2evm:
      xbridging_contract: "${requireContractAddress(bc2EvmDeployment, "xBridgingContract")}"
` : ""}${depth >= 4 ? `    bc3evm:
      xbridging_contract: "${requireContractAddress(bc3EvmDeployment, "xBridgingContract")}"
` : ""}
proof:
  mode: "${proofMode}"
  require_non_evm_proofs: ${requireNonEVMProofs ? "true" : "false"}
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 4

relay:
  timeout_seconds: 60
  max_pending: 100

xsmart:
  manifest: "${toPortable(manifestPath)}"
  service_id: "travel"
  wasm_lock_num: 1
  wasm_timeout_blocks: 30
`;
  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered XSmart RQ1c depth manifest: ${manifestPath}`);
  console.log(`Rendered XSmart RQ1c depth config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
