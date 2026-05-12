import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ethers } from "hardhat";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { ContractPromise } from "@polkadot/api-contract";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { canonicalSnapshot, SnapshotEntry } from "./canonical-snapshot";
import {
  AuctionOperation,
  ContractName,
  DexOperation,
  Rq2Case,
  TokenInitialState,
  TokenOperation,
} from "./rq2-models";
import { HotelInitialState, HotelOperation, OperationResult } from "./hotel-booking-model";

type Deployment = { contracts: Record<string, string> };
type CaseResult = {
  caseId: string;
  seed: number;
  pass: boolean;
  failCategory?: string;
  failReason?: string;
  operationIndex?: number;
  originalSnapshotHash?: string;
  translatedSnapshotHash?: string;
};

type WasmClient = Awaited<ReturnType<typeof wasmClient>>;

const root = path.resolve(__dirname, "..", "..");
const deploymentPath = path.join(root, "deployments", "xsmart", "rq2-vm.json");
const relayerExe = path.join(root, "relayer", "relayer.exe");
const relayerConfig = path.join(root, "configs", "relayer", "config-xsmart.yaml");

function arg(name: string, fallback: string) {
  const env = process.env[`RQ2_${name.replace(/-/g, "_").toUpperCase()}`];
  if (env && env.trim()) return env.trim();
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeContract(value: string): ContractName {
  const v = value.toLowerCase().replace(/[-_]/g, "");
  if (v === "hotelbooking") return "HotelBooking";
  if (v === "trainbooking") return "TrainBooking";
  if (v === "tokentransfer") return "TokenTransfer";
  if (v === "auctionlogic") return "AuctionLogic";
  if (v === "dexswap") return "DEXSwap";
  throw new Error(`unsupported contract ${value}`);
}

function loadDeployment(): Deployment {
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8").replace(/^\uFEFF/, ""));
}

function readCases(file: string, limit: number): Rq2Case[] {
  const all = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Rq2Case);
  return limit > 0 ? all.slice(0, limit) : all;
}

function runRelayer(args: string[]): string {
  return execFileSync(relayerExe, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fabric(endpoint: string, method: string, args_: string[], submit: boolean): OperationResult {
  try {
    const raw = runRelayer([
      submit ? "fabric-submit" : "fabric-evaluate",
      "--config", relayerConfig,
      "--chain", "bc3",
      "--endpoint", endpoint,
      "--method", method,
      ...args_.flatMap((v) => ["--args", v]),
    ]);
    const parsed = JSON.parse(raw);
    return { ok: parsed.ok === true, returnValues: parsed.result === undefined ? [] : [String(parsed.result)] };
  } catch (e) {
    return { ok: false, returnValues: [], error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

function resultValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function normalizeReturn(result: OperationResult): OperationResult {
  return { ...result, returnValues: result.returnValues.map((v) => {
    if (v === "true" || v === "false") return v;
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "boolean") return String(parsed);
      if (typeof parsed === "number") return String(parsed);
    } catch {
    }
    return v;
  }) };
}

function compareOp(a: OperationResult, b: OperationResult, compareReturns = true): string | null {
  const left = normalizeReturn(a);
  const right = normalizeReturn(b);
  if (left.ok !== right.ok) {
    return `status mismatch original=${left.ok} translated=${right.ok} originalError=${left.error ?? ""} translatedError=${right.error ?? ""}`;
  }
  if (!left.ok || !compareReturns) return null;
  if (left.returnValues.length !== right.returnValues.length) {
    return `return length mismatch original=${left.returnValues.join(",")} translated=${right.returnValues.join(",")}`;
  }
  for (let i = 0; i < left.returnValues.length; i++) {
    if (left.returnValues[i] !== right.returnValues[i]) {
      return `return mismatch at ${i}: original=${left.returnValues[i]} translated=${right.returnValues[i]}`;
    }
  }
  return null;
}

function isMutatingTravelOperation(kind: string) {
  return kind === "BookLocal" || kind === "LockState" || kind === "UnlockState";
}

function isMutatingAuctionOperation(kind: string) {
  return kind === "CreateAuction" || kind === "Bid" || kind === "Close" || kind === "Withdraw";
}

function isMutatingDexOperation(kind: string) {
  return kind === "AddLiquidity" || kind === "RemoveLiquidity" || kind === "SwapAForB";
}

async function txResult(fn: () => Promise<any>, call?: () => Promise<any>): Promise<OperationResult> {
  try {
    const value = call ? await call() : undefined;
    const tx = await fn();
    await tx.wait();
    return { ok: true, returnValues: resultValues(value) };
  } catch (e) {
    return { ok: false, returnValues: [], error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

async function viewResult(fn: () => Promise<any>): Promise<OperationResult> {
  try {
    return { ok: true, returnValues: resultValues(await fn()) };
  } catch (e) {
    return { ok: false, returnValues: [], error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

async function wasmClient(metadataPath: string, address: string, wsUrl: string) {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const contract = new ContractPromise(api, metadata, address);
  const keyring = new Keyring({ type: "sr25519" });
  const signer = keyring.addFromUri("//Alice");
  const gasLimit = api.registry.createType("WeightV2", { refTime: "500000000000", proofSize: "500000" });
  const account = (label: string) => keyring.addFromUri(`//${label}`).address;

  function decodeOutput(output: any): OperationResult {
    const json = output?.toJSON();
    if (json && typeof json === "object" && "err" in json) {
      return { ok: false, returnValues: [], error: JSON.stringify((json as any).err) };
    }
    const value = json && typeof json === "object" && "ok" in json ? (json as any).ok : json;
    if (Array.isArray(value)) return { ok: true, returnValues: value.map(String) };
    if (value === undefined || value === null) return { ok: true, returnValues: [] };
    return { ok: true, returnValues: [String(value)] };
  }

  async function query(message: string, args_: unknown[]): Promise<OperationResult> {
    try {
      const factory = (contract.query as Record<string, any>)[message];
      if (typeof factory !== "function") throw new Error(`missing WASM query ${message}`);
      const out = await factory(signer.address, { gasLimit, storageDepositLimit: null }, ...args_);
      if (out.result?.isErr) return { ok: false, returnValues: [], error: out.result.asErr.toString() };
      return decodeOutput(out.output);
    } catch (e) {
      return { ok: false, returnValues: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function tx(message: string, args_: unknown[], dryRun = true): Promise<OperationResult> {
    const predicted = dryRun ? await query(message, args_) : { ok: true, returnValues: [] };
    if (!predicted.ok) return predicted;
    try {
      const factory = (contract.tx as Record<string, any>)[message];
      if (typeof factory !== "function") throw new Error(`missing WASM tx ${message}`);
      const extrinsic = factory({ gasLimit, storageDepositLimit: null }, ...args_);
      await new Promise<void>(async (resolve, reject) => {
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
      });
      return predicted;
    } catch (e) {
      return { ok: false, returnValues: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { api, account, query, tx };
}

function travelUsers(ops: HotelOperation[]) {
  return [...new Set(ops.flatMap((o) => "user" in o ? [o.user] : []))];
}
function travelLocks(ops: HotelOperation[]) {
  return [...new Set(ops.flatMap((o) => "lockId" in o ? [o.lockId] : []))];
}

function tokenUsers(ops: TokenOperation[], initial: TokenInitialState) {
  const out = new Set(Object.keys(initial.balances));
  for (const o of ops) {
    if ("user" in o) out.add(o.user);
    if ("to" in o) out.add(o.to);
    if ("from" in o) out.add(o.from);
    if ("owner" in o) out.add(o.owner);
    if ("spender" in o) out.add(o.spender);
  }
  return [...out];
}
function tokenPairs(ops: TokenOperation[]) {
  const out = new Set<string>();
  for (const o of ops) {
    if (o.kind === "Approve" || o.kind === "Allowance") out.add(`${o.owner}\u0000${o.spender}`);
    if (o.kind === "TransferFrom") out.add(`${o.from}\u0000${o.spender}`);
  }
  return [...out];
}

function auctionIds(ops: AuctionOperation[]) {
  return [...new Set(ops.flatMap((o) => "id" in o ? [o.id] : []))];
}
function auctionUsers(ops: AuctionOperation[]) {
  return [...new Set(ops.flatMap((o) => {
    const users: string[] = [];
    if ("seller" in o) users.push(o.seller);
    if ("bidder" in o) users.push(o.bidder);
    if ("user" in o) users.push(o.user);
    return users;
  }))];
}
function dexUsers(ops: DexOperation[]) {
  return [...new Set(ops.flatMap((o) => "user" in o ? [o.user] : []))];
}

function ns(prefix: string, value: string) {
  return `${prefix}-${value}`;
}

function lockNumber(caseIndex: number, lockId: string) {
  const suffix = lockId.endsWith("a") ? 1 : lockId.endsWith("b") ? 2 : 3;
  return caseIndex * 10 + suffix;
}

function namespaceNumber(namespace: string) {
  let hash = 2166136261;
  for (let i = 0; i < namespace.length; i++) {
    hash ^= namespace.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100000000;
}

function namespaceBigInt(namespace: string) {
  return BigInt(namespaceNumber(namespace));
}

function namespacedCaseId(runNamespace: string, caseId: string) {
  return `${runNamespace}-${caseId}`;
}

async function initHotelTranslated(contract: any, initial: HotelInitialState) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  await (await contract.__vassp_apply(
    ethers.solidityPackedKeccak256(["string", "string", "string"], ["VASSP", "HotelBooking", "META"]),
    coder.encode(["string", "uint256", "uint256", "uint256"], [initial.bridge, initial.price, initial.remain, initial.lockSize]),
  )).wait();
  await (await contract.__vassp_apply(
    ethers.solidityPackedKeccak256(["string", "string", "string"], ["VASSP", "HotelBooking", "LOCK_TOTAL"]),
    coder.encode(["uint256"], [0]),
  )).wait();
}

async function runHotel(testCase: Rq2Case, contracts: Record<string, string>, runNamespace: string): Promise<CaseResult> {
  const prefix = namespacedCaseId(runNamespace, testCase.caseId);
  const initial = testCase.initial as HotelInitialState;
  const ops = (testCase.operations as HotelOperation[]).map((o) => {
    const copy: any = { ...o };
    if ("user" in copy) copy.user = ns(prefix, copy.user);
    if ("lockId" in copy) copy.lockId = ns(prefix, copy.lockId);
    return copy as HotelOperation;
  });
  const translated = await ethers.getContractAt("HotelBookingTranslated", contracts.HotelBookingTranslated);
  fabric("HotelBooking", "InitLedger", [initial.bridge, initial.price, initial.remain, initial.lockSize], true);
  await initHotelTranslated(translated, initial);
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    let a: OperationResult;
    let b: OperationResult;
    if (o.kind === "BookLocal") {
      a = fabric("HotelBooking", "BookLocal", [o.user, o.amount], true);
      b = await txResult(() => translated.BookLocal(o.user, o.amount), () => translated.BookLocal.staticCall(o.user, o.amount));
    } else if (o.kind === "LockState") {
      a = fabric("HotelBooking", "LockState", [o.lockId, o.amount, o.timeoutBlocks], true);
      b = await txResult(() => translated.LockState(o.lockId, o.amount, o.timeoutBlocks), () => translated.LockState.staticCall(o.lockId, o.amount, o.timeoutBlocks));
    } else if (o.kind === "UnlockState") {
      a = fabric("HotelBooking", "UnlockState", [o.lockId], true);
      b = await txResult(() => translated.UnlockState(o.lockId));
    } else {
      a = fabric("HotelBooking", o.kind, "user" in o ? [o.user] : "lockId" in o ? [o.lockId] : [], false);
      const fn = (translated as any)[o.kind];
      b = await viewResult(() => "user" in o ? fn(o.user) : "lockId" in o ? fn(o.lockId) : fn());
    }
    const mismatch = compareOp(a, b, !isMutatingTravelOperation(o.kind));
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "operation_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = travelUsers(ops);
  const locks = travelLocks(ops);
  const entriesA: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: fabric("HotelBooking", "GetBridge", [], false).returnValues[0] ?? "" } },
    { key: "meta.price", value: { type: "uint256", value: fabric("HotelBooking", "GetPrice", [], false).returnValues[0] ?? "0" } },
    { key: "meta.remain", value: { type: "uint256", value: fabric("HotelBooking", "GetRemain", [], false).returnValues[0] ?? "0" } },
    { key: "meta.lockSize", value: { type: "uint256", value: fabric("HotelBooking", "GetLockSize", [], false).returnValues[0] ?? "0" } },
    { key: "availableRemain", value: { type: "uint256", value: fabric("HotelBooking", "GetAvailableRemain", [], false).returnValues[0] ?? "0" } },
    { key: "lockedTotal", value: { type: "uint256", value: fabric("HotelBooking", "GetLockedTotal", [], false).returnValues[0] ?? "0" } },
  ];
  const entriesB: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: initial.bridge } },
    { key: "meta.price", value: { type: "uint256", value: await translated.GetPrice() } },
    { key: "meta.remain", value: { type: "uint256", value: await translated.GetRemain() } },
    { key: "meta.lockSize", value: { type: "uint256", value: initial.lockSize } },
    { key: "availableRemain", value: { type: "uint256", value: await translated.GetAvailableRemain() } },
    { key: "lockedTotal", value: { type: "uint256", value: await translated.GetLockedTotal() } },
  ];
  for (const u of users.sort()) {
    entriesA.push({ key: `accounts.${u}`, value: { type: "uint256", value: fabric("HotelBooking", "GetAccountBalance", [u], false).returnValues[0] ?? "0" } });
    entriesA.push({ key: `bookings.${u}`, value: { type: "uint256", value: fabric("HotelBooking", "GetBooking", [u], false).returnValues[0] ?? "0" } });
    entriesB.push({ key: `accounts.${u}`, value: { type: "uint256", value: await translated.GetAccountBalance(u) } });
    entriesB.push({ key: `bookings.${u}`, value: { type: "uint256", value: await translated.GetBooking(u) } });
  }
  for (const l of locks.sort()) {
    entriesA.push({ key: `locks.${l}.active`, value: { type: "bool", value: fabric("HotelBooking", "IsStateLocked", [l], false).returnValues[0] ?? "false" } });
    entriesA.push({ key: `locks.${l}.lockedAmount`, value: { type: "uint256", value: fabric("HotelBooking", "GetLockAmount", [l], false).returnValues[0] ?? "0" } });
    entriesB.push({ key: `locks.${l}.active`, value: { type: "bool", value: await translated.IsStateLocked(l) } });
    entriesB.push({ key: `locks.${l}.lockedAmount`, value: { type: "uint256", value: await translated.GetLockAmount(l) } });
  }
  const sa = canonicalSnapshot("HotelBooking", entriesA);
  const sb = canonicalSnapshot("HotelBooking", entriesB);
  return { caseId: testCase.caseId, seed: testCase.seed, pass: sa.bytesHex === sb.bytesHex, failCategory: sa.bytesHex === sb.bytesHex ? undefined : "state_mismatch", failReason: sa.bytesHex === sb.bytesHex ? undefined : "canonical snapshot bytes differ", originalSnapshotHash: sa.hash, translatedSnapshotHash: sb.hash };
}

async function runToken(testCase: Rq2Case, contracts: Record<string, string>, runNamespace: string): Promise<CaseResult> {
  const prefix = namespacedCaseId(runNamespace, testCase.caseId);
  const initial = testCase.initial as TokenInitialState;
  const ops = (testCase.operations as TokenOperation[]).map((o) => {
    const copy: any = { ...o };
    for (const k of ["user", "to", "from", "owner", "spender"]) if (copy[k]) copy[k] = ns(prefix, copy[k]);
    return copy as TokenOperation;
  });
  const original = await ethers.getContractAt("TokenTransferOriginal", contracts.TokenTransferOriginal);
  const translated = await ethers.getContractAt("TokenTransferTranslated", contracts.TokenTransferTranslated);
  await (await original.Rq2Reset()).wait();
  await (await translated.Rq2Reset()).wait();
  for (const [user, amount] of Object.entries(initial.balances)) {
    const u = ns(prefix, user);
    if (BigInt(amount) > 0n) {
      await (await original.Mint(u, amount)).wait();
      await (await translated.Mint(u, amount)).wait();
    }
  }
  for (let i = 0; i < ops.length; i++) {
    const o: any = ops[i];
    const name = o.kind;
    const args_ = name === "Mint" ? [o.to, o.amount] : name === "Transfer" ? [o.from, o.to, o.amount] : name === "Approve" ? [o.owner, o.spender, o.amount] : name === "TransferFrom" ? [o.spender, o.from, o.to, o.amount] : name === "BalanceOf" ? [o.user] : name === "Allowance" ? [o.owner, o.spender] : [];
    const mutates = ["Mint", "Transfer", "Approve", "TransferFrom"].includes(name);
    const a = mutates ? await txResult(() => (original as any)[name](...args_)) : await viewResult(() => (original as any)[name](...args_));
    const b = mutates ? await txResult(() => (translated as any)[name](...args_)) : await viewResult(() => (translated as any)[name](...args_));
    const mismatch = compareOp(a, b);
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "operation_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = tokenUsers(ops, { balances: Object.fromEntries(Object.keys(initial.balances).map((u) => [ns(prefix, u), initial.balances[u]])) });
  const pairs = tokenPairs(ops);
  const ea: SnapshotEntry[] = [{ key: "totalSupply", value: { type: "uint256", value: await original.TotalSupply() } }];
  const eb: SnapshotEntry[] = [{ key: "totalSupply", value: { type: "uint256", value: await translated.TotalSupply() } }];
  for (const u of users.sort()) {
    ea.push({ key: `balances.${u}`, value: { type: "uint256", value: await original.BalanceOf(u) } });
    eb.push({ key: `balances.${u}`, value: { type: "uint256", value: await translated.BalanceOf(u) } });
  }
  for (const p of pairs.sort()) {
    const [owner, spender] = p.split("\u0000");
    ea.push({ key: `allowances.${p}`, value: { type: "uint256", value: await original.Allowance(owner, spender) } });
    eb.push({ key: `allowances.${p}`, value: { type: "uint256", value: await translated.Allowance(owner, spender) } });
  }
  const sa = canonicalSnapshot("TokenTransfer", ea);
  const sb = canonicalSnapshot("TokenTransfer", eb);
  return { caseId: testCase.caseId, seed: testCase.seed, pass: sa.bytesHex === sb.bytesHex, failCategory: sa.bytesHex === sb.bytesHex ? undefined : "state_mismatch", failReason: sa.bytesHex === sb.bytesHex ? undefined : "canonical snapshot bytes differ", originalSnapshotHash: sa.hash, translatedSnapshotHash: sb.hash };
}

async function runAuction(testCase: Rq2Case, contracts: Record<string, string>, runNamespace: string): Promise<CaseResult> {
  const prefix = namespacedCaseId(runNamespace, testCase.caseId);
  const rawOps = testCase.operations as AuctionOperation[];
  const rawIds = auctionIds(rawOps).sort();
  const idMap = new Map(rawIds.map((id, index) => [id, namespaceBigInt(`${prefix}-${id}`) * 1000n + BigInt(index + 1)]));
  const opsOriginal = rawOps.map((o) => {
    const copy: any = { ...o };
    if (copy.id) copy.id = ns(prefix, copy.id);
    for (const k of ["seller", "bidder", "user"]) if (copy[k]) copy[k] = ns(prefix, copy[k]);
    return copy as AuctionOperation;
  });
  const opsTranslated = rawOps.map((o) => {
    const copy: any = { ...o };
    if (copy.id) copy.id = idMap.get(copy.id);
    for (const k of ["seller", "bidder", "user"]) if (copy[k]) copy[k] = ns(prefix, copy[k]);
    return copy as AuctionOperation;
  });
  const translated = await ethers.getContractAt("AuctionLogicTranslated", contracts.AuctionLogicTranslated);
  for (let i = 0; i < opsOriginal.length; i++) {
    const originalOp: any = opsOriginal[i];
    const translatedOp: any = opsTranslated[i];
    const argsOriginal = originalOp.kind === "CreateAuction" ? [originalOp.id, originalOp.seller, originalOp.minPrice] : originalOp.kind === "Bid" ? [originalOp.id, originalOp.bidder, originalOp.amount] : originalOp.kind === "Close" ? [originalOp.id] : originalOp.kind === "Withdraw" || originalOp.kind === "PendingReturn" ? [originalOp.user] : [originalOp.id];
    const argsTranslated = translatedOp.kind === "CreateAuction" ? [translatedOp.id, translatedOp.seller, translatedOp.minPrice] : translatedOp.kind === "Bid" ? [translatedOp.id, translatedOp.bidder, translatedOp.amount] : translatedOp.kind === "Close" ? [translatedOp.id] : translatedOp.kind === "Withdraw" || translatedOp.kind === "PendingReturn" ? [translatedOp.user] : [translatedOp.id];
    const mutates = ["CreateAuction", "Bid", "Close", "Withdraw"].includes(originalOp.kind);
    const a = fabric("AuctionLogic", originalOp.kind, argsOriginal.map(String), mutates);
    const b = mutates ? await txResult(() => (translated as any)[translatedOp.kind](...argsTranslated), translatedOp.kind === "Withdraw" ? () => translated.Withdraw.staticCall(translatedOp.user) : undefined) : await viewResult(() => (translated as any)[translatedOp.kind](...argsTranslated));
    const mismatch = compareOp(a, b, !isMutatingAuctionOperation(originalOp.kind) && originalOp.kind !== "GetAuction");
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "operation_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = auctionUsers(opsOriginal);
  const ea: SnapshotEntry[] = [];
  const eb: SnapshotEntry[] = [];
  for (const rawId of rawIds) {
    const logicalId = ns(prefix, rawId);
    const a = JSON.parse(fabric("AuctionLogic", "GetAuction", [logicalId], false).returnValues[0] ?? "{}");
    const b = await translated.GetAuction(idMap.get(rawId));
    ea.push({ key: `auction.${logicalId}.seller`, value: { type: "string", value: a.seller ?? "" } });
    ea.push({ key: `auction.${logicalId}.minPrice`, value: { type: "uint256", value: a.minPrice ?? 0 } });
    ea.push({ key: `auction.${logicalId}.highestBidder`, value: { type: "string", value: a.highestBidder ?? "" } });
    ea.push({ key: `auction.${logicalId}.highestBid`, value: { type: "uint256", value: a.highestBid ?? 0 } });
    ea.push({ key: `auction.${logicalId}.open`, value: { type: "bool", value: a.open === true } });
    ea.push({ key: `auction.${logicalId}.exists`, value: { type: "bool", value: a.exists === true } });
    eb.push({ key: `auction.${logicalId}.seller`, value: { type: "string", value: b[0] } });
    eb.push({ key: `auction.${logicalId}.minPrice`, value: { type: "uint256", value: b[1] } });
    eb.push({ key: `auction.${logicalId}.highestBidder`, value: { type: "string", value: b[2] } });
    eb.push({ key: `auction.${logicalId}.highestBid`, value: { type: "uint256", value: b[3] } });
    eb.push({ key: `auction.${logicalId}.open`, value: { type: "bool", value: b[4] } });
    eb.push({ key: `auction.${logicalId}.exists`, value: { type: "bool", value: b[5] } });
  }
  for (const u of users.sort()) {
    ea.push({ key: `pending.${u}`, value: { type: "uint256", value: fabric("AuctionLogic", "PendingReturn", [u], false).returnValues[0] ?? "0" } });
    eb.push({ key: `pending.${u}`, value: { type: "uint256", value: await translated.PendingReturn(u) } });
  }
  const sa = canonicalSnapshot("AuctionLogic", ea);
  const sb = canonicalSnapshot("AuctionLogic", eb);
  return { caseId: testCase.caseId, seed: testCase.seed, pass: sa.bytesHex === sb.bytesHex, failCategory: sa.bytesHex === sb.bytesHex ? undefined : "state_mismatch", failReason: sa.bytesHex === sb.bytesHex ? undefined : "canonical snapshot bytes differ", originalSnapshotHash: sa.hash, translatedSnapshotHash: sb.hash };
}

async function runTrain(testCase: Rq2Case, contracts: Record<string, string>, wasm: WasmClient, caseIndex: number, runNamespace: string): Promise<CaseResult> {
  const initial = testCase.initial as HotelInitialState;
  const ops = testCase.operations as HotelOperation[];
  const translated = await ethers.getContractAt("TrainBookingTranslated", contracts.TrainBookingTranslated);
  await wasm.tx("rq2Reset", [wasm.account("Alice"), initial.price, initial.remain, initial.lockSize], false);
  await (await translated.Rq2Reset(initial.bridge, initial.price, initial.remain, initial.lockSize)).wait();
  const prefix = namespacedCaseId(runNamespace, testCase.caseId);
  const lockBase = namespaceNumber(runNamespace) * 1000000;
  const userMap = (u: string) => wasm.account(`${prefix}-${u}`);
  const lockMap = (lockId: string) => lockBase + lockNumber(caseIndex, lockId);
  for (let i = 0; i < ops.length; i++) {
    const o: any = ops[i];
    let a: OperationResult;
    let b: OperationResult;
    if (o.kind === "BookLocal") {
      const u = userMap(o.user);
      a = await wasm.tx("bookLocal", [u, o.amount]);
      b = await txResult(() => translated.BookLocal(u, o.amount), () => translated.BookLocal.staticCall(u, o.amount));
    } else if (o.kind === "LockState") {
      const id = String(lockMap(o.lockId));
      a = await wasm.tx("lockState", [Number(id), o.amount, o.timeoutBlocks]);
      b = await txResult(() => translated.LockState(id, o.amount, o.timeoutBlocks), () => translated.LockState.staticCall(id, o.amount, o.timeoutBlocks));
    } else if (o.kind === "UnlockState") {
      const id = String(lockMap(o.lockId));
      a = await wasm.tx("unlockState", [Number(id)]);
      b = await txResult(() => translated.UnlockState(id));
    } else {
      const method = o.kind.charAt(0).toLowerCase() + o.kind.slice(1);
      const args_ = "user" in o ? [userMap(o.user)] : "lockId" in o ? [lockMap(o.lockId)] : [];
      a = await wasm.query(method, args_);
      const fn = (translated as any)[o.kind];
      b = await viewResult(() => "user" in o ? fn(userMap(o.user)) : "lockId" in o ? fn(String(lockMap(o.lockId))) : fn());
    }
    const mismatch = compareOp(a, b, !isMutatingTravelOperation(o.kind));
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "operation_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = travelUsers(ops).map(userMap);
  const locks = travelLocks(ops).map((l) => String(lockMap(l)));
  const ea: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: initial.bridge } },
    { key: "meta.price", value: { type: "uint256", value: (await wasm.query("getPrice", [])).returnValues[0] ?? "0" } },
    { key: "meta.remain", value: { type: "uint256", value: (await wasm.query("getRemain", [])).returnValues[0] ?? "0" } },
    { key: "meta.lockSize", value: { type: "uint256", value: initial.lockSize } },
    { key: "availableRemain", value: { type: "uint256", value: (await wasm.query("getAvailableRemain", [])).returnValues[0] ?? "0" } },
    { key: "lockedTotal", value: { type: "uint256", value: (await wasm.query("getLockedTotal", [])).returnValues[0] ?? "0" } },
  ];
  const eb: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: initial.bridge } },
    { key: "meta.price", value: { type: "uint256", value: await translated.GetPrice() } },
    { key: "meta.remain", value: { type: "uint256", value: await translated.GetRemain() } },
    { key: "meta.lockSize", value: { type: "uint256", value: initial.lockSize } },
    { key: "availableRemain", value: { type: "uint256", value: await translated.GetAvailableRemain() } },
    { key: "lockedTotal", value: { type: "uint256", value: await translated.GetLockedTotal() } },
  ];
  for (const u of users.sort()) {
    ea.push({ key: `accounts.${u}`, value: { type: "uint256", value: (await wasm.query("getAccountBalance", [u])).returnValues[0] ?? "0" } });
    ea.push({ key: `bookings.${u}`, value: { type: "uint256", value: (await wasm.query("getBooking", [u])).returnValues[0] ?? "0" } });
    eb.push({ key: `accounts.${u}`, value: { type: "uint256", value: await translated.GetAccountBalance(u) } });
    eb.push({ key: `bookings.${u}`, value: { type: "uint256", value: await translated.GetBooking(u) } });
  }
  for (const l of locks.sort()) {
    ea.push({ key: `locks.${l}.active`, value: { type: "bool", value: (await wasm.query("isStateLocked", [Number(l)])).returnValues[0] ?? "false" } });
    ea.push({ key: `locks.${l}.lockedAmount`, value: { type: "uint256", value: (await wasm.query("getLockAmount", [Number(l)])).returnValues[0] ?? "0" } });
    eb.push({ key: `locks.${l}.active`, value: { type: "bool", value: await translated.IsStateLocked(l) } });
    eb.push({ key: `locks.${l}.lockedAmount`, value: { type: "uint256", value: await translated.GetLockAmount(l) } });
  }
  const sa = canonicalSnapshot("TrainBooking", ea);
  const sb = canonicalSnapshot("TrainBooking", eb);
  return { caseId: testCase.caseId, seed: testCase.seed, pass: sa.bytesHex === sb.bytesHex, failCategory: sa.bytesHex === sb.bytesHex ? undefined : "state_mismatch", failReason: sa.bytesHex === sb.bytesHex ? undefined : "canonical snapshot bytes differ", originalSnapshotHash: sa.hash, translatedSnapshotHash: sb.hash };
}

async function runDex(testCase: Rq2Case, contracts: Record<string, string>, wasm: WasmClient, runNamespace: string): Promise<CaseResult> {
  const prefix = namespacedCaseId(runNamespace, testCase.caseId);
  const ops = (testCase.operations as DexOperation[]).map((o) => {
    const copy: any = { ...o };
    if (copy.user) copy.user = wasm.account(`${prefix}-${copy.user}`);
    return copy as DexOperation;
  });
  const translated = await ethers.getContractAt("DEXSwapTranslated", contracts.DEXSwapTranslated);
  await wasm.tx("rq2Reset", [], false);
  await (await translated.Rq2Reset()).wait();
  for (let i = 0; i < ops.length; i++) {
    const o: any = ops[i];
    const method = o.kind.charAt(0).toLowerCase() + o.kind.slice(1);
    const args_ = o.kind === "AddLiquidity" ? [o.user, o.amountA, o.amountB] : o.kind === "RemoveLiquidity" ? [o.user, o.shares] : o.kind === "SwapAForB" ? [o.user, o.amountIn] : o.kind === "GetShares" ? [o.user] : [];
    const mutates = ["AddLiquidity", "RemoveLiquidity", "SwapAForB"].includes(o.kind);
    const a = mutates ? await wasm.tx(method, args_) : await wasm.query(method, args_);
    const b = mutates ? await txResult(() => (translated as any)[o.kind](...args_), () => (translated as any)[o.kind].staticCall(...args_)) : await viewResult(() => (translated as any)[o.kind](...args_));
    const mismatch = compareOp(a, b, !isMutatingDexOperation(o.kind));
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "operation_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = dexUsers(ops);
  const reservesA = (await wasm.query("getReserves", [])).returnValues;
  const reservesB = await translated.GetReserves();
  const ea: SnapshotEntry[] = [
    { key: "reserveA", value: { type: "uint256", value: reservesA[0] ?? "0" } },
    { key: "reserveB", value: { type: "uint256", value: reservesA[1] ?? "0" } },
    { key: "totalShares", value: { type: "uint256", value: (await wasm.query("totalShares", [])).returnValues[0] ?? "0" } },
  ];
  const eb: SnapshotEntry[] = [
    { key: "reserveA", value: { type: "uint256", value: reservesB[0] } },
    { key: "reserveB", value: { type: "uint256", value: reservesB[1] } },
    { key: "totalShares", value: { type: "uint256", value: await translated.TotalShares() } },
  ];
  for (const u of users.sort()) {
    ea.push({ key: `shares.${u}`, value: { type: "uint256", value: (await wasm.query("getShares", [u])).returnValues[0] ?? "0" } });
    eb.push({ key: `shares.${u}`, value: { type: "uint256", value: await translated.GetShares(u) } });
  }
  const sa = canonicalSnapshot("DEXSwap", ea);
  const sb = canonicalSnapshot("DEXSwap", eb);
  return { caseId: testCase.caseId, seed: testCase.seed, pass: sa.bytesHex === sb.bytesHex, failCategory: sa.bytesHex === sb.bytesHex ? undefined : "state_mismatch", failReason: sa.bytesHex === sb.bytesHex ? undefined : "canonical snapshot bytes differ", originalSnapshotHash: sa.hash, translatedSnapshotHash: sb.hash };
}

function writeOutput(file: string, payload: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

async function main() {
  const contract = normalizeContract(arg("contract", "HotelBooking"));
  const limit = Number(arg("limit", "1000"));
  const casesPath = arg("cases", path.join("benchmark-results", "rq2", "cases", `${contract.toLowerCase()}.jsonl`));
  const out = arg("out", path.join("benchmark-results", "rq2", "results", `${contract}-vm-full.json`));
  const failures = arg("failures", path.join("benchmark-results", "rq2", "failures", `${contract}-vm-full.jsonl`));
  const resume = arg("resume", "1") === "1";
  const runNamespace = arg("namespace", `vm-${Date.now()}`);
  const deployment = loadDeployment();
  const cases = readCases(casesPath, limit);
  const existingResults: CaseResult[] =
    resume && fs.existsSync(out)
      ? (JSON.parse(fs.readFileSync(out, "utf8").replace(/^\uFEFF/, "")).results ?? [])
      : [];
  const results: CaseResult[] = existingResults.filter((result) =>
    cases.some((testCase) => testCase.caseId === result.caseId),
  );
  const completed = new Set(results.map((result) => result.caseId));
  const started = Date.now();

  let trainWasm: WasmClient | undefined;
  let dexWasm: WasmClient | undefined;
  try {
    if (contract === "TrainBooking") {
      trainWasm = await wasmClient(deployment.contracts.bc2TrainMetadataPath, deployment.contracts.TrainBookingOriginalWasm, deployment.contracts.bc2RpcWs);
    } else if (contract === "DEXSwap") {
      dexWasm = await wasmClient(deployment.contracts.bc2DexMetadataPath, deployment.contracts.DEXSwapOriginalWasm, deployment.contracts.bc2RpcWs);
    }
    for (let i = 0; i < cases.length; i++) {
      if (completed.has(cases[i].caseId)) {
        console.log(`[RQ2a-VM] ${contract} ${i + 1}/${cases.length} ${cases[i].caseId} skip(resume)`);
        continue;
      }
      console.log(`[RQ2a-VM] ${contract} ${i + 1}/${cases.length} ${cases[i].caseId}`);
      let result: CaseResult;
      try {
        if (contract === "HotelBooking") result = await runHotel(cases[i], deployment.contracts, runNamespace);
        else if (contract === "TrainBooking") result = await runTrain(cases[i], deployment.contracts, trainWasm!, i + 1, runNamespace);
        else if (contract === "TokenTransfer") result = await runToken(cases[i], deployment.contracts, runNamespace);
        else if (contract === "AuctionLogic") result = await runAuction(cases[i], deployment.contracts, runNamespace);
        else result = await runDex(cases[i], deployment.contracts, dexWasm!, runNamespace);
      } catch (e) {
        result = {
          caseId: cases[i].caseId,
          seed: cases[i].seed,
          pass: false,
          failCategory: "runner_exception",
          failReason: e instanceof Error ? e.message : String(e),
        };
      }
      results.push(result);
      const pass = results.filter((r) => r.pass).length;
      writeOutput(out, {
        schemaVersion: 1,
        rq: "RQ2a",
        mode: "vm-full-live-original-vs-translated",
        contract,
        namespace: runNamespace,
        casesPath,
        generatedAt: new Date().toISOString(),
        elapsedSeconds: (Date.now() - started) / 1000,
        runs: results.length,
        targetRuns: cases.length,
        pass,
        fail: results.length - pass,
        passRate: results.length === 0 ? 0 : pass / results.length,
        results,
      });
      fs.mkdirSync(path.dirname(failures), { recursive: true });
      fs.writeFileSync(failures, results.filter((r) => !r.pass).map((r) => JSON.stringify(r)).join("\n") + (results.some((r) => !r.pass) ? "\n" : ""));
      if (!result.pass && arg("stop-on-fail", "1") === "1") {
        throw new Error(`${contract} failed at ${result.caseId}: ${result.failReason}`);
      }
    }
  } finally {
    await trainWasm?.api.disconnect();
    await dexWasm?.api.disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
