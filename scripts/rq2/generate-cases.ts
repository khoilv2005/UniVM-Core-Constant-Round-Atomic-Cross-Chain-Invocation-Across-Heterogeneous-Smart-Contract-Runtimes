import fs from "fs";
import path from "path";
import { HotelInitialState, HotelOperation } from "./hotel-booking-model";
import { AuctionOperation, DexOperation, TokenInitialState, TokenOperation } from "./rq2-models";

type Rq2Case = {
  schemaVersion: 1;
  contract: string;
  caseId: string;
  seed: number;
  initial: unknown;
  operations: unknown[];
};

function getArg(name: string, fallback: string): string {
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

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }
  pick<T>(values: T[]): T {
    return values[this.int(values.length)];
  }
}

function makeTravelCase(contract: "HotelBooking" | "TrainBooking", index: number, baseSeed: number): Rq2Case {
  const seed = (baseSeed + index * 7919) >>> 0;
  const rng = new Lcg(seed);
  const users = ["alice", "bob", "carol", "dave", "uyen", "khoa"];
  const lockIds = ["lock-a", "lock-b", "lock-c"];
  const initial: HotelInitialState = {
    bridge: "Org1MSP",
    price: String(5 + rng.int(25)),
    remain: String(20 + rng.int(80)),
    lockSize: String(1 + rng.int(4)),
  };

  const operationCount = 8 + rng.int(17);
  const operations: HotelOperation[] = [];
  for (let i = 0; i < operationCount; i++) {
    const selector = rng.int(100);
    if (selector < 35) {
      operations.push({ kind: "BookLocal", user: rng.pick(users), amount: String(rng.int(8)) });
    } else if (selector < 50) {
      operations.push({
        kind: "LockState",
        lockId: rng.pick(lockIds),
        amount: String(rng.int(8)),
        timeoutBlocks: String(5 + rng.int(20)),
      });
    } else if (selector < 60) {
      operations.push({ kind: "UnlockState", lockId: rng.pick(lockIds) });
    } else if (selector < 68) {
      operations.push({ kind: "GetAccountBalance", user: rng.pick(users) });
    } else if (selector < 76) {
      operations.push({ kind: "GetBooking", user: rng.pick(users) });
    } else if (selector < 84) {
      operations.push({ kind: "IsStateLocked", lockId: rng.pick(lockIds) });
    } else if (selector < 90) {
      operations.push({ kind: "GetAvailableRemain" });
    } else if (selector < 95) {
      operations.push({ kind: "GetRemain" });
    } else {
      operations.push({ kind: "GetPrice" });
    }
  }

  return {
    schemaVersion: 1,
    contract,
    caseId: `${contract === "HotelBooking" ? "hotel" : "train"}-${String(index).padStart(4, "0")}`,
    seed,
    initial,
    operations,
  };
}

function makeTokenCase(index: number, baseSeed: number): Rq2Case {
  const seed = (baseSeed + index * 7919) >>> 0;
  const rng = new Lcg(seed);
  const users = ["alice", "bob", "carol", "dave", "uyen", "khoa"];
  const initial: TokenInitialState = { balances: {} };
  for (const user of users) {
    initial.balances[user] = String(rng.int(1000));
  }
  const operations: TokenOperation[] = [];
  const operationCount = 10 + rng.int(20);
  for (let i = 0; i < operationCount; i++) {
    const selector = rng.int(100);
    if (selector < 20) {
      operations.push({ kind: "Mint", to: rng.pick(users), amount: String(rng.int(200)) });
    } else if (selector < 45) {
      operations.push({ kind: "Transfer", from: rng.pick(users), to: rng.pick(users), amount: String(rng.int(400)) });
    } else if (selector < 65) {
      operations.push({ kind: "Approve", owner: rng.pick(users), spender: rng.pick(users), amount: String(rng.int(500)) });
    } else if (selector < 85) {
      operations.push({ kind: "TransferFrom", spender: rng.pick(users), from: rng.pick(users), to: rng.pick(users), amount: String(rng.int(350)) });
    } else if (selector < 93) {
      operations.push({ kind: "BalanceOf", user: rng.pick(users) });
    } else if (selector < 98) {
      operations.push({ kind: "Allowance", owner: rng.pick(users), spender: rng.pick(users) });
    } else {
      operations.push({ kind: "TotalSupply" });
    }
  }
  return { schemaVersion: 1, contract: "TokenTransfer", caseId: `token-${String(index).padStart(4, "0")}`, seed, initial, operations };
}

function makeAuctionCase(index: number, baseSeed: number): Rq2Case {
  const seed = (baseSeed + index * 7919) >>> 0;
  const rng = new Lcg(seed);
  const users = ["alice", "bob", "carol", "dave", "uyen", "khoa"];
  const ids = ["1", "2", "3", "4"];
  const operations: AuctionOperation[] = [];
  const operationCount = 10 + rng.int(20);
  for (let i = 0; i < operationCount; i++) {
    const selector = rng.int(100);
    if (selector < 22) {
      operations.push({ kind: "CreateAuction", id: rng.pick(ids), seller: rng.pick(users), minPrice: String(1 + rng.int(200)) });
    } else if (selector < 55) {
      operations.push({ kind: "Bid", id: rng.pick(ids), bidder: rng.pick(users), amount: String(rng.int(500)) });
    } else if (selector < 68) {
      operations.push({ kind: "Close", id: rng.pick(ids) });
    } else if (selector < 80) {
      operations.push({ kind: "Withdraw", user: rng.pick(users) });
    } else if (selector < 92) {
      operations.push({ kind: "GetAuction", id: rng.pick(ids) });
    } else {
      operations.push({ kind: "PendingReturn", user: rng.pick(users) });
    }
  }
  return { schemaVersion: 1, contract: "AuctionLogic", caseId: `auction-${String(index).padStart(4, "0")}`, seed, initial: {}, operations };
}

function makeDexCase(index: number, baseSeed: number): Rq2Case {
  const seed = (baseSeed + index * 7919) >>> 0;
  const rng = new Lcg(seed);
  const users = ["alice", "bob", "carol", "dave", "uyen", "khoa"];
  const operations: DexOperation[] = [];
  const operationCount = 10 + rng.int(20);
  for (let i = 0; i < operationCount; i++) {
    const selector = rng.int(100);
    if (selector < 40) {
      operations.push({ kind: "AddLiquidity", user: rng.pick(users), amountA: String(rng.int(500)), amountB: String(rng.int(500)) });
    } else if (selector < 60) {
      operations.push({ kind: "RemoveLiquidity", user: rng.pick(users), shares: String(rng.int(300)) });
    } else if (selector < 78) {
      operations.push({ kind: "SwapAForB", user: rng.pick(users), amountIn: String(rng.int(300)) });
    } else if (selector < 88) {
      operations.push({ kind: "GetReserves" });
    } else if (selector < 96) {
      operations.push({ kind: "GetShares", user: rng.pick(users) });
    } else {
      operations.push({ kind: "TotalShares" });
    }
  }
  return { schemaVersion: 1, contract: "DEXSwap", caseId: `dex-${String(index).padStart(4, "0")}`, seed, initial: {}, operations };
}

function makeCase(contract: string, index: number, baseSeed: number): Rq2Case {
  if (contract === "HotelBooking" || contract === "TrainBooking") return makeTravelCase(contract, index, baseSeed);
  if (contract === "TokenTransfer") return makeTokenCase(index, baseSeed);
  if (contract === "AuctionLogic") return makeAuctionCase(index, baseSeed);
  if (contract === "DEXSwap") return makeDexCase(index, baseSeed);
  throw new Error(`unsupported contract ${contract}`);
}

function main() {
  const contract = normalizeContract(getArg("contract", "HotelBooking"));
  const count = Number(getArg("count", "1000"));
  const seed = Number(getArg("seed", "20260426"));
  const out = getArg("out", path.join("benchmark-results", "rq2", "cases", "hotel-booking.jsonl"));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(makeCase(contract, i, seed)));
  }
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(JSON.stringify({ contract, count, seed, out }, null, 2));
}

main();
