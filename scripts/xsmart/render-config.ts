import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  PRIVATE_KEYS,
  chainRuntimeConfig,
  ensureDir,
  loadDeployment,
  manifestsDir,
  repoRoot,
  relayerConfigDir,
  requireContractAddress,
} from "../common";
import {
  normalizeEndpointForVM,
  resolveHotelSourceContractHash,
  resolveHotelTranslatedIRHashFromSource,
  sourceChainIdForVM,
} from "./translation";

async function main() {
  const bc1Deployment = loadDeployment("xsmart", "bc1");
  const bc2Deployment = loadDeployment("xsmart", "bc2");
  const bc3Deployment = loadDeployment("xsmart", "bc3");
  const bc1 = chainRuntimeConfig("bc1");

  ensureDir(relayerConfigDir());
  ensureDir(manifestsDir("xsmart"));
  const configPath = path.join(relayerConfigDir(), "config-xsmart.yaml");
  const manifestPath = path.join(
    manifestsDir("xsmart"),
    "travel-hetero.generated.json"
  );

  const manifest = buildManifest(bc1Deployment, bc2Deployment, bc3Deployment);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const bc2WasmHttp =
    process.env.BC2_WASM_HTTP_URL ||
    bc2Deployment.contracts["bc2RpcHttp"] ||
    "http://127.0.0.1:18545";
  const bc2WasmWs =
    process.env.BC2_WASM_WS_URL ||
    bc2Deployment.contracts["bc2RpcWs"] ||
    "ws://127.0.0.1:18545";
  const bc2WasmChainId = Number(
    process.env.BC2_WASM_CHAIN_ID ||
      bc2Deployment.contracts["bc2ChainId"] ||
      "1338"
  );
  const bc2MetadataPath =
    process.env.XSMART_BC2_METADATA_PATH ||
    bc2Deployment.contracts["bc2BridgeMetadataPath"] ||
    bc2Deployment.contracts["bc2MetadataPath"] ||
    toPortable(
      path.join(
        process.cwd(),
        "contracts",
        "xsmart",
        "bc2",
        "bridge",
        "target",
        "ink",
        "xbridge_bc2.contract"
      )
    );
  const bc2AccountEndpoint =
    process.env.XSMART_BC2_ACCOUNT_ENDPOINT ||
    bc2Deployment.contracts["xBridgeBc2"] ||
    "";
  const bc2SubmitterURI =
    process.env.XSMART_BC2_SURI ||
    bc2Deployment.contracts["bc2SubmitterURI"] ||
    "//Alice";
  const bc1FinalityBlocks = Number(process.env.XSMART_BC1_FINALITY_BLOCKS || "4");
  const bc2FinalityBlocks = Number(process.env.XSMART_BC2_FINALITY_BLOCKS || "1");
  const bc3FinalityBlocks = Number(process.env.XSMART_BC3_FINALITY_BLOCKS || "1");
  const proofConfirmationBlocks = Number(process.env.XSMART_PROOF_CONFIRMATION_BLOCKS || String(bc1FinalityBlocks));

  const bc2Yaml = bc2AccountEndpoint
    ? `
  bc2:
    name: "WASM Train Chain"
    vm: "wasm"
    chain_id: ${bc2WasmChainId}
    finality_blocks: ${bc2FinalityBlocks}
    rpc_url: "${bc2WasmHttp}"
    ws_url: "${bc2WasmWs}"
    metadata_path: "${bc2MetadataPath}"
    account_endpoint: "${normalizeEndpointForVM("wasm", bc2AccountEndpoint)}"
    submitter_uri: "${bc2SubmitterURI}"
    labels:
      network_id: "${process.env.BC2_WASM_NETWORK_ID || bc2Deployment.contracts["bc2NetworkId"] || `substrate-${bc2WasmChainId}`}"
      endpoint_identity: "${normalizeEndpointForVM("wasm", bc2AccountEndpoint)}"`
    : "";
  const bc3FabricHttp =
    process.env.BC3_FABRIC_HTTP_URL ||
    bc3Deployment.contracts["bc3FabricHttp"] ||
    "http://127.0.0.1:18645";
  const bc3FabricGatewayEndpoint =
    process.env.BC3_FABRIC_GATEWAY_ENDPOINT ||
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
  const effectiveBc3Endpoint = bc3FabricGatewayEndpoint
    ? normalizeEndpointForVM("fabric", bc3AccountEndpoint)
    : bc3AccountEndpoint;
  const bc3GatewayYaml =
    bc3FabricGatewayEndpoint
      ? `
    fabric_gateway_endpoint: "${bc3FabricGatewayEndpoint}"
    fabric_channel: "${bc3FabricChannel}"
    fabric_chaincode: "${bc3FabricChaincode}"
    fabric_msp_id: "${bc3FabricMSPID}"
    fabric_user_cert_path: "${toPortable(bc3FabricUserCertPath)}"
    fabric_user_key_path: "${toPortable(bc3FabricUserKeyPath)}"
    fabric_tls_cert_path: "${toPortable(bc3FabricTLSCertPath)}"
    fabric_peer_name: "${bc3FabricPeerName}"`
      : "";
  const bc3Yaml = bc3AccountEndpoint
    ? `
  bc3:
    name: "Fabric Hotel Chain"
    vm: "fabric"
    chain_id: ${Number(process.env.BC3_FABRIC_CHAIN_ID || bc3Deployment.contracts["bc3ChainId"] || "3")}
    finality_blocks: ${bc3FinalityBlocks}
    rpc_url: "${bc3FabricHttp}"
    http_url: "${bc3FabricHttp}"
    account_endpoint: "${effectiveBc3Endpoint}"${bc3GatewayYaml}
    labels:
      network_id: "${process.env.BC3_FABRIC_NETWORK_ID || bc3Deployment.contracts["bc3NetworkId"] || bc3FabricChannel || "mychannel"}"
      endpoint_identity: "${effectiveBc3Endpoint}"`
    : "";

  const yaml = `title: "XSmart Relayer Configuration"

protocol: "xsmart"

relayer:
  id: "xsmart-relayer"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.relayer}"

chains:
  bc1:
    name: "${bc1.name}"
    vm: "evm"
    chain_id: ${bc1.chainId}
    finality_blocks: ${bc1FinalityBlocks}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
${bc2Yaml}${bc3Yaml}

contracts:
  xsmart:
    bc1:
      xbridging_contract: "${requireContractAddress(
        bc1Deployment,
        "xBridgingContract"
      )}"
      ubtl_registry: "${requireContractAddress(bc1Deployment, "ubtlRegistry")}"
      relayer_manager: "${requireContractAddress(
        bc1Deployment,
        "relayerManager"
      )}"
      light_client: "${requireContractAddress(bc1Deployment, "lightClient")}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: ${proofConfirmationBlocks}

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
  console.log(`Rendered XSmart relayer config: ${configPath}`);
  console.log(`Rendered XSmart manifest: ${manifestPath}`);
}

function toPortable(value: string): string {
  return value.split(path.sep).join("/");
}

function buildManifest(
  bc1Deployment: ReturnType<typeof loadDeployment>,
  bc2Deployment: ReturnType<typeof loadDeployment>,
  bc3Deployment: ReturnType<typeof loadDeployment>
) {
  const translated = requireContractAddress(
    bc1Deployment,
    "hotelBookingTranslated"
  );
  const hasBc2 = Boolean(bc2Deployment.contracts["xBridgeBc2"]);
  const hasBc3 = Boolean(bc3Deployment.contracts["xBridgeBc3"]);
  const threshold = (hasBc2 ? 1 : 0) + (hasBc3 ? 1 : 0) || 1;
  const bc2User =
    process.env.XSMART_BC2_USER ||
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const callTreeBlob = encodeTree(
    [
      {
        contractAddr: translated,
        selector: selectorOf("GetAvailableRemain()"),
        args: "0x",
        argChildIdx: [],
        children: [],
      },
    ],
    0n
  );
  return {
    workflow_id: "xsmart-train-wasm",
    service_id: "travel",
    root_chain: "bc1",
    root_chain_id: 1,
    execute_threshold: threshold,
    update_ack_threshold: threshold,
    call_tree_blob: callTreeBlob,
    translation_keys: [hotelTranslationKey()],
    peer_ir_hashes: [hotelTranslatedIRHash()],
    ...(hasBc2
      ? {
          wasm: {
            chain: "bc2",
            contract: "xbridge_bc2",
            state_contract: bc2Deployment.contracts["trainBooking"] || "",
            lock_num: 1,
            timeout_blocks: 30,
            update: {
              user: bc2User,
              num: 1,
              total_cost: 50,
            },
          },
        }
      : {}),
    ...(hasBc3
      ? {
          fabric: {
            chain: "bc3",
            contract: "xbridge_bc3",
            state_contract:
              bc3Deployment.contracts["hotelBooking"] || "hotel_booking",
            lock_num: 1,
            timeout_blocks: 30,
            update: {
              user: "fabric-user",
              num: 1,
              total_cost: 100,
            },
          },
        }
      : {}),
  };
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
  rootIndex: bigint
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    [
      "tuple(address contractAddr, bytes4 selector, bytes args, uint256[] argChildIdx, uint256[] children)[]",
      "uint256",
    ],
    [nodes, rootIndex]
  );
}

function hotelTranslationKey(): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["uint256", "bytes32"],
      [sourceChainIdForVM("fabric"), resolveHotelSourceContractHash()]
    )
  );
}

function hotelTranslatedIRHash(): string {
  return resolveHotelTranslatedIRHashFromSource();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
