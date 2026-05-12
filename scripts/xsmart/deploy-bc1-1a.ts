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
} from "../common";
import { registerTranslations } from "./register-translations";
import { deploySelectedProofAdapter, setSelectedProofAdapter } from "./proof-adapter";

async function main() {
  const deployKey = "bc1-1a";
  banner("xsmart", deployKey);
  const rec = loadDeployment("xsmart", deployKey);
  rec.chainId = 1;

  if (hre.network.name === "local") {
    const deployer = addressOf(PRIVATE_KEYS.relayer);
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [deployer, "0x21e19e0c9bab2400000"],
    });
  }

  await fundActors([addressOf(PRIVATE_KEYS.relayer)]);

  const lc = await deployIfMissing(rec, "lightClient", "LightClient", [
    1,
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
    1,
    lc,
    rm,
    CONSTS.BRIDGE_TIMEOUT_BLOCKS,
    CONSTS.CROSS_CHAIN_FEE,
  ]);

  const lHotel = await deployIfMissing(rec, "lHotel", "LHotel", []);
  const lTrain = await deployIfMissing(rec, "lTrain", "LTrain", []);
  const sHotel = await deployIfMissing(rec, "sHotel", "SHotel", [
    CONSTS.HOTEL_PRICE,
    CONSTS.HOTEL_REMAIN,
    lHotel,
    bridge,
    CONSTS.LOCK_SIZE,
  ]);
  const sTrain = await deployIfMissing(rec, "sTrain", "STrain", [
    CONSTS.TRAIN_PRICE,
    CONSTS.TRAIN_SEATS,
    lTrain,
    bridge,
    CONSTS.LOCK_SIZE,
  ]);
  const translated = await deployIfMissing(rec, "hotelBookingTranslated", "HotelBookingTranslated", []);

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

  for (const stateContract of [sHotel, sTrain]) {
    const registered = await readContract("XBridgingContract", bridge, "registeredStateContracts", [stateContract]);
    if (!registered) {
      console.log(`  [init]   register state ${stateContract}`);
      await sendContract("XBridgingContract", bridge, "regState", [stateContract]);
    } else {
      console.log(`  [skip]   state already registered ${stateContract}`);
    }
  }

  const logicAddress = await readContract("XBridgingContract", bridge, "getLogicContractAddress", ["travel"]);
  if (String(logicAddress).toLowerCase() === "0x0000000000000000000000000000000000000000") {
    console.log(`  [init]   register service travel -> ${translated}`);
    await sendContract("XBridgingContract", bridge, "regServer", ["travel", translated]);
  } else {
    console.log(`  [skip]   service travel already registered ${logicAddress}`);
  }

  const verified = await readContract("XBridgingContract", bridge, "isVerified", ["travel"]);
  if (!verified) {
    console.log("  [init]   mark travel service verified");
    await sendContract("XBridgingContract", bridge, "confirmVerification", ["travel", true, 0, [], "0x" + "00".repeat(32)]);
  } else {
    console.log("  [skip]   service travel already verified");
  }

  const translatedPrice = await readContract("HotelBookingTranslated", translated, "GetPrice", []);
  if (BigInt(translatedPrice) === 0n) {
    const metaSlot = hre.ethers.solidityPackedKeccak256(
      ["string", "string", "string"],
      ["VASSP", "HotelBooking", "META"],
    );
    const metaPayload = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "uint256", "uint256"],
      ["benchmark", CONSTS.HOTEL_PRICE, CONSTS.HOTEL_REMAIN, CONSTS.LOCK_SIZE],
    );
    console.log("  [init]   initialize translated hotel meta");
    await sendContract("HotelBookingTranslated", translated, "__vassp_apply", [metaSlot, metaPayload]);
  } else {
    console.log(`  [skip]   translated hotel meta already initialized price=${translatedPrice}`);
  }

  await registerTranslations(rec);
  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
