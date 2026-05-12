import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ethers } from "hardhat";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { ContractPromise } from "@polkadot/api-contract";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

type Deployment = {
  contracts: Record<string, string>;
};

type SmokeResult = {
  contract: string;
  originalVm: string;
  translatedVm: string;
  pass: boolean;
  detail: Record<string, unknown>;
};

const root = path.resolve(__dirname, "..", "..");
const deploymentPath = path.join(root, "deployments", "xsmart", "rq2-vm.json");
const relayerExe = path.join(root, "relayer", "relayer.exe");
const relayerConfig = path.join(root, "configs", "relayer", "config-xsmart.yaml");
const outPath = path.join(root, "benchmark-results", "rq2", "results", "vm-smoke.json");

function readDeployment(): Deployment {
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8").replace(/^\uFEFF/, "")) as Deployment;
}

function runRelayer(args: string[]): string {
  return execFileSync(relayerExe, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fabricSubmit(endpoint: string, method: string, args: string[] = []): string {
  return runRelayer([
    "fabric-submit",
    "--config",
    relayerConfig,
    "--chain",
    "bc3",
    "--endpoint",
    endpoint,
    "--method",
    method,
    ...args.flatMap((arg) => ["--args", arg]),
  ]);
}

function fabricEvaluate(endpoint: string, method: string, args: string[] = []): string {
  const raw = runRelayer([
    "fabric-evaluate",
    "--config",
    relayerConfig,
    "--chain",
    "bc3",
    "--endpoint",
    endpoint,
    "--method",
    method,
    ...args.flatMap((arg) => ["--args", arg]),
  ]);
  const parsed = JSON.parse(raw);
  return String(parsed.result ?? "");
}

function asString(value: unknown): string {
  if (Array.isArray(value)) return value.map(asString).join(",");
  return String(value);
}

function logStep(message: string) {
  console.log(`[rq2-vm-smoke] ${message}`);
}

function timeout<T>(label: string, ms: number): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

async function waitTx(tx: Promise<any>) {
  await (await tx).wait();
}

async function wasmClient(metadataPath: string, address: string, wsUrl: string) {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const contract = new ContractPromise(api, metadata, address);
  const keyring = new Keyring({ type: "sr25519" });
  const signer = keyring.addFromUri("//Alice");
  const makeAccount = (label: string) => keyring.addFromUri(`//${label}`).address;
  const gasLimit = api.registry.createType("WeightV2", {
    refTime: "500000000000",
    proofSize: "500000",
  });

  async function tx(message: string, args: unknown[]) {
    const factory = (contract.tx as Record<string, any>)[message];
    if (typeof factory !== "function") throw new Error(`missing WASM tx ${message}`);
    const extrinsic = factory({ gasLimit, storageDepositLimit: null }, ...args);
    await Promise.race([new Promise<void>(async (resolve, reject) => {
      let unsub: (() => void) | undefined;
      unsub = await extrinsic.signAndSend(signer, (result: any) => {
        if (result.dispatchError) {
          if (unsub) unsub();
          reject(new Error(result.dispatchError.toString()));
        }
        if (result.status?.isFinalized) {
          if (unsub) unsub();
          resolve();
        }
      });
    }), timeout<void>(`WASM tx ${message}`, 120000)]);
  }

  async function query(message: string, args: unknown[]): Promise<string> {
    const factory = (contract.query as Record<string, any>)[message];
    if (typeof factory !== "function") throw new Error(`missing WASM query ${message}`);
    const result = await factory(signer.address, { gasLimit, storageDepositLimit: null }, ...args);
    if (result.result?.isErr) throw new Error(result.result.asErr.toString());
    const json = result.output?.toJSON();
    if (Array.isArray(json)) return json.map(String).join(",");
    if (json && typeof json === "object" && "ok" in json) return String((json as Record<string, unknown>).ok);
    return result.output?.toString() ?? "";
  }

  return { api, tx, query, alice: signer.address, makeAccount };
}

async function smokeHotel(results: SmokeResult[]) {
  logStep("HotelBooking start");
  const user = `vmhotel-${Date.now()}`;
  fabricSubmit("HotelBooking", "InitLedger", ["Org1MSP", "11", "100", "1"]);
  fabricSubmit("HotelBooking", "BookLocal", [user, "3"]);
  const originalBooking = fabricEvaluate("HotelBooking", "GetBooking", [user]);

  const translated = await ethers.deployContract("HotelBookingTranslated");
  await translated.waitForDeployment();
  await waitTx(translated.__vassp_apply(
    ethers.solidityPackedKeccak256(["string", "string", "string"], ["VASSP", "HotelBooking", "META"]),
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256", "uint256", "uint256"], ["Org1MSP", 11, 100, 1]),
  ));
  await waitTx(translated.BookLocal(user, 3));
  const translatedBooking = asString(await translated.GetBooking(user));

  results.push({
    contract: "HotelBooking",
    originalVm: "Fabric Go bc3",
    translatedVm: "EVM bc1",
    pass: originalBooking === translatedBooking,
    detail: { originalBooking, translatedBooking },
  });
  logStep("HotelBooking done");
}

async function smokeTrain(results: SmokeResult[], d: Deployment) {
  logStep("TrainBooking start");
  const runUser = `rq2-train-${Date.now()}`;
  const wasm = await wasmClient(
    d.contracts.bc2TrainMetadataPath,
    d.contracts.TrainBookingOriginalWasm,
    d.contracts.bc2RpcWs,
  );
  try {
    await wasm.tx("rq2Reset", [wasm.alice, 13, 100, 1]);
    const wasmUser = wasm.makeAccount(runUser);
    await wasm.tx("bookLocal", [wasmUser, 2]);
    const originalBooking = await wasm.query("getBooking", [wasmUser]);

    const translated = await ethers.deployContract("TrainBookingTranslated", ["Org1MSP", 13, 100, 1]);
    await translated.waitForDeployment();
    await waitTx(translated.BookLocal(runUser, 2));
    const translatedBooking = asString(await translated.GetBooking(runUser));
    results.push({
      contract: "TrainBooking",
      originalVm: "WASM/ink! bc2",
      translatedVm: "EVM bc1",
      pass: originalBooking === translatedBooking,
      detail: { originalBooking, translatedBooking },
    });
    logStep("TrainBooking done");
  } finally {
    await wasm.api.disconnect();
  }
}

async function smokeToken(results: SmokeResult[]) {
  logStep("TokenTransfer start");
  const original = await ethers.deployContract("TokenTransferOriginal");
  const translated = await ethers.deployContract("TokenTransferTranslated");
  await original.waitForDeployment();
  await translated.waitForDeployment();
  await waitTx(original.Mint("alice", 100));
  await waitTx(translated.Mint("alice", 100));
  await waitTx(original.Transfer("alice", "bob", 35));
  await waitTx(translated.Transfer("alice", "bob", 35));
  const originalBob = asString(await original.BalanceOf("bob"));
  const translatedBob = asString(await translated.BalanceOf("bob"));
  results.push({
    contract: "TokenTransfer",
    originalVm: "EVM bc1",
    translatedVm: "EVM bc1",
    pass: originalBob === translatedBob,
    detail: { originalBob, translatedBob },
  });
  logStep("TokenTransfer done");
}

async function smokeAuction(results: SmokeResult[]) {
  logStep("AuctionLogic start");
  const id = String(Date.now());
  const seller = `seller-${id}`;
  fabricSubmit("AuctionLogic", "CreateAuction", [id, seller, "10"]);
  fabricSubmit("AuctionLogic", "Bid", [id, "alice", "15"]);
  fabricSubmit("AuctionLogic", "Close", [id]);
  const originalPending = fabricEvaluate("AuctionLogic", "PendingReturn", [seller]);

  const translated = await ethers.deployContract("AuctionLogicTranslated");
  await translated.waitForDeployment();
  await waitTx(translated.CreateAuction(id, seller, 10));
  await waitTx(translated.Bid(id, "alice", 15));
  await waitTx(translated.Close(id));
  const translatedPending = asString(await translated.PendingReturn(seller));
  results.push({
    contract: "AuctionLogic",
    originalVm: "Fabric Go bc3",
    translatedVm: "EVM bc1",
    pass: originalPending === translatedPending,
    detail: { originalPending, translatedPending },
  });
  logStep("AuctionLogic done");
}

async function smokeDex(results: SmokeResult[], d: Deployment) {
  logStep("DEXSwap start");
  const runUser = `rq2-dex-${Date.now()}`;
  const wasm = await wasmClient(
    d.contracts.bc2DexMetadataPath,
    d.contracts.DEXSwapOriginalWasm,
    d.contracts.bc2RpcWs,
  );
  try {
    const wasmUser = wasm.makeAccount(runUser);
    const beforeShares = BigInt(await wasm.query("getShares", [wasmUser]));
    const minted = 12n;
    await wasm.tx("addLiquidity", [wasmUser, 5, 7]);
    const originalDelta = (BigInt(await wasm.query("getShares", [wasmUser])) - beforeShares).toString();

    const translated = await ethers.deployContract("DEXSwapTranslated");
    await translated.waitForDeployment();
    const translatedMinted = asString(await translated.AddLiquidity.staticCall("bob", 5, 7));
    await waitTx(translated.AddLiquidity("bob", 5, 7));
    results.push({
      contract: "DEXSwap",
      originalVm: "WASM/ink! bc2",
      translatedVm: "EVM bc1",
      pass: originalDelta === translatedMinted && originalDelta === minted.toString(),
      detail: { originalDelta, translatedMinted },
    });
    logStep("DEXSwap done");
  } finally {
    await wasm.api.disconnect();
  }
}

async function main() {
  const deployment = readDeployment();
  const results: SmokeResult[] = [];
  await smokeHotel(results);
  await smokeTrain(results, deployment);
  await smokeToken(results);
  await smokeAuction(results);
  await smokeDex(results, deployment);

  const pass = results.filter((r) => r.pass).length;
  const output = {
    schemaVersion: 1,
    rq: "RQ2a",
    mode: "vm-smoke-live-original-vs-translated",
    generatedAt: new Date().toISOString(),
    runs: results.length,
    pass,
    fail: results.length - pass,
    passRate: pass / results.length,
    results,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (pass !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
