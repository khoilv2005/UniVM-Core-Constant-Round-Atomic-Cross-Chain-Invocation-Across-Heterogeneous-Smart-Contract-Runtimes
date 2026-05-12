import * as fs from "fs";
import * as path from "path";
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

type ManifestOperation = {
  id: number;
  step: number;
  function_id: string;
  parameter_names: string[];
};

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase()];
  if (envValue && envValue.trim() !== "") {
    return envValue;
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return defaultValue;
}

function depthDefinition(depth: number, bc2Deployment: ReturnType<typeof loadDeployment>, bc3Deployment: ReturnType<typeof loadDeployment>) {
  const hotel = requireContractAddress(bc2Deployment, "atomHotel");
  const train = requireContractAddress(bc3Deployment, "atomTrain");
  const flight = requireContractAddress(bc2Deployment, "atomFlight");
  const taxi = requireContractAddress(bc3Deployment, "atomTaxi");

  const remoteFunctions: RemoteFunction[] = [];
  const operations: ManifestOperation[] = [];

  let nextID = 1;
  let nextStep = 1;
  const push = (fn: RemoteFunction, parameterNames: string[]) => {
    remoteFunctions.push(fn);
    operations.push({
      id: nextID++,
      step: nextStep++,
      function_id: fn.function_id,
      parameter_names: parameterNames,
    });
  };

  if (depth >= 2) {
    push(
      {
        function_id: "hotel-write",
        chain_id: 2,
        contract_address: hotel,
        business_unit: "hotel.book",
        pattern: "atomicWrite",
        lock_do_selector: "book_lock_do",
        unlock_selector: "book_unlock",
        undo_unlock_selector: "book_undo_unlock",
      },
      ["user", "rooms"],
    );
  }
  if (depth >= 3) {
    push(
      {
        function_id: "train-write",
        chain_id: 3,
        contract_address: train,
        business_unit: "train.book",
        pattern: "atomicWrite",
        lock_do_selector: "book_lock_do",
        unlock_selector: "book_unlock",
        undo_unlock_selector: "book_undo_unlock",
      },
      ["user", "outboundTickets", "returnTickets"],
    );
  }
  if (depth >= 4) {
    push(
      {
        function_id: "flight-write",
        chain_id: 2,
        contract_address: flight,
        business_unit: "flight.book",
        pattern: "atomicWrite",
        lock_do_selector: "book_lock_do",
        unlock_selector: "book_unlock",
        undo_unlock_selector: "book_undo_unlock",
      },
      ["user", "rooms"],
    );
  }
  if (depth >= 5) {
    push(
      {
        function_id: "taxi-write",
        chain_id: 3,
        contract_address: taxi,
        business_unit: "taxi.book",
        pattern: "atomicWrite",
        lock_do_selector: "book_lock_do",
        unlock_selector: "book_unlock",
        undo_unlock_selector: "book_undo_unlock",
      },
      ["user", "rooms"],
    );
  }

  return {
    workflow_id: `atom-travel-write-only-depth-${depth}`,
    workflow_name: `Atom Travel Write Only Depth ${depth}`,
    total_operations: operations.length,
    remote_functions: remoteFunctions,
    operations,
  };
}

async function main() {
  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`ATOM 1b depth must be one of 2,3,4,5; got ${depth}`);
  }

  const bc1Deployment = loadDeployment("atom", "bc1");
  const bc2Deployment = loadDeployment("atom", "bc2");
  const bc3Deployment = loadDeployment("atom", "bc3");

  const atomService = requireContractAddress(bc1Deployment, "atomService");
  const atomDepthEntry = requireContractAddress(bc1Deployment, "atomTravelDepthEntry");
  const atomRegistry = requireContractAddress(bc1Deployment, "atomRemoteRegistry");
  const atomCommunity = requireContractAddress(bc1Deployment, "atomCommunity");
  const atomHotel = requireContractAddress(bc2Deployment, "atomHotel");
  const atomTrain = requireContractAddress(bc3Deployment, "atomTrain");
  const atomFlight = requireContractAddress(bc2Deployment, "atomFlight");
  const atomTaxi = requireContractAddress(bc3Deployment, "atomTaxi");

  const manifest = depthDefinition(depth, bc2Deployment, bc3Deployment);

  const manifestOutputDir = manifestsDir("atom");
  ensureDir(manifestOutputDir);
  const manifestPath = path.join(manifestOutputDir, `travel-write-only-depth-${depth}.generated.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  ensureDir(relayerConfigDir());
  const configPath = path.join(relayerConfigDir(), `config-atom-1b-d${depth}.yaml`);
  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");

  const yaml = `title: "Atom Relayer Configuration (RQ1b depth=${depth})"

protocol: "atom"

relayer:
  id: "atom-relayer-1b-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"

chains:
  bc1:
    name: "${bc1.name}"
    chain_id: ${bc1.chainId}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
    atom_service_address: "${atomService}"
    atom_entry_address: "${atomDepthEntry}"
    atom_registry_address: "${atomRegistry}"
    atom_community_address: "${atomCommunity}"

  bc2:
    name: "${bc2.name}"
    chain_id: ${bc2.chainId}
    rpc_url: "${bc2.rpcUrl}"
    http_url: "${bc2.httpUrl}"
    atom_hotel_address: "${atomHotel}"
    atom_flight_address: "${atomFlight}"

  bc3:
    name: "${bc3.name}"
    chain_id: ${bc3.chainId}
    rpc_url: "${bc3.rpcUrl}"
    http_url: "${bc3.httpUrl}"
    atom_train_address: "${atomTrain}"
    atom_taxi_address: "${atomTaxi}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 1

relay:
  timeout_seconds: 60
  max_pending: 100

atom:
  write_only_manifest: "${toPortablePath(path.relative(relayerConfigDir(), manifestPath))}"
  judge_private_keys:
${PRIVATE_KEYS.judges.map((key) => `    - "${key}"`).join("\n")}
`;

  fs.writeFileSync(configPath, yaml, "utf-8");
  console.log(`Rendered Atom 1b manifest: ${manifestPath}`);
  console.log(`Rendered Atom 1b relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
