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

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
  if (envValue && envValue.trim() !== "") {
    return envValue;
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return defaultValue;
}

function relayerRelative(filePath: string): string {
  return toPortablePath(path.relative(relayerConfigDir(), filePath));
}

async function main() {
  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`RQ1c GPACT depth must be 2, 3, 4, or 5; got ${depth}`);
  }

  const bc1Deployment = loadDeployment("gpact", "bc1");
  const bc2Deployment = loadDeployment("gpact", "bc2");
  const bc3Deployment = loadDeployment("gpact", "bc3");
  const xsmartBc2Deployment = loadDeployment("xsmart", "bc2");
  const wasmBridgeEndpoint = requireContractAddress(xsmartBc2Deployment, "xBridgeBc2");

  const segments: Array<Record<string, unknown>> = [
    {
      segment_id: 1,
      chain_id: 3,
      contract: "XBridgeBc3",
      function: "hotel",
      kind: "hotel",
    },
    {
      segment_id: 2,
      chain_id: 2,
      contract: wasmBridgeEndpoint,
      function: "train",
      kind: "train",
    },
  ];
  if (depth >= 3) {
    segments.push({
      segment_id: 3,
      chain_id: 22,
      contract: requireContractAddress(bc2Deployment, "gpactFlight"),
      function: "flight",
      kind: "flight",
    });
  }
  if (depth >= 4) {
    segments.push({
      segment_id: 4,
      chain_id: 33,
      contract: requireContractAddress(bc3Deployment, "gpactTaxi"),
      function: "taxi",
      kind: "taxi",
    });
  }

  ensureDir(manifestsDir("gpact"));
  ensureDir(relayerConfigDir());

  const manifestPath = path.join(manifestsDir("gpact"), `travel-hetero-d${depth}.generated.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        workflow_id: `gpact-travel-hetero-d${depth}`,
        root_chain_id: 1,
        segments,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const configPath = path.join(relayerConfigDir(), `config-gpact-rq1c-d${depth}.yaml`);
  const yaml = `title: "GPACT RQ1c Heterogeneous Depth ${depth}"

protocol: "gpact"

relayer:
  id: "gpact-rq1c-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"
  checkpoint_file: "./var/gpact-rq1c-d${depth}-ckpt.json"

chains:
  bc1:
    name: "Execution Chain"
    vm: "evm"
    chain_id: 1
    finality_blocks: 4
    rpc_url: "ws://209.38.21.129:8546"
    http_url: "http://209.38.21.129:8545"
    gpact_control_address: "${requireContractAddress(bc1Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc1Deployment, "gpactTravelRoot")}"
    gpact_signer_registry_address: "${requireContractAddress(bc1Deployment, "gpactSignerRegistry")}"

  bc2:
    name: "WASM GPACT Segment Chain"
    vm: "wasm"
    chain_id: 2
    finality_blocks: 1
    rpc_url: "http://170.64.194.4:18545"
    ws_url: "ws://170.64.194.4:18545"
    metadata_path: "D:/UIT/randomly/contracts/xsmart/bc2/bridge/target/ink/xbridge_bc2.contract"
    account_endpoint: "${wasmBridgeEndpoint}"
    submitter_uri: "//Alice"

  bc3:
    name: "Fabric GPACT Segment Chain"
    vm: "fabric"
    chain_id: 3
    finality_blocks: 1
    rpc_url: "http://127.0.0.1:18645"
    http_url: "http://127.0.0.1:18645"
    account_endpoint: "XBridgeBc3"
    fabric_gateway_endpoint: "209.38.21.129:7051"
    fabric_channel: "mychannel"
    fabric_chaincode: "xsmart-bc3"
    fabric_msp_id: "Org1MSP"
    fabric_user_cert_path: "D:/UIT/randomly/configs/fabric/crypto-generated/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/Admin@org1.example.com-cert.pem"
    fabric_user_key_path: "D:/UIT/randomly/configs/fabric/crypto-generated/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore/key.pem"
    fabric_tls_cert_path: "D:/UIT/randomly/configs/fabric/crypto-generated/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
    fabric_peer_name: "peer0.org1.example.com"

  bc2evm:
    name: "EVM GPACT Flight Chain"
    vm: "evm"
    chain_id: 22
    finality_blocks: 4
    rpc_url: "ws://170.64.194.4:8546"
    http_url: "http://170.64.194.4:8545"
    gpact_control_address: "${requireContractAddress(bc2Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc2Deployment, "gpactFlight")}"
    gpact_signer_registry_address: "${requireContractAddress(bc2Deployment, "gpactSignerRegistry")}"

  bc3evm:
    name: "EVM GPACT Taxi Chain"
    vm: "evm"
    chain_id: 33
    finality_blocks: 4
    rpc_url: "ws://170.64.164.173:8546"
    http_url: "http://170.64.164.173:8545"
    gpact_control_address: "${requireContractAddress(bc3Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc3Deployment, "gpactTaxi")}"
    gpact_signer_registry_address: "${requireContractAddress(bc3Deployment, "gpactSignerRegistry")}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 4

relay:
  timeout_seconds: 120
  max_pending: 100

gpact:
  manifest: "${relayerRelative(manifestPath)}"
  event_transfer_mode: "direct-signing"
  execution_mode: "serial"
  signer_private_keys:
${[PRIVATE_KEYS.atomServer, PRIVATE_KEYS.judges[1], PRIVATE_KEYS.judges[2]].map((key) => `    - "${key}"`).join("\n")}
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered GPACT RQ1c manifest: ${manifestPath}`);
  console.log(`Rendered GPACT RQ1c relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
