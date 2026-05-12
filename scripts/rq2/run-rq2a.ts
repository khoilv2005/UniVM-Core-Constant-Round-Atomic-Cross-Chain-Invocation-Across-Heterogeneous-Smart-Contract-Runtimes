import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { canonicalSnapshot, SnapshotEntry } from "./canonical-snapshot";
import {
  HotelBookingModel,
  HotelInitialState,
  HotelOperation,
  OperationResult,
} from "./hotel-booking-model";
import {
  AuctionInitialState,
  AuctionLogicModel,
  AuctionOperation,
  ContractName,
  DEXSwapModel,
  DexInitialState,
  DexOperation,
  Rq2InitialState,
  Rq2Operation,
  TokenInitialState,
  TokenOperation,
  TokenTransferModel,
  TrainBookingModel,
  TrainInitialState,
  TrainOperation,
} from "./rq2-models";

type Rq2Case = {
  schemaVersion: 1;
  contract: ContractName;
  caseId: string;
  seed: number;
  initial: Rq2InitialState;
  operations: Rq2Operation[];
};

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

function getArg(name: string, fallback: string): string {
  const envName = `RQ2_${name.replace(/-/g, "_").toUpperCase()}`;
  const envValue = process.env[envName];
  if (envValue && envValue.length > 0) {
    return envValue;
  }
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeContract(value: string): string {
  const normalized = value.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "hotelbooking") return "HotelBooking";
  if (normalized === "trainbooking") return "TrainBooking";
  if (normalized === "tokentransfer") return "TokenTransfer";
  if (normalized === "auctionlogic") return "AuctionLogic";
  if (normalized === "dexswap") return "DEXSwap";
  return value;
}

function readJsonl(filePath: string): Rq2Case[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Rq2Case);
}

function resultValues(values: unknown): string[] {
  if (Array.isArray(values)) {
    return values.map((value) => value.toString());
  }
  if (typeof values === "bigint") {
    return [values.toString()];
  }
  if (typeof values === "boolean") {
    return [String(values)];
  }
  if (values === undefined || values === null) {
    return [];
  }
  return [String(values)];
}

function revertReason(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split("\n")[0];
  }
  return String(err);
}

function hotelTouchedUsers(operations: HotelOperation[]): string[] {
  return operations.flatMap((operation) => {
    if ("user" in operation) return [operation.user];
    return [];
  });
}

function hotelTouchedLocks(operations: HotelOperation[]): string[] {
  return operations.flatMap((operation) => {
    if ("lockId" in operation) return [operation.lockId];
    return [];
  });
}

function tokenTouchedUsers(operations: TokenOperation[], initial: TokenInitialState): string[] {
  const users = new Set(Object.keys(initial.balances));
  for (const operation of operations) {
    if ("user" in operation) users.add(operation.user);
    if ("to" in operation) users.add(operation.to);
    if ("from" in operation) users.add(operation.from);
    if ("owner" in operation) users.add(operation.owner);
    if ("spender" in operation) users.add(operation.spender);
  }
  return [...users];
}

function tokenTouchedAllowancePairs(operations: TokenOperation[]): string[] {
  const pairs = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "Approve" || operation.kind === "Allowance") {
      pairs.add(`${operation.owner}\u0000${operation.spender}`);
    }
    if (operation.kind === "TransferFrom") {
      pairs.add(`${operation.from}\u0000${operation.spender}`);
    }
  }
  return [...pairs];
}

function auctionTouchedIds(operations: AuctionOperation[]): string[] {
  return operations.flatMap((operation) => ("id" in operation ? [operation.id] : []));
}

function auctionTouchedUsers(operations: AuctionOperation[]): string[] {
  return operations.flatMap((operation) => {
    const users: string[] = [];
    if ("seller" in operation) users.push(operation.seller);
    if ("bidder" in operation) users.push(operation.bidder);
    if ("user" in operation) users.push(operation.user);
    return users;
  });
}

function dexTouchedUsers(operations: DexOperation[]): string[] {
  return operations.flatMap((operation) => ("user" in operation ? [operation.user] : []));
}

function normalizeCompare(original: OperationResult, translated: OperationResult): string | null {
  if (original.ok !== translated.ok) {
    return `status mismatch: original=${original.ok} translated=${translated.ok} originalError=${original.error ?? ""} translatedError=${translated.error ?? ""}`;
  }
  if (!original.ok) {
    return null;
  }
  if (original.returnValues.length !== translated.returnValues.length) {
    return `return length mismatch: original=${original.returnValues.join(",")} translated=${translated.returnValues.join(",")}`;
  }
  for (let i = 0; i < original.returnValues.length; i++) {
    if (original.returnValues[i] !== translated.returnValues[i]) {
      return `return mismatch at ${i}: original=${original.returnValues[i]} translated=${translated.returnValues[i]}`;
    }
  }
  return null;
}

async function initTranslatedHotel(contract: any, initial: HotelInitialState) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const metaSlot = ethers.solidityPackedKeccak256(["string", "string", "string"], ["VASSP", "HotelBooking", "META"]);
  const lockTotalSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "LOCK_TOTAL"],
  );
  const metaValue = coder.encode(
    ["string", "uint256", "uint256", "uint256"],
    [initial.bridge, initial.price, initial.remain, initial.lockSize],
  );
  const lockTotalValue = coder.encode(["uint256"], [0]);
  await (await contract.__vassp_apply(metaSlot, metaValue)).wait();
  await (await contract.__vassp_apply(lockTotalSlot, lockTotalValue)).wait();
}

async function initTranslatedToken(contract: any, initial: TokenInitialState) {
  for (const [user, amount] of Object.entries(initial.balances)) {
    if (BigInt(amount) > 0n) {
      await (await contract.Mint(user, amount)).wait();
    }
  }
}

async function executeTranslated(contract: any, operation: HotelOperation): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "BookLocal": {
        const value = await contract.BookLocal.staticCall(operation.user, operation.amount);
        await (await contract.BookLocal(operation.user, operation.amount)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "LockState": {
        const value = await contract.LockState.staticCall(operation.lockId, operation.amount, operation.timeoutBlocks);
        await (await contract.LockState(operation.lockId, operation.amount, operation.timeoutBlocks)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "UnlockState": {
        await (await contract.UnlockState(operation.lockId)).wait();
        return { ok: true, returnValues: [] };
      }
      case "GetPrice":
        return { ok: true, returnValues: resultValues(await contract.GetPrice()) };
      case "GetRemain":
        return { ok: true, returnValues: resultValues(await contract.GetRemain()) };
      case "GetAvailableRemain":
        return { ok: true, returnValues: resultValues(await contract.GetAvailableRemain()) };
      case "GetAccountBalance":
        return { ok: true, returnValues: resultValues(await contract.GetAccountBalance(operation.user)) };
      case "GetBooking":
        return { ok: true, returnValues: resultValues(await contract.GetBooking(operation.user)) };
      case "IsStateLocked":
        return { ok: true, returnValues: resultValues(await contract.IsStateLocked(operation.lockId)) };
      default: {
        const neverOperation: never = operation;
        throw new Error(`unknown operation ${(neverOperation as HotelOperation).kind}`);
      }
    }
  } catch (err) {
    return { ok: false, returnValues: [], error: revertReason(err) };
  }
}

async function executeTranslatedToken(contract: any, operation: TokenOperation): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "Mint":
        await (await contract.Mint(operation.to, operation.amount)).wait();
        return { ok: true, returnValues: [] };
      case "Transfer":
        await (await contract.Transfer(operation.from, operation.to, operation.amount)).wait();
        return { ok: true, returnValues: [] };
      case "Approve":
        await (await contract.Approve(operation.owner, operation.spender, operation.amount)).wait();
        return { ok: true, returnValues: [] };
      case "TransferFrom":
        await (await contract.TransferFrom(operation.spender, operation.from, operation.to, operation.amount)).wait();
        return { ok: true, returnValues: [] };
      case "BalanceOf":
        return { ok: true, returnValues: resultValues(await contract.BalanceOf(operation.user)) };
      case "Allowance":
        return { ok: true, returnValues: resultValues(await contract.Allowance(operation.owner, operation.spender)) };
      case "TotalSupply":
        return { ok: true, returnValues: resultValues(await contract.TotalSupply()) };
    }
  } catch (err) {
    return { ok: false, returnValues: [], error: revertReason(err) };
  }
}

async function executeTranslatedAuction(contract: any, operation: AuctionOperation): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "CreateAuction":
        await (await contract.CreateAuction(operation.id, operation.seller, operation.minPrice)).wait();
        return { ok: true, returnValues: [] };
      case "Bid":
        await (await contract.Bid(operation.id, operation.bidder, operation.amount)).wait();
        return { ok: true, returnValues: [] };
      case "Close":
        await (await contract.Close(operation.id)).wait();
        return { ok: true, returnValues: [] };
      case "Withdraw": {
        const value = await contract.Withdraw.staticCall(operation.user);
        await (await contract.Withdraw(operation.user)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "GetAuction":
        return { ok: true, returnValues: resultValues(await contract.GetAuction(operation.id)) };
      case "PendingReturn":
        return { ok: true, returnValues: resultValues(await contract.PendingReturn(operation.user)) };
    }
  } catch (err) {
    return { ok: false, returnValues: [], error: revertReason(err) };
  }
}

async function executeTranslatedDex(contract: any, operation: DexOperation): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "AddLiquidity": {
        const value = await contract.AddLiquidity.staticCall(operation.user, operation.amountA, operation.amountB);
        await (await contract.AddLiquidity(operation.user, operation.amountA, operation.amountB)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "RemoveLiquidity": {
        const value = await contract.RemoveLiquidity.staticCall(operation.user, operation.shares);
        await (await contract.RemoveLiquidity(operation.user, operation.shares)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "SwapAForB": {
        const value = await contract.SwapAForB.staticCall(operation.user, operation.amountIn);
        await (await contract.SwapAForB(operation.user, operation.amountIn)).wait();
        return { ok: true, returnValues: resultValues(value) };
      }
      case "GetReserves":
        return { ok: true, returnValues: resultValues(await contract.GetReserves()) };
      case "GetShares":
        return { ok: true, returnValues: resultValues(await contract.GetShares(operation.user)) };
      case "TotalShares":
        return { ok: true, returnValues: resultValues(await contract.TotalShares()) };
    }
  } catch (err) {
    return { ok: false, returnValues: [], error: revertReason(err) };
  }
}

async function translatedSnapshot(contract: any, initial: HotelInitialState, touchedUsers: string[], touchedLocks: string[]) {
  const entries: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: initial.bridge } },
    { key: "meta.price", value: { type: "uint256", value: await contract.GetPrice() } },
    { key: "meta.remain", value: { type: "uint256", value: await contract.GetRemain() } },
    { key: "meta.lockSize", value: { type: "uint256", value: initial.lockSize } },
    { key: "availableRemain", value: { type: "uint256", value: await contract.GetAvailableRemain() } },
  ];

  entries.push({ key: "lockedTotal", value: { type: "uint256", value: await contract.GetLockedTotal() } });

  for (const user of [...new Set(touchedUsers)].sort()) {
    entries.push({ key: `accounts.${user}`, value: { type: "uint256", value: await contract.GetAccountBalance(user) } });
    entries.push({ key: `bookings.${user}`, value: { type: "uint256", value: await contract.GetBooking(user) } });
  }
  for (const lockId of [...new Set(touchedLocks)].sort()) {
    entries.push({ key: `locks.${lockId}.active`, value: { type: "bool", value: await contract.IsStateLocked(lockId) } });
    entries.push({ key: `locks.${lockId}.lockedAmount`, value: { type: "uint256", value: await contract.GetLockAmount(lockId) } });
  }

  return canonicalSnapshot("HotelBooking", entries);
}

async function translatedTravelSnapshot(
  contractName: "HotelBooking" | "TrainBooking",
  contract: any,
  initial: HotelInitialState,
  touchedUsers: string[],
  touchedLocks: string[],
) {
  const entries: SnapshotEntry[] = [
    { key: "meta.bridge", value: { type: "string", value: initial.bridge } },
    { key: "meta.price", value: { type: "uint256", value: await contract.GetPrice() } },
    { key: "meta.remain", value: { type: "uint256", value: await contract.GetRemain() } },
    { key: "meta.lockSize", value: { type: "uint256", value: initial.lockSize } },
    { key: "availableRemain", value: { type: "uint256", value: await contract.GetAvailableRemain() } },
    { key: "lockedTotal", value: { type: "uint256", value: await contract.GetLockedTotal() } },
  ];
  for (const user of [...new Set(touchedUsers)].sort()) {
    entries.push({ key: `accounts.${user}`, value: { type: "uint256", value: await contract.GetAccountBalance(user) } });
    entries.push({ key: `bookings.${user}`, value: { type: "uint256", value: await contract.GetBooking(user) } });
  }
  for (const lockId of [...new Set(touchedLocks)].sort()) {
    entries.push({ key: `locks.${lockId}.active`, value: { type: "bool", value: await contract.IsStateLocked(lockId) } });
    entries.push({ key: `locks.${lockId}.lockedAmount`, value: { type: "uint256", value: await contract.GetLockAmount(lockId) } });
  }
  return canonicalSnapshot(contractName, entries);
}

async function translatedTokenSnapshot(contract: any, users: string[], allowancePairs: string[]) {
  const entries: SnapshotEntry[] = [
    { key: "totalSupply", value: { type: "uint256", value: await contract.TotalSupply() } },
  ];
  for (const user of [...new Set(users)].sort()) {
    entries.push({ key: `balances.${user}`, value: { type: "uint256", value: await contract.BalanceOf(user) } });
  }
  for (const pair of [...new Set(allowancePairs)].sort()) {
    const [owner, spender] = pair.split("\u0000");
    entries.push({ key: `allowances.${pair}`, value: { type: "uint256", value: await contract.Allowance(owner, spender) } });
  }
  return canonicalSnapshot("TokenTransfer", entries);
}

async function translatedAuctionSnapshot(contract: any, ids: string[], users: string[]) {
  const entries: SnapshotEntry[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const a = await contract.GetAuction(id);
    entries.push({ key: `auction.${id}.seller`, value: { type: "string", value: a[0] } });
    entries.push({ key: `auction.${id}.minPrice`, value: { type: "uint256", value: a[1] } });
    entries.push({ key: `auction.${id}.highestBidder`, value: { type: "string", value: a[2] } });
    entries.push({ key: `auction.${id}.highestBid`, value: { type: "uint256", value: a[3] } });
    entries.push({ key: `auction.${id}.open`, value: { type: "bool", value: a[4] } });
    entries.push({ key: `auction.${id}.exists`, value: { type: "bool", value: a[5] } });
  }
  for (const user of [...new Set(users)].sort()) {
    entries.push({ key: `pending.${user}`, value: { type: "uint256", value: await contract.PendingReturn(user) } });
  }
  return canonicalSnapshot("AuctionLogic", entries);
}

async function translatedDexSnapshot(contract: any, users: string[]) {
  const reserves = await contract.GetReserves();
  const entries: SnapshotEntry[] = [
    { key: "reserveA", value: { type: "uint256", value: reserves[0] } },
    { key: "reserveB", value: { type: "uint256", value: reserves[1] } },
    { key: "totalShares", value: { type: "uint256", value: await contract.TotalShares() } },
  ];
  for (const user of [...new Set(users)].sort()) {
    entries.push({ key: `shares.${user}`, value: { type: "uint256", value: await contract.GetShares(user) } });
  }
  return canonicalSnapshot("DEXSwap", entries);
}

async function runHotelCase(testCase: Rq2Case): Promise<CaseResult> {
  const original = new HotelBookingModel(testCase.initial as HotelInitialState);
  const translated = await ethers.deployContract("HotelBookingTranslated");
  await translated.waitForDeployment();
  await initTranslatedHotel(translated, testCase.initial as HotelInitialState);

  const operations = testCase.operations as HotelOperation[];
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    const originalResult = original.execute(operation);
    const translatedResult = await executeTranslated(translated, operation);
    const mismatch = normalizeCompare(originalResult, translatedResult);
    if (mismatch) {
      return {
        caseId: testCase.caseId,
        seed: testCase.seed,
        pass: false,
        failCategory: mismatch.startsWith("status mismatch") ? "status_mismatch" : "return_mismatch",
        failReason: mismatch,
        operationIndex: i,
      };
    }
  }

  const touchedUsers = hotelTouchedUsers(operations);
  const touchedLocks = hotelTouchedLocks(operations);
  const originalSnapshot = original.snapshot(touchedUsers, touchedLocks);
  const translatedState = await translatedSnapshot(translated, testCase.initial as HotelInitialState, touchedUsers, touchedLocks);
  if (originalSnapshot.bytesHex !== translatedState.bytesHex) {
    return {
      caseId: testCase.caseId,
      seed: testCase.seed,
      pass: false,
      failCategory: "state_mismatch",
      failReason: "canonical snapshot bytes differ",
      originalSnapshotHash: originalSnapshot.hash,
      translatedSnapshotHash: translatedState.hash,
    };
  }

  return {
    caseId: testCase.caseId,
    seed: testCase.seed,
    pass: true,
    originalSnapshotHash: originalSnapshot.hash,
    translatedSnapshotHash: translatedState.hash,
  };
}

async function runTrainCase(testCase: Rq2Case): Promise<CaseResult> {
  const original = new TrainBookingModel(testCase.initial as TrainInitialState);
  const translated = await ethers.deployContract("TrainBookingTranslated", [
    (testCase.initial as TrainInitialState).bridge,
    (testCase.initial as TrainInitialState).price,
    (testCase.initial as TrainInitialState).remain,
    (testCase.initial as TrainInitialState).lockSize,
  ]);
  await translated.waitForDeployment();

  const operations = testCase.operations as TrainOperation[];
  for (let i = 0; i < operations.length; i++) {
    const originalResult = original.execute(operations[i]);
    const translatedResult = await executeTranslated(translated, operations[i]);
    const mismatch = normalizeCompare(originalResult, translatedResult);
    if (mismatch) {
      return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: mismatch.startsWith("status mismatch") ? "status_mismatch" : "return_mismatch", failReason: mismatch, operationIndex: i };
    }
  }
  const touchedUsers = hotelTouchedUsers(operations);
  const touchedLocks = hotelTouchedLocks(operations);
  const originalSnapshot = original.snapshot(touchedUsers, touchedLocks);
  const translatedState = await translatedTravelSnapshot("TrainBooking", translated, testCase.initial as TrainInitialState, touchedUsers, touchedLocks);
  if (originalSnapshot.bytesHex !== translatedState.bytesHex) {
    return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "state_mismatch", failReason: "canonical snapshot bytes differ", originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
  }
  return { caseId: testCase.caseId, seed: testCase.seed, pass: true, originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
}

async function runTokenCase(testCase: Rq2Case): Promise<CaseResult> {
  const initial = testCase.initial as TokenInitialState;
  const original = new TokenTransferModel(initial);
  const translated = await ethers.deployContract("TokenTransferTranslated");
  await translated.waitForDeployment();
  await initTranslatedToken(translated, initial);
  const operations = testCase.operations as TokenOperation[];
  for (let i = 0; i < operations.length; i++) {
    const originalResult = original.execute(operations[i]);
    const translatedResult = await executeTranslatedToken(translated, operations[i]);
    const mismatch = normalizeCompare(originalResult, translatedResult);
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: mismatch.startsWith("status mismatch") ? "status_mismatch" : "return_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = tokenTouchedUsers(operations, initial);
  const pairs = tokenTouchedAllowancePairs(operations);
  const originalSnapshot = original.snapshot(users, pairs);
  const translatedState = await translatedTokenSnapshot(translated, users, pairs);
  if (originalSnapshot.bytesHex !== translatedState.bytesHex) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "state_mismatch", failReason: "canonical snapshot bytes differ", originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
  return { caseId: testCase.caseId, seed: testCase.seed, pass: true, originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
}

async function runAuctionCase(testCase: Rq2Case): Promise<CaseResult> {
  void (testCase.initial as AuctionInitialState);
  const original = new AuctionLogicModel();
  const translated = await ethers.deployContract("AuctionLogicTranslated");
  await translated.waitForDeployment();
  const operations = testCase.operations as AuctionOperation[];
  for (let i = 0; i < operations.length; i++) {
    const originalResult = original.execute(operations[i]);
    const translatedResult = await executeTranslatedAuction(translated, operations[i]);
    const mismatch = normalizeCompare(originalResult, translatedResult);
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: mismatch.startsWith("status mismatch") ? "status_mismatch" : "return_mismatch", failReason: mismatch, operationIndex: i };
  }
  const ids = auctionTouchedIds(operations);
  const users = auctionTouchedUsers(operations);
  const originalSnapshot = original.snapshot(ids, users);
  const translatedState = await translatedAuctionSnapshot(translated, ids, users);
  if (originalSnapshot.bytesHex !== translatedState.bytesHex) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "state_mismatch", failReason: "canonical snapshot bytes differ", originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
  return { caseId: testCase.caseId, seed: testCase.seed, pass: true, originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
}

async function runDexCase(testCase: Rq2Case): Promise<CaseResult> {
  void (testCase.initial as DexInitialState);
  const original = new DEXSwapModel();
  const translated = await ethers.deployContract("DEXSwapTranslated");
  await translated.waitForDeployment();
  const operations = testCase.operations as DexOperation[];
  for (let i = 0; i < operations.length; i++) {
    const originalResult = original.execute(operations[i]);
    const translatedResult = await executeTranslatedDex(translated, operations[i]);
    const mismatch = normalizeCompare(originalResult, translatedResult);
    if (mismatch) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: mismatch.startsWith("status mismatch") ? "status_mismatch" : "return_mismatch", failReason: mismatch, operationIndex: i };
  }
  const users = dexTouchedUsers(operations);
  const originalSnapshot = original.snapshot(users);
  const translatedState = await translatedDexSnapshot(translated, users);
  if (originalSnapshot.bytesHex !== translatedState.bytesHex) return { caseId: testCase.caseId, seed: testCase.seed, pass: false, failCategory: "state_mismatch", failReason: "canonical snapshot bytes differ", originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
  return { caseId: testCase.caseId, seed: testCase.seed, pass: true, originalSnapshotHash: originalSnapshot.hash, translatedSnapshotHash: translatedState.hash };
}

function unsupportedResult(contract: string, out: string) {
  const result = {
    schemaVersion: 1,
    rq: "RQ2a",
    contract,
    status: "missing_asset",
    runs: 0,
    pass: 0,
    fail: 0,
    passRate: null,
    note: "Contract source/translated artifacts or adapters are not implemented yet.",
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const contract = normalizeContract(getArg("contract", "HotelBooking"));
  const casesPath = getArg("cases", path.join("benchmark-results", "rq2", "cases", "hotel-booking.jsonl"));
  const out = getArg("out", path.join("benchmark-results", "rq2", "results", `${contract}.json`));
  const failuresOut = getArg("failures", path.join("benchmark-results", "rq2", "failures", `${contract}.jsonl`));

  const cases = readJsonl(casesPath);
  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    console.log(`RQ2a ${contract} case ${i + 1}/${cases.length}: ${cases[i].caseId}`);
    if (contract === "HotelBooking") results.push(await runHotelCase(cases[i]));
    else if (contract === "TrainBooking") results.push(await runTrainCase(cases[i]));
    else if (contract === "TokenTransfer") results.push(await runTokenCase(cases[i]));
    else if (contract === "AuctionLogic") results.push(await runAuctionCase(cases[i]));
    else if (contract === "DEXSwap") results.push(await runDexCase(cases[i]));
    else {
      unsupportedResult(contract, out);
      return;
    }
  }

  const pass = results.filter((result) => result.pass).length;
  const fail = results.length - pass;
  const failByCategory: Record<string, number> = {};
  for (const result of results) {
    if (!result.pass) {
      const category = result.failCategory ?? "unknown";
      failByCategory[category] = (failByCategory[category] ?? 0) + 1;
    }
  }

  const output = {
    schemaVersion: 1,
    rq: "RQ2a",
    contract,
    originalAdapter: `${contract}-semantics-model`,
    translatedAdapter: `hardhat-evm-${contract}Translated`,
    casesPath,
    runs: results.length,
    pass,
    fail,
    passRate: results.length === 0 ? 0 : pass / results.length,
    failByCategory,
    results,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(failuresOut), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output, null, 2));
  fs.writeFileSync(
    failuresOut,
    results
      .filter((result) => !result.pass)
      .map((result) => JSON.stringify(result))
      .join("\n") + (fail > 0 ? "\n" : ""),
  );
  console.log(JSON.stringify({ contract, runs: results.length, pass, fail, passRate: output.passRate, out }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
