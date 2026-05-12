/**
 * Shared helpers for scripts/* deploy scripts.
 *
 * Each deploy script writes to:
 *   deployments/<system>/<network>.json
 * with shape:
 *   { network, system, chainId, contracts: { name → address }, deployedAt }
 *
 * Scripts are IDEMPOTENT: if a contract name already has an address in
 * the JSON, deployment is skipped (re-run-safe).
 *
 * Transport layer: web3.js for signing/sending transactions
 * Compilation layer: Hardhat for artifacts/bytecode only
 */
import hre, { network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import Web3 from "web3";
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from "ethers";

export type System = "integratex" | "atom" | "gpact" | "xsmart";
export type Chain = "bc1" | "bc2" | "bc3";

export interface DeploymentRecord {
  network: string;
  system: System;
  chainId?: number;
  contracts: Record<string, string>;
  deployedAt?: string;
}

export interface ChainRuntimeConfig {
  name: string;
  chainId: number;
  httpUrl: string;
  rpcUrl: string;
}

const BESU_EVM_CHAIN_ID = 1337;
const DEPLOYER_PRIVATE_KEY = "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291";

let web3Cache: Web3 | null = null;
let deployerCache: string | null = null;

export function repoRoot(): string {
  return path.resolve(__dirname, "..");
}

export function deploymentsDir(system: System): string {
  return path.join(repoRoot(), "deployments", system);
}

export function manifestsDir(system: System): string {
  return path.join(repoRoot(), "manifests", system);
}

export function relayerConfigDir(): string {
  return path.join(repoRoot(), "configs", "relayer");
}

export function deploymentFile(system: System, networkName: string): string {
  return path.join(deploymentsDir(system), `${networkName}.json`);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function loadDeployment(system: System, networkName: string): DeploymentRecord {
  const fp = deploymentFile(system, networkName);
  if (!fs.existsSync(fp)) {
    return { network: networkName, system, contracts: {} };
  }
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as DeploymentRecord;
}

export function writeDeployment(rec: DeploymentRecord): void {
  ensureDir(deploymentsDir(rec.system));
  rec.deployedAt = new Date().toISOString();
  fs.writeFileSync(deploymentFile(rec.system, rec.network),
    JSON.stringify(rec, null, 2), "utf-8");
}

export function requireContractAddress(rec: DeploymentRecord, key: string): string {
  const address = rec.contracts[key];
  if (!address) {
    throw new Error(`Deployment ${rec.system}/${rec.network} missing contract ${key}`);
  }
  return address;
}

export function requireAnyContractAddress(rec: DeploymentRecord, keys: string[]): string {
  for (const key of keys) {
    const address = rec.contracts[key];
    if (address) {
      return address;
    }
  }
  throw new Error(
    `Deployment ${rec.system}/${rec.network} missing contracts: ${keys.join(", ")}`
  );
}

function currentRpcUrl(): string {
  const url = (network.config as { url?: string }).url;
  if (!url) {
    throw new Error(`Active network ${network.name} has no RPC url`);
  }
  return url;
}

export function web3(): Web3 {
  if (!web3Cache) {
    web3Cache = new Web3(new Web3.providers.HttpProvider(currentRpcUrl()));
  }
  return web3Cache;
}

export function deployerAddress(): string {
  if (!deployerCache) {
    const w3 = web3();
    const acc = w3.eth.accounts.privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    deployerCache = acc.address;
  }
  return deployerCache;
}

async function sendSigned(web3: Web3, signedTx: string): Promise<any> {
  return new Promise((resolve, reject) => {
    web3.eth.sendSignedTransaction(signedTx)
      .once("receipt", (receipt) => resolve(receipt))
      .on("error", (err) => reject(err));
  });
}

async function signAndSend(web3: Web3, txParams: any, attempt = 0): Promise<any> {
  const from = deployerAddress();
  const acc = web3.eth.accounts.privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
  const maxAttempts = 3;

  txParams.from = from;
  txParams.chainId = BESU_EVM_CHAIN_ID;

  if (txParams.nonce === undefined || txParams.nonce === null) {
    txParams.nonce = await web3.eth.getTransactionCount(from, "pending");
  }
  if (!txParams.gas) {
    txParams.gas = 6000000;
  }
  if (!txParams.gasPrice) {
    txParams.gasPrice = await web3.eth.getGasPrice();
  }

  const signed = await acc.signTransaction(txParams);
  if (!signed.rawTransaction) {
    throw new Error("signTransaction returned null rawTransaction");
  }

  try {
    return await sendSigned(web3, signed.rawTransaction);
  } catch (err: any) {
    const message = String(err?.message ?? "");
    if (attempt + 1 >= maxAttempts || !message.includes("Replacement transaction underpriced")) {
      throw err;
    }

    const currentGasPrice = BigInt(txParams.gasPrice ?? await web3.eth.getGasPrice());
    txParams.gasPrice = (currentGasPrice * 2n).toString();
    txParams.nonce = await web3.eth.getTransactionCount(from, "pending");
    return signAndSend(web3, txParams, attempt + 1);
  }
}

export async function readContract(
  contractName: string,
  address: string,
  method: string,
  args: unknown[] = [],
): Promise<any> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const w3 = web3();
  const contract = new w3.eth.Contract(artifact.abi as any, address);
  const fn = (contract.methods as any)[method];
  if (typeof fn !== "function") {
    throw new Error(`Method ${method} not found on ${contractName}`);
  }
  return fn(...args).call();
}

export async function sendContract(
  contractName: string,
  address: string,
  method: string,
  args: unknown[] = [],
  value?: bigint,
): Promise<any> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const w3 = web3();
  const contract = new w3.eth.Contract(artifact.abi as any, address);
  const fn = (contract.methods as any)[method];
  if (typeof fn !== "function") {
    throw new Error(`Method ${method} not found on ${contractName}`);
  }
  const data = fn(...args).encodeABI();
  const txParams: any = {
    to: address,
    data,
  };
  if (value !== undefined) {
    txParams.value = "0x" + value.toString(16);
  }
  return signAndSend(w3, txParams);
}

export async function sendContractWithPrivateKey(
  privateKey: string,
  contractName: string,
  address: string,
  method: string,
  args: unknown[] = [],
  value?: bigint,
): Promise<any> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const w3 = web3();
  const normalizedPk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  const account = w3.eth.accounts.privateKeyToAccount(normalizedPk);
  const contract = new w3.eth.Contract(artifact.abi as any, address);
  const fn = (contract.methods as any)[method];
  if (typeof fn !== "function") {
    throw new Error(`Method ${method} not found on ${contractName}`);
  }
  const data = fn(...args).encodeABI();
  const txParams: any = {
    to: address,
    data,
    from: account.address,
    chainId: BESU_EVM_CHAIN_ID,
  };
  if (value !== undefined) {
    txParams.value = "0x" + value.toString(16);
  }

  if (!txParams.gas) {
    txParams.gas = 6000000;
  }
  if (!txParams.gasPrice) {
    txParams.gasPrice = await w3.eth.getGasPrice();
  }
  txParams.nonce = await w3.eth.getTransactionCount(account.address, "pending");

  const signed = await account.signTransaction(txParams);
  if (!signed.rawTransaction) {
    throw new Error("signTransaction returned null rawTransaction");
  }
  return sendSigned(w3, signed.rawTransaction);
}

export async function deployIfMissing(
  rec: DeploymentRecord,
  key: string,
  contractName: string,
  args: unknown[],
): Promise<string> {
  const forceRedeploy = process.env.FORCE_REDEPLOY === "1";
  if (rec.contracts[key] && !forceRedeploy) {
    const existing = rec.contracts[key];
    const code = await web3().eth.getCode(existing).catch(() => "0x");
    if (code && code !== "0x" && code !== "0x0") {
      console.log(`  [skip] ${key} already at ${existing}`);
      return existing;
    }
    console.log(`  [stale] ${key} saved at ${existing} but no bytecode found; redeploying`);
  }
  if (rec.contracts[key] && forceRedeploy) {
    console.log(`  [force] ${key} redeploy requested; replacing ${rec.contracts[key]}`);
  }
  console.log(`  [deploy] ${key} (${contractName})`);

  const artifact = await hre.artifacts.readArtifact(contractName);
  const w3 = web3();
  const deployer = w3.eth.accounts.privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

  let encodedConstructor = artifact.bytecode;
  const constructorAbi = artifact.abi.find((i: any) => i.type === "constructor");
  if (constructorAbi && args.length > 0) {
    const paramTypes = constructorAbi.inputs.map((i: any) => i.type);
    const encodedParams = w3.eth.abi.encodeParameters(paramTypes, args).slice(2);
    encodedConstructor += encodedParams;
  }

  const gasEstimate = await w3.eth.estimateGas({
    from: deployer.address,
    data: encodedConstructor,
  }).catch(() => 7000000);

  const txParams = {
    data: encodedConstructor.startsWith("0x") ? encodedConstructor : "0x" + encodedConstructor,
    gas: Math.min(gasEstimate + 200000, 7800000),
  };

  const receipt = await signAndSend(w3, txParams);

  if (!receipt.contractAddress) {
    throw new Error(`Deployment ${key} failed: no contract address in receipt`);
  }

  rec.contracts[key] = receipt.contractAddress;
  writeDeployment(rec);
  console.log(`           → ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

export function networkName(): string {
  if (network.name !== "besu") {
    return network.name;
  }

  const configuredUrl = String((network.config as { url?: string }).url ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/$/, "");
  for (const [chain, cfg] of Object.entries(DEFAULT_CHAIN_CONFIGS)) {
    const httpUrl = cfg.httpUrl.toLowerCase().replace(/\/$/, "");
    const rpcUrl = cfg.rpcUrl.toLowerCase().replace(/\/$/, "");
    if (configuredUrl === httpUrl || configuredUrl === rpcUrl) {
      return chain;
    }
  }

  return network.name;
}

/** Standard private keys reused across the protocol benchmark configs. */
export const PRIVATE_KEYS = {
  relayer: "b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291",
  atomServer: "70ff25649b86772b672f211d338ea82f042683c2bf5901a9a1e542f77110489e",
  judges: [
    "b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291",
    "fbd6535363327d6c7b8fb48481e726ff61a0c16faf20fab3edd4288748a68897",
    "28df2e95c9fb5530abf55ab4d2408c6ce9292db79db60fcc1115ecf1dd327d69",
  ],
};

export function addressOf(pk: string): string {
  const w3 = web3();
  return w3.eth.accounts.privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk).address;
}

export async function contractAt(contractName: string, address: string): Promise<Contract> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const w3 = web3();
  const provider = new JsonRpcProvider(currentRpcUrl());
  const wallet = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
  return new Contract(address, artifact.abi, wallet);
}

export function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

const DEFAULT_CHAIN_CONFIGS: Record<Chain, ChainRuntimeConfig> = {
  bc1: {
    name: "Execution Chain",
    chainId: 1,
    httpUrl: process.env.BC1_HTTP_URL || "http://209.38.21.129:8545",
    rpcUrl: process.env.BC1_RPC_URL || process.env.BC1_WS_URL || "ws://209.38.21.129:8546",
  },
  bc2: {
    name: "Hotel Chain",
    chainId: 2,
    httpUrl: process.env.BC2_HTTP_URL || "http://170.64.194.4:8545",
    rpcUrl: process.env.BC2_RPC_URL || process.env.BC2_WS_URL || "ws://170.64.194.4:8546",
  },
  bc3: {
    name: "Train Chain",
    chainId: 3,
    httpUrl: process.env.BC3_HTTP_URL || "http://170.64.164.173:8545",
    rpcUrl: process.env.BC3_RPC_URL || process.env.BC3_WS_URL || "ws://170.64.164.173:8546",
  },
};

export function chainRuntimeConfig(chain: Chain): ChainRuntimeConfig {
  return DEFAULT_CHAIN_CONFIGS[chain];
}

/** Fund an actor with 1 ETH if balance < 1 ETH. */
export async function fundActor(addr: string): Promise<void> {
  const w3 = web3();
  const from = deployerAddress();
  if (addr.toLowerCase() === from.toLowerCase()) return;

  const balance = await w3.eth.getBalance(addr);
  if (BigInt(balance) >= BigInt("1000000000000000000")) return;

  console.log(`  [fund]  ${addr} ← 1 ETH`);
  await signAndSend(w3, {
    to: addr,
    value: w3.utils.toWei("1", "ether"),
    gas: 21000,
  });
}

export async function fundActors(addrs: string[]): Promise<void> {
  for (const a of addrs) await fundActor(a);
}

/** Print a short header banner. */
export function banner(system: System, chain: string): void {
  console.log("=========================================");
  console.log(` Deploy ${system.toUpperCase()} → ${chain}`);
  console.log("=========================================");
}

/** Print a footer summary listing every deployed address. */
export function summary(rec: DeploymentRecord): void {
  console.log("\n----- Deployment summary -----");
  for (const [k, v] of Object.entries(rec.contracts)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log(`Saved: ${deploymentFile(rec.system, rec.network)}\n`);
}

/** Constants shared across systems. */
export const CONSTS = {
  BRIDGE_TIMEOUT_BLOCKS: 200,
  CROSS_CHAIN_FEE: BigInt("10000000000000000"),
  LIGHT_CLIENT_FINALITY: 1,
  RELAYER_MIN_STAKE: BigInt("1000000000000000000"),
  RELAYER_REWARD: BigInt("5000000000000000"),
  RELAYER_PENALTY: BigInt("500000000000000000"),
  ATOM_JUDGE_NUM_NEED: 3,
  ATOM_JUDGE_NUM_MIN: 3,
  ATOM_MAX_SERVICE_TIME_BLOCKS: 20,
  ATOM_MAX_AUDIT_TIME_BLOCKS: 20,
  ATOM_SERVER_REWARD: BigInt("10000000000000000"),
  ATOM_SERVER_PENALTY: BigInt("20000000000000000"),
  ATOM_JUDGE_REWARD: BigInt("5000000000000000"),
  ATOM_JUDGE_PENALTY: BigInt("10000000000000000"),
  ATOM_REWARD_POOL: BigInt("1000000000000000000"),
  ATOM_SERVER_BOND: BigInt("100000000000000000"),
  ATOM_JUDGE_BOND: BigInt("50000000000000000"),
  GPACT_SIGNER_QUORUM: 3,
  HOTEL_PRICE: 100,
  HOTEL_REMAIN: 2000,
  TRAIN_PRICE: 50,
  TRAIN_SEATS: 2000,
  FLIGHT_PRICE: 200,
  FLIGHT_SEATS: 2000,
  TAXI_PRICE: 20,
  TAXI_CARS: 2000,
  LOCK_SIZE: 1,
  DAPP_TIMEOUT_BLOCKS: 30,
};

/** Per-chain integer ID (matches configs/relayer/config-*.yaml). */
export function chainIdOf(net: string): number {
  if (net === "bc1") return 1;
  if (net === "bc2") return 2;
  if (net === "bc3") return 3;
  return 0;
}
