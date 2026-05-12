import * as fs from "fs";
import * as path from "path";
import {
  PRIVATE_KEYS,
  chainRuntimeConfig,
  ensureDir,
  loadDeployment,
  relayerConfigDir,
  requireContractAddress,
} from "../common";

async function main() {
  const bc1Deployment = loadDeployment("integratex", "bc1");
  const bc2Deployment = loadDeployment("integratex", "bc2");
  const bc3Deployment = loadDeployment("integratex", "bc3");

  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");

  const configPath = path.join(relayerConfigDir(), "config-integratex.yaml");
  ensureDir(relayerConfigDir());

  const hotelState = requireContractAddress(bc2Deployment, "sHotel");
  const trainState = requireContractAddress(bc3Deployment, "sTrain");

  const yaml = `title: "IntegrateX Relayer Configuration"

protocol: "integratex"

relayer:
  id: "integratex-relayer"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.relayer}"
  checkpoint_file: "var/integratex-1a-ckpt.json"

chains:
  bc1:
    name: "${bc1.name}"
    chain_id: ${bc1.chainId}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
    contract_address: "${requireContractAddress(bc1Deployment, "bridgingContract")}"
    travel_dapp_address: "${requireContractAddress(bc1Deployment, "travelDApp")}"

  bc2:
    name: "${bc2.name}"
    chain_id: ${bc2.chainId}
    rpc_url: "${bc2.rpcUrl}"
    http_url: "${bc2.httpUrl}"
    contract_address: "${requireContractAddress(bc2Deployment, "bridgingContract")}"
    service_state_contracts:
      hotel-service:
        - "${hotelState}"

  bc3:
    name: "${bc3.name}"
    chain_id: ${bc3.chainId}
    rpc_url: "${bc3.rpcUrl}"
    http_url: "${bc3.httpUrl}"
    contract_address: "${requireContractAddress(bc3Deployment, "bridgingContract")}"
    service_state_contracts:
      train-service:
        - "${trainState}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 1

relay:
  timeout_seconds: 60
  max_pending: 100
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered IntegrateX relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
