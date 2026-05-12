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

type RemoteFunction = {
  function_id: string;
  chain_id: number;
  contract_address: string;
  business_unit: string;
  pattern: string;
  lock_do_selector: string;
  unlock_selector: string;
  undo_unlock_selector: string;
};

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
    throw new Error(`RQ1c Atom depth must be 2, 3, 4, or 5; got ${depth}`);
  }

  const bc1Deployment = loadDeployment("atom", "bc1");
  const bc2Deployment = loadDeployment("atom", "bc2");
  const bc3Deployment = loadDeployment("atom", "bc3");
  const xsmartBc2Deployment = loadDeployment("xsmart", "bc2");
  const wasmBridgeEndpoint = requireContractAddress(xsmartBc2Deployment, "xBridgeBc2");

  const remoteFunctions: RemoteFunction[] = [
    {
      function_id: "hotel-write",
      chain_id: 3,
      contract_address: "XBridgeBc3",
      business_unit: "hotel.book",
      pattern: "atomicWrite",
      lock_do_selector: "atom_lock_do",
      unlock_selector: "atom_unlock",
      undo_unlock_selector: "atom_undo_unlock",
    },
    {
      function_id: "train-write",
      chain_id: 2,
      contract_address: wasmBridgeEndpoint,
      business_unit: "train.book",
      pattern: "atomicWrite",
      lock_do_selector: "atom_lock_do",
      unlock_selector: "atom_unlock",
      undo_unlock_selector: "atom_undo_unlock",
    },
  ];
  if (depth >= 3) {
    remoteFunctions.push({
      function_id: "flight-write",
      chain_id: 22,
      contract_address: requireContractAddress(bc2Deployment, "atomFlight"),
      business_unit: "flight.book",
      pattern: "atomicWrite",
      lock_do_selector: "book_lock_do",
      unlock_selector: "book_unlock",
      undo_unlock_selector: "book_undo_unlock",
    });
  }
  if (depth >= 4) {
    remoteFunctions.push({
      function_id: "taxi-write",
      chain_id: 33,
      contract_address: requireContractAddress(bc3Deployment, "atomTaxi"),
      business_unit: "taxi.book",
      pattern: "atomicWrite",
      lock_do_selector: "book_lock_do",
      unlock_selector: "book_unlock",
      undo_unlock_selector: "book_undo_unlock",
    });
  }

  const operations = remoteFunctions.map((fn, index) => ({
    id: index + 1,
    step: index + 1,
    function_id: fn.function_id,
    parameter_names: fn.function_id === "train-write" ? ["user", "outboundTickets", "returnTickets"] : ["user", "rooms"],
  }));

  ensureDir(manifestsDir("atom"));
  ensureDir(relayerConfigDir());

  const manifestPath = path.join(manifestsDir("atom"), `travel-write-only-hetero-d${depth}.generated.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        workflow_id: `atom-travel-write-only-depth-${depth}`,
        workflow_name: `Atom Travel Write Only Heterogeneous Depth ${depth}`,
        total_operations: remoteFunctions.length,
        remote_functions: remoteFunctions,
        operations,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const configPath = path.join(relayerConfigDir(), `config-atom-rq1c-d${depth}.yaml`);
  const yaml = `title: "ATOM RQ1c Heterogeneous Depth ${depth}"

protocol: "atom"

relayer:
  id: "atom-rq1c-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"
  checkpoint_file: "./var/atom-rq1c-d${depth}-ckpt.json"

chains:
  bc1:
    name: "Execution Chain"
    vm: "evm"
    chain_id: 1
    finality_blocks: 4
    rpc_url: "ws://209.38.21.129:8546"
    http_url: "http://209.38.21.129:8545"
    atom_service_address: "${requireContractAddress(bc1Deployment, "atomService")}"
    atom_entry_address: "${requireContractAddress(bc1Deployment, depth === 2 ? "atomTravelEntry" : "atomTravelDepthEntry")}"
    atom_registry_address: "${requireContractAddress(bc1Deployment, "atomRemoteRegistry")}"
    atom_community_address: "${requireContractAddress(bc1Deployment, "atomCommunity")}"

  bc2:
    name: "WASM ATOM Remote Chain"
    vm: "wasm"
    chain_id: 2
    finality_blocks: 1
    rpc_url: "http://170.64.194.4:18545"
    ws_url: "ws://170.64.194.4:18545"
    metadata_path: "D:/UIT/randomly/contracts/xsmart/bc2/bridge/target/ink/xbridge_bc2.contract"
    account_endpoint: "${wasmBridgeEndpoint}"
    submitter_uri: "//Alice"

  bc3:
    name: "Fabric ATOM Remote Chain"
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
    name: "EVM ATOM Flight Chain"
    vm: "evm"
    chain_id: 22
    finality_blocks: 4
    rpc_url: "ws://170.64.194.4:8546"
    http_url: "http://170.64.194.4:8545"
    atom_flight_address: "${requireContractAddress(bc2Deployment, "atomFlight")}"

  bc3evm:
    name: "EVM ATOM Taxi Chain"
    vm: "evm"
    chain_id: 33
    finality_blocks: 4
    rpc_url: "ws://170.64.164.173:8546"
    http_url: "http://170.64.164.173:8545"
    atom_taxi_address: "${requireContractAddress(bc3Deployment, "atomTaxi")}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 4

relay:
  timeout_seconds: 120
  max_pending: 100

atom:
  write_only_manifest: "${relayerRelative(manifestPath)}"
  judge_private_keys:
${PRIVATE_KEYS.judges.map((key) => `    - "${key}"`).join("\n")}
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered Atom RQ1c manifest: ${manifestPath}`);
  console.log(`Rendered Atom RQ1c relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
