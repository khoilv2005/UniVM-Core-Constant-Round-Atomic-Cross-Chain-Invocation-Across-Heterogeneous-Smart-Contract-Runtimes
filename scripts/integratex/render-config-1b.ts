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

function renderServiceStateGroups(depth: number, bc2Deployment: ReturnType<typeof loadDeployment>, bc3Deployment: ReturnType<typeof loadDeployment>): string {
  const lines: string[] = [];
  lines.push(`      hotel-service:`);
  lines.push(`        - "${requireContractAddress(bc2Deployment, "sHotel")}"`);
  if (depth >= 4) {
    lines.push(`      flight-service:`);
    lines.push(`        - "${requireContractAddress(bc2Deployment, "sFlight")}"`);
  }
  lines.push(`      train-service:`);
  if (depth >= 3) {
    lines.push(`        - "${requireContractAddress(bc3Deployment, "sTrain")}"`);
  }
  if (depth >= 5) {
    lines.push(`      taxi-service:`);
    lines.push(`        - "${requireContractAddress(bc3Deployment, "sTaxi")}"`);
  }
  return lines.join("\n");
}

async function main() {
  const bc1Deployment = loadDeployment("integratex", "bc1");
  const bc2Deployment = loadDeployment("integratex", "bc2");
  const bc3Deployment = loadDeployment("integratex", "bc3");
  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");

  ensureDir(relayerConfigDir());

  for (const depth of [2, 3, 4, 5]) {
    const configPath = path.join(relayerConfigDir(), `config-integratex-1b-d${depth}.yaml`);
    const bc3Services = [`      train-service:`, `        - "${requireContractAddress(bc3Deployment, "sTrain")}"`];
    if (depth >= 5) {
      bc3Services.push(`      taxi-service:`, `        - "${requireContractAddress(bc3Deployment, "sTaxi")}"`);
    }

    const yaml = `title: "IntegrateX Relayer Configuration (RQ1b depth ${depth})"

protocol: "integratex"

relayer:
  id: "integratex-relayer-1b-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.relayer}"
  checkpoint_file: "var/integratex-1b-d${depth}-ckpt.json"

chains:
  bc1:
    name: "${bc1.name}"
    chain_id: ${bc1.chainId}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
    contract_address: "${requireContractAddress(bc1Deployment, "bridgingContract")}"
    travel_dapp_address: "${requireContractAddress(bc1Deployment, "travelDepthDApp")}"

  bc2:
    name: "${bc2.name}"
    chain_id: ${bc2.chainId}
    rpc_url: "${bc2.rpcUrl}"
    http_url: "${bc2.httpUrl}"
    contract_address: "${requireContractAddress(bc2Deployment, "bridgingContract")}"
    service_state_contracts:
      hotel-service:
        - "${requireContractAddress(bc2Deployment, "sHotel")}"
${depth >= 4 ? `      flight-service:\n        - "${requireContractAddress(bc2Deployment, "sFlight")}"` : ""}

  bc3:
    name: "${bc3.name}"
    chain_id: ${bc3.chainId}
    rpc_url: "${bc3.rpcUrl}"
    http_url: "${bc3.httpUrl}"
    contract_address: "${requireContractAddress(bc3Deployment, "bridgingContract")}"
    service_state_contracts:
      train-service:
        - "${requireContractAddress(bc3Deployment, "sTrain")}"
${depth >= 5 ? `      taxi-service:\n        - "${requireContractAddress(bc3Deployment, "sTaxi")}"` : ""}

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 1

relay:
  timeout_seconds: 120
  max_pending: 100
`;
    fs.writeFileSync(configPath, yaml, "utf-8");
    console.log(`Rendered IntegrateX 1b config: ${configPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
