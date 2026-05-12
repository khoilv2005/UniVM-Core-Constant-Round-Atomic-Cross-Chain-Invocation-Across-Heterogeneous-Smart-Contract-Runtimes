import * as fs from "fs";
import * as path from "path";
import {
  PRIVATE_KEYS,
  ensureDir,
  loadDeployment,
  manifestsDir,
  relayerConfigDir,
  requireContractAddress,
  toPortablePath,
} from "../common";

function requireField(record: ReturnType<typeof loadDeployment>, key: string): string {
  const value = record.contracts[key];
  if (!value || value.trim() === "") {
    throw new Error(`Deployment ${record.system}/${record.network} missing contract ${key}`);
  }
  return value.trim();
}

async function main() {
  const gpactBc1 = loadDeployment("gpact", "bc1");
  const xsmartBc2 = loadDeployment("xsmart", "bc2");
  const xsmartBc3 = loadDeployment("xsmart", "bc3");

  const bc2Bridge = requireField(xsmartBc2, "xBridgeBc2");
  const bc3Bridge = requireField(xsmartBc3, "xBridgeBc3");
  const bc3Gateway = requireField(xsmartBc3, "bc3FabricGatewayEndpoint");

  const manifest = {
    workflow_id: "gpact-train-hotel-hetero",
    root_chain_id: 1,
    segments: [
      {
        segment_id: 1,
        chain_id: 3,
        contract: bc3Bridge,
        function: "hotel",
        kind: "hotel",
      },
      {
        segment_id: 2,
        chain_id: 2,
        contract: bc2Bridge,
        function: "train",
        kind: "train",
      },
    ],
  };

  const manifestPath = path.join(manifestsDir("gpact"), "train-hotel-hetero.generated.json");
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const configPath = path.join(relayerConfigDir(), "config-gpact-rq1c.yaml");
  ensureDir(path.dirname(configPath));
  const yaml = `title: "GPACT RQ1c Heterogeneous Relayer Configuration"

protocol: "gpact"

relayer:
  id: "gpact-rq1c-relayer"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"
  checkpoint_file: "./var/gpact-rq1c-ckpt.json"

chains:
  bc1:
    name: "Execution Chain"
    vm: "evm"
    chain_id: 1
    finality_blocks: 4
    rpc_url: "${process.env.BC1_RPC_URL || process.env.BC1_WS_URL || "ws://209.38.21.129:8546"}"
    http_url: "${process.env.BC1_HTTP_URL || "http://209.38.21.129:8545"}"
    gpact_control_address: "${requireContractAddress(gpactBc1, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(gpactBc1, "gpactTravelRoot")}"
    gpact_signer_registry_address: "${requireContractAddress(gpactBc1, "gpactSignerRegistry")}"

  bc2:
    name: "WASM GPACT Segment Chain"
    vm: "wasm"
    chain_id: 2
    finality_blocks: 1
    rpc_url: "${requireField(xsmartBc2, "bc2RpcHttp")}"
    ws_url: "${requireField(xsmartBc2, "bc2RpcWs")}"
    metadata_path: "${toPortablePath(requireField(xsmartBc2, "bc2BridgeMetadataPath"))}"
    account_endpoint: "${bc2Bridge}"
    submitter_uri: "${xsmartBc2.contracts.bc2SubmitterURI || "//Alice"}"

  bc3:
    name: "Fabric GPACT Segment Chain"
    vm: "fabric"
    chain_id: 3
    finality_blocks: 1
    rpc_url: "${xsmartBc3.contracts.bc3FabricHttp || "http://127.0.0.1:18645"}"
    http_url: "${xsmartBc3.contracts.bc3FabricHttp || "http://127.0.0.1:18645"}"
    account_endpoint: "${bc3Bridge}"
    fabric_gateway_endpoint: "${bc3Gateway}"
    fabric_channel: "${requireField(xsmartBc3, "bc3FabricChannel")}"
    fabric_chaincode: "${requireField(xsmartBc3, "bc3FabricChaincode")}"
    fabric_msp_id: "${requireField(xsmartBc3, "bc3FabricMSPID")}"
    fabric_user_cert_path: "${toPortablePath(requireField(xsmartBc3, "bc3FabricUserCertPath"))}"
    fabric_user_key_path: "${toPortablePath(requireField(xsmartBc3, "bc3FabricUserKeyPath"))}"
    fabric_tls_cert_path: "${toPortablePath(requireField(xsmartBc3, "bc3FabricTLSCertPath"))}"
    fabric_peer_name: "${requireField(xsmartBc3, "bc3FabricPeerName")}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 4

relay:
  timeout_seconds: 60
  max_pending: 100

gpact:
  manifest: "${toPortablePath(path.relative(relayerConfigDir(), manifestPath))}"
  event_transfer_mode: "direct-signing"
  execution_mode: "serial"
  signer_private_keys:
${[PRIVATE_KEYS.atomServer, PRIVATE_KEYS.judges[1], PRIVATE_KEYS.judges[2]]
  .map((key) => `    - "${key}"`)
  .join("\n")}
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered GPACT RQ1c manifest: ${manifestPath}`);
  console.log(`Rendered GPACT RQ1c relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
