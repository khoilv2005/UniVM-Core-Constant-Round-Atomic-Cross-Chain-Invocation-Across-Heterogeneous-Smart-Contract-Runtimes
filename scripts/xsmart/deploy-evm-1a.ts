import hre from "hardhat";
import {
  banner,
  loadDeployment,
  deployIfMissing,
  summary,
  CONSTS,
  addressOf,
  fundActors,
  PRIVATE_KEYS,
  writeDeployment,
  readContract,
  sendContract,
  networkName,
} from "../common";
import { deploySelectedProofAdapter, setSelectedProofAdapter } from "./proof-adapter";

function profileFor(chain: string): { deployKey: string; chainId: number } {
  if (chain === "bc2") {
    return { deployKey: "bc2-evm", chainId: 2 };
  }
  if (chain === "bc3") {
    return { deployKey: "bc3-evm", chainId: 3 };
  }
  throw new Error(`Unsupported XSmart 1a EVM chain: ${chain}`);
}

async function main() {
  const chain = networkName();
  if (!chain) {
    throw new Error("Unable to resolve target chain for XSmart 1a EVM deploy");
  }
  const profile = profileFor(chain);
  banner("xsmart", profile.deployKey);
  const rec = loadDeployment("xsmart", profile.deployKey);
  rec.chainId = profile.chainId;

  await fundActors([addressOf(PRIVATE_KEYS.relayer)]);

  const lc = await deployIfMissing(rec, "lightClient", "LightClient", [
    profile.chainId,
    CONSTS.LIGHT_CLIENT_FINALITY,
  ]);
  const rm = await deployIfMissing(rec, "relayerManager", "RelayerManager", [
    CONSTS.RELAYER_MIN_STAKE,
    CONSTS.RELAYER_REWARD,
    CONSTS.RELAYER_PENALTY,
  ]);
  const registry = await deployIfMissing(rec, "ubtlRegistry", "UBTLRegistry", []);
  const proofAdapter = await deploySelectedProofAdapter(rec, lc);
  const bridge = await deployIfMissing(rec, "xBridgingContract", "XBridgingContract", [
    profile.chainId,
    lc,
    rm,
    CONSTS.BRIDGE_TIMEOUT_BLOCKS,
    CONSTS.CROSS_CHAIN_FEE,
  ]);

  const lHotel = await deployIfMissing(rec, "lHotel", "LHotel", []);
  const lTrain = await deployIfMissing(rec, "lTrain", "LTrain", []);
  const lFlight = await deployIfMissing(rec, "lFlight", "LFlight", []);
  const lTaxi = await deployIfMissing(rec, "lTaxi", "LTaxi", []);
  const sHotel = await deployIfMissing(rec, "sHotel", "SHotel", [
    CONSTS.HOTEL_PRICE,
    CONSTS.HOTEL_REMAIN,
    lHotel,
    bridge,
    CONSTS.LOCK_SIZE,
  ]);
  let sFlight = "";
  let sTaxi = "";
  if (chain === "bc2") {
    sFlight = await deployIfMissing(rec, "sFlight", "SFlight", [
      CONSTS.FLIGHT_PRICE,
      CONSTS.FLIGHT_SEATS,
      lFlight,
      bridge,
      CONSTS.LOCK_SIZE,
    ]);
  }
  if (chain === "bc3") {
    sTaxi = await deployIfMissing(rec, "sTaxi", "STaxi", [
      CONSTS.TAXI_PRICE,
      CONSTS.TAXI_CARS,
      lTaxi,
      bridge,
      CONSTS.LOCK_SIZE,
    ]);
  }
  const sTrain = await deployIfMissing(rec, "sTrain", "STrain", [
    CONSTS.TRAIN_PRICE,
    CONSTS.TRAIN_SEATS,
    lTrain,
    bridge,
    CONSTS.LOCK_SIZE,
  ]);

  const relayerAddr = addressOf(PRIVATE_KEYS.relayer);
  const relayerActive = await readContract("RelayerManager", rm, "isRelayerActive", [relayerAddr]);
  if (!relayerActive) {
    console.log(`  [init]   register relayer ${relayerAddr}`);
    await sendContract("RelayerManager", rm, "registerRelayer", [], CONSTS.RELAYER_MIN_STAKE);
  } else {
    console.log(`  [skip]   relayer already active ${relayerAddr}`);
  }

  const currentRegistry = await readContract("XBridgingContract", bridge, "ubtlRegistry", []);
  if (String(currentRegistry).toLowerCase() !== registry.toLowerCase()) {
    console.log(`  [init]   set UBTL registry ${registry}`);
    await sendContract("XBridgingContract", bridge, "setUBTLRegistry", [registry]);
  } else {
    console.log(`  [skip]   UBTL registry already set ${registry}`);
  }

  await setSelectedProofAdapter(bridge, proofAdapter);

  const stateContracts = [sHotel, sTrain];
  if (sFlight) {
    stateContracts.push(sFlight);
  }
  if (sTaxi) {
    stateContracts.push(sTaxi);
  }

  for (const stateContract of stateContracts) {
    const registered = await readContract("XBridgingContract", bridge, "registeredStateContracts", [stateContract]);
    if (!registered) {
      console.log(`  [init]   register state ${stateContract}`);
      await sendContract("XBridgingContract", bridge, "regState", [stateContract]);
    } else {
      console.log(`  [skip]   state already registered ${stateContract}`);
    }
  }

  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
