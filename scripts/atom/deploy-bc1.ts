/**
 * Deploy ATOM (AtomCI) contracts to bc1 (hub chain).
 *
 * Run:
 *   npx hardhat --config hardhat.atom-bc1.config.ts \
 *               --network besu run scripts/atom/deploy-bc1.ts
 *
 * Deploys: AtomCommunity, AtomService, AtomRemoteRegistry,
 *          AtomTravelEntry, AtomTravelDepthEntry.
 * Registers the ATOM server + judges in the community.
 */
import {
  banner, loadDeployment, deployIfMissing, summary, networkName,
  chainIdOf, CONSTS, addressOf, fundActors, PRIVATE_KEYS, writeDeployment, contractAt,
  readContract, sendContract, sendContractWithPrivateKey, web3,
} from "../common";

async function main() {
  const net = networkName();
  banner("atom", net);
  const forceRedeploy = process.env.FORCE_REDEPLOY === "1";
  const rec = loadDeployment("atom", net);
  const bc2 = loadDeployment("atom", "bc2");
  const bc3 = loadDeployment("atom", "bc3");
  rec.chainId = chainIdOf(net);

  const serverAddr = addressOf(PRIVATE_KEYS.atomServer);
  const judgeAddrs = PRIVATE_KEYS.judges.map(addressOf);
  await fundActors([serverAddr, ...judgeAddrs]);

  const community = await deployIfMissing(rec, "atomCommunity", "AtomCommunity", []);
  const service   = await deployIfMissing(rec, "atomService",   "AtomService",   [community]);
  const remoteRegistry = await deployIfMissing(rec, "atomRemoteRegistry", "AtomRemoteRegistry", []);

  // Register server + judges (idempotent via registered flag in record)
  if (!rec.contracts.__server_registered || forceRedeploy) {
    const c = await contractAt("AtomCommunity", community) as any;
    try {
      await (await c.registerServer(serverAddr)).wait();
    } catch (e) { console.log("  [warn] registerServer: ", (e as Error).message); }
    for (const j of judgeAddrs) {
      try { await (await c.registerJudge(j)).wait(); }
      catch (e) { console.log("  [warn] registerJudge:", (e as Error).message); }
    }
    rec.contracts.__server_registered = "1";
    rec.contracts.atomServer = serverAddr;
    rec.contracts.atomJudges = judgeAddrs.join(",");
    writeDeployment(rec);
  }

  await deployIfMissing(rec, "atomTravelEntry", "AtomTravelEntry", [
    service,
    remoteRegistry,
    serverAddr,
    CONSTS.ATOM_JUDGE_NUM_NEED,
    CONSTS.ATOM_JUDGE_NUM_MIN,
    CONSTS.ATOM_MAX_SERVICE_TIME_BLOCKS,
    CONSTS.ATOM_MAX_AUDIT_TIME_BLOCKS,
  ]);
  await deployIfMissing(rec, "atomTravelDepthEntry", "AtomTravelDepthEntry", [
    service,
    remoteRegistry,
    serverAddr,
    CONSTS.ATOM_JUDGE_NUM_NEED,
    CONSTS.ATOM_JUDGE_NUM_MIN,
    CONSTS.ATOM_MAX_SERVICE_TIME_BLOCKS,
    CONSTS.ATOM_MAX_AUDIT_TIME_BLOCKS,
  ]);

  const selector = (signature: string) => web3().eth.abi.encodeFunctionSignature(signature);
  const functionId = (name: string) => web3().utils.keccak256(name);
  const remoteFunctions = [
    {
      id: functionId("hotel-read"),
      chainId: 2,
      contractAddress: bc2.contracts.atomHotel,
      businessUnit: "hotel.getRemain",
      pattern: 1,
      atomicReadSelector: selector("getRemain_atomic(bytes32)"),
      lockDoSelector: "0x00000000",
      unlockSelector: "0x00000000",
      undoUnlockSelector: "0x00000000",
    },
    {
      id: functionId("hotel-write"),
      chainId: 2,
      contractAddress: bc2.contracts.atomHotel,
      businessUnit: "hotel.book",
      pattern: 0,
      atomicReadSelector: "0x00000000",
      lockDoSelector: selector("book_lock_do(bytes32,bytes32,address,uint256)"),
      unlockSelector: selector("book_unlock(bytes32,bytes)"),
      undoUnlockSelector: selector("book_undo_unlock(bytes32,bytes)"),
    },
    {
      id: functionId("train-write"),
      chainId: 3,
      contractAddress: bc3.contracts.atomTrain,
      businessUnit: "train.book",
      pattern: 0,
      atomicReadSelector: "0x00000000",
      lockDoSelector: selector("book_lock_do(bytes32,bytes32,address,uint256,uint256)"),
      unlockSelector: selector("book_unlock(bytes32,bytes)"),
      undoUnlockSelector: selector("book_undo_unlock(bytes32,bytes)"),
    },
    {
      id: functionId("flight-write"),
      chainId: 2,
      contractAddress: bc2.contracts.atomFlight,
      businessUnit: "flight.book",
      pattern: 0,
      atomicReadSelector: "0x00000000",
      lockDoSelector: selector("book_lock_do(bytes32,bytes32,address,uint256)"),
      unlockSelector: selector("book_unlock(bytes32,bytes)"),
      undoUnlockSelector: selector("book_undo_unlock(bytes32,bytes)"),
    },
    {
      id: functionId("taxi-write"),
      chainId: 3,
      contractAddress: bc3.contracts.atomTaxi,
      businessUnit: "taxi.book",
      pattern: 0,
      atomicReadSelector: "0x00000000",
      lockDoSelector: selector("book_lock_do(bytes32,bytes32,address,uint256)"),
      unlockSelector: selector("book_unlock(bytes32,bytes)"),
      undoUnlockSelector: selector("book_undo_unlock(bytes32,bytes)"),
    },
  ];

  for (const remote of remoteFunctions) {
    if (!remote.id || !remote.contractAddress) {
      console.log(`  [warn] skip remote registration for ${remote.businessUnit} (deployment missing)`);
      continue;
    }
    const registered = await readContract("AtomRemoteRegistry", remoteRegistry, "isRegistered", [remote.id]);
    if (registered) {
      console.log(`  [skip] remote function already registered ${remote.businessUnit}`);
      continue;
    }
    console.log(`  [init]   register remote ${remote.businessUnit}`);
    await sendContract("AtomRemoteRegistry", remoteRegistry, "registerRemoteFunction", [
      remote.id,
      remote.chainId,
      remote.contractAddress,
      remote.businessUnit,
      remote.pattern,
      remote.atomicReadSelector,
      remote.lockDoSelector,
      remote.unlockSelector,
      remote.undoUnlockSelector,
    ]);
  }

  if (!rec.contracts.__settlement_seeded || forceRedeploy) {
    console.log("  [init]   seed ATOM settlement terms and bonds");
    await sendContract("AtomService", service, "setSettlementTerms", [
      CONSTS.ATOM_SERVER_REWARD.toString(),
      CONSTS.ATOM_SERVER_PENALTY.toString(),
      CONSTS.ATOM_JUDGE_REWARD.toString(),
      CONSTS.ATOM_JUDGE_PENALTY.toString(),
    ]);
    await sendContract("AtomService", service, "fundRewardPool", [], CONSTS.ATOM_REWARD_POOL);
    await sendContractWithPrivateKey(PRIVATE_KEYS.atomServer, "AtomService", service, "depositBond", [], CONSTS.ATOM_SERVER_BOND);
    for (const judgePk of PRIVATE_KEYS.judges) {
      await sendContractWithPrivateKey(judgePk, "AtomService", service, "depositBond", [], CONSTS.ATOM_JUDGE_BOND);
    }
    rec.contracts.__settlement_seeded = "1";
    writeDeployment(rec);
  }

  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
