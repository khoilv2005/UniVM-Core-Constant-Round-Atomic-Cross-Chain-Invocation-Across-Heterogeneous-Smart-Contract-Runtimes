import { SnapshotEntry, canonicalSnapshot } from "./canonical-snapshot";
import { HotelBookingModel, HotelInitialState, HotelOperation, OperationResult } from "./hotel-booking-model";

export type ContractName = "HotelBooking" | "TrainBooking" | "TokenTransfer" | "AuctionLogic" | "DEXSwap";

export type TrainInitialState = HotelInitialState;
export type TrainOperation = HotelOperation;

export type TokenInitialState = {
  balances: Record<string, string>;
};
export type TokenOperation =
  | { kind: "Mint"; to: string; amount: string }
  | { kind: "Transfer"; from: string; to: string; amount: string }
  | { kind: "Approve"; owner: string; spender: string; amount: string }
  | { kind: "TransferFrom"; spender: string; from: string; to: string; amount: string }
  | { kind: "BalanceOf"; user: string }
  | { kind: "Allowance"; owner: string; spender: string }
  | { kind: "TotalSupply" };

export type AuctionInitialState = Record<string, never>;
export type AuctionOperation =
  | { kind: "CreateAuction"; id: string; seller: string; minPrice: string }
  | { kind: "Bid"; id: string; bidder: string; amount: string }
  | { kind: "Close"; id: string }
  | { kind: "Withdraw"; user: string }
  | { kind: "GetAuction"; id: string }
  | { kind: "PendingReturn"; user: string };

export type DexInitialState = Record<string, never>;
export type DexOperation =
  | { kind: "AddLiquidity"; user: string; amountA: string; amountB: string }
  | { kind: "RemoveLiquidity"; user: string; shares: string }
  | { kind: "SwapAForB"; user: string; amountIn: string }
  | { kind: "GetReserves" }
  | { kind: "GetShares"; user: string }
  | { kind: "TotalShares" };

export type Rq2InitialState =
  | HotelInitialState
  | TrainInitialState
  | TokenInitialState
  | AuctionInitialState
  | DexInitialState;

export type Rq2Operation =
  | HotelOperation
  | TrainOperation
  | TokenOperation
  | AuctionOperation
  | DexOperation;

export type Rq2Case = {
  schemaVersion: 1;
  contract: ContractName;
  caseId: string;
  seed: number;
  initial: Rq2InitialState;
  operations: Rq2Operation[];
};

export class TrainBookingModel extends HotelBookingModel {
  snapshot(touchedUsers: string[], touchedLocks: string[]) {
    const state = super.snapshot(touchedUsers, touchedLocks);
    const hotelPrefix = canonicalSnapshot("HotelBooking", []).bytesHex.slice(0, 2);
    void hotelPrefix;
    const anyThis = this as unknown as {
      bridge: string;
      price: bigint;
      remain: bigint;
      lockSize: bigint;
      lockedTotal: bigint;
      accounts: Map<string, bigint>;
      bookings: Map<string, bigint>;
      locks: Map<string, { lockedAmount: bigint; active: boolean }>;
    };
    const entries: SnapshotEntry[] = [
      { key: "meta.bridge", value: { type: "string", value: anyThis.bridge } },
      { key: "meta.price", value: { type: "uint256", value: anyThis.price } },
      { key: "meta.remain", value: { type: "uint256", value: anyThis.remain } },
      { key: "meta.lockSize", value: { type: "uint256", value: anyThis.lockSize } },
      { key: "lockedTotal", value: { type: "uint256", value: anyThis.lockedTotal } },
      { key: "availableRemain", value: { type: "uint256", value: BigInt((this.execute({ kind: "GetAvailableRemain" }).returnValues[0] ?? "0")) } },
    ];
    for (const user of [...new Set(touchedUsers)].sort()) {
      entries.push({ key: `accounts.${user}`, value: { type: "uint256", value: anyThis.accounts.get(user) ?? 0n } });
      entries.push({ key: `bookings.${user}`, value: { type: "uint256", value: anyThis.bookings.get(user) ?? 0n } });
    }
    for (const lockId of [...new Set(touchedLocks)].sort()) {
      const lock = anyThis.locks.get(lockId);
      entries.push({ key: `locks.${lockId}.active`, value: { type: "bool", value: lock?.active === true } });
      entries.push({ key: `locks.${lockId}.lockedAmount`, value: { type: "uint256", value: lock?.lockedAmount ?? 0n } });
    }
    void state;
    return canonicalSnapshot("TrainBooking", entries);
  }
}

export class TokenTransferModel {
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  totalSupply = 0n;

  constructor(initial: TokenInitialState) {
    for (const [user, value] of Object.entries(initial.balances)) {
      const amount = BigInt(value);
      this.balances.set(user, amount);
      this.totalSupply += amount;
    }
  }

  execute(operation: TokenOperation): OperationResult {
    try {
      switch (operation.kind) {
        case "Mint": {
          const amount = BigInt(operation.amount);
          if (amount === 0n) throw new Error("ZeroAmount");
          this.balances.set(operation.to, this.balance(operation.to) + amount);
          this.totalSupply += amount;
          return { ok: true, returnValues: [] };
        }
        case "Transfer": {
          const amount = BigInt(operation.amount);
          if (this.balance(operation.from) < amount) throw new Error("InsufficientBalance");
          this.balances.set(operation.from, this.balance(operation.from) - amount);
          this.balances.set(operation.to, this.balance(operation.to) + amount);
          return { ok: true, returnValues: [] };
        }
        case "Approve":
          this.allowances.set(this.allowanceKey(operation.owner, operation.spender), BigInt(operation.amount));
          return { ok: true, returnValues: [] };
        case "TransferFrom": {
          const amount = BigInt(operation.amount);
          const key = this.allowanceKey(operation.from, operation.spender);
          if ((this.allowances.get(key) ?? 0n) < amount) throw new Error("InsufficientAllowance");
          if (this.balance(operation.from) < amount) throw new Error("InsufficientBalance");
          this.allowances.set(key, (this.allowances.get(key) ?? 0n) - amount);
          this.balances.set(operation.from, this.balance(operation.from) - amount);
          this.balances.set(operation.to, this.balance(operation.to) + amount);
          return { ok: true, returnValues: [] };
        }
        case "BalanceOf":
          return { ok: true, returnValues: [this.balance(operation.user).toString()] };
        case "Allowance":
          return { ok: true, returnValues: [(this.allowances.get(this.allowanceKey(operation.owner, operation.spender)) ?? 0n).toString()] };
        case "TotalSupply":
          return { ok: true, returnValues: [this.totalSupply.toString()] };
      }
    } catch (err) {
      return { ok: false, returnValues: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  snapshot(users: string[], allowancePairs: string[]) {
    const entries: SnapshotEntry[] = [
      { key: "totalSupply", value: { type: "uint256", value: this.totalSupply } },
    ];
    for (const user of [...new Set(users)].sort()) {
      entries.push({ key: `balances.${user}`, value: { type: "uint256", value: this.balance(user) } });
    }
    for (const pair of [...new Set(allowancePairs)].sort()) {
      entries.push({ key: `allowances.${pair}`, value: { type: "uint256", value: this.allowances.get(pair) ?? 0n } });
    }
    return canonicalSnapshot("TokenTransfer", entries);
  }

  allowanceKey(owner: string, spender: string) {
    return `${owner}\u0000${spender}`;
  }

  private balance(user: string) {
    return this.balances.get(user) ?? 0n;
  }
}

type AuctionState = {
  seller: string;
  minPrice: bigint;
  highestBidder: string;
  highestBid: bigint;
  open: boolean;
  exists: boolean;
};

export class AuctionLogicModel {
  auctions = new Map<string, AuctionState>();
  pendingReturns = new Map<string, bigint>();

  execute(operation: AuctionOperation): OperationResult {
    try {
      switch (operation.kind) {
        case "CreateAuction": {
          if (this.auctions.get(operation.id)?.exists) throw new Error("AuctionExists");
          const minPrice = BigInt(operation.minPrice);
          if (minPrice === 0n) throw new Error("ZeroMinPrice");
          this.auctions.set(operation.id, { seller: operation.seller, minPrice, highestBidder: "", highestBid: 0n, open: true, exists: true });
          return { ok: true, returnValues: [] };
        }
        case "Bid": {
          const auction = this.auctions.get(operation.id);
          if (!auction?.exists) throw new Error("MissingAuction");
          if (!auction.open) throw new Error("Closed");
          const amount = BigInt(operation.amount);
          if (amount < auction.minPrice || amount <= auction.highestBid) throw new Error("BidTooLow");
          if (auction.highestBid > 0n) {
            this.pendingReturns.set(auction.highestBidder, this.pending(auction.highestBidder) + auction.highestBid);
          }
          auction.highestBidder = operation.bidder;
          auction.highestBid = amount;
          return { ok: true, returnValues: [] };
        }
        case "Close": {
          const auction = this.auctions.get(operation.id);
          if (!auction?.exists) throw new Error("MissingAuction");
          if (!auction.open) throw new Error("Closed");
          auction.open = false;
          if (auction.highestBid > 0n) {
            this.pendingReturns.set(auction.seller, this.pending(auction.seller) + auction.highestBid);
          }
          return { ok: true, returnValues: [] };
        }
        case "Withdraw": {
          const amount = this.pending(operation.user);
          this.pendingReturns.set(operation.user, 0n);
          return { ok: true, returnValues: [amount.toString()] };
        }
        case "GetAuction": {
          const a = this.auctions.get(operation.id) ?? { seller: "", minPrice: 0n, highestBidder: "", highestBid: 0n, open: false, exists: false };
          return { ok: true, returnValues: [a.seller, a.minPrice.toString(), a.highestBidder, a.highestBid.toString(), String(a.open), String(a.exists)] };
        }
        case "PendingReturn":
          return { ok: true, returnValues: [this.pending(operation.user).toString()] };
      }
    } catch (err) {
      return { ok: false, returnValues: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  snapshot(ids: string[], users: string[]) {
    const entries: SnapshotEntry[] = [];
    for (const id of [...new Set(ids)].sort()) {
      const a = this.auctions.get(id) ?? { seller: "", minPrice: 0n, highestBidder: "", highestBid: 0n, open: false, exists: false };
      entries.push({ key: `auction.${id}.seller`, value: { type: "string", value: a.seller } });
      entries.push({ key: `auction.${id}.minPrice`, value: { type: "uint256", value: a.minPrice } });
      entries.push({ key: `auction.${id}.highestBidder`, value: { type: "string", value: a.highestBidder } });
      entries.push({ key: `auction.${id}.highestBid`, value: { type: "uint256", value: a.highestBid } });
      entries.push({ key: `auction.${id}.open`, value: { type: "bool", value: a.open } });
      entries.push({ key: `auction.${id}.exists`, value: { type: "bool", value: a.exists } });
    }
    for (const user of [...new Set(users)].sort()) {
      entries.push({ key: `pending.${user}`, value: { type: "uint256", value: this.pending(user) } });
    }
    return canonicalSnapshot("AuctionLogic", entries);
  }

  private pending(user: string) {
    return this.pendingReturns.get(user) ?? 0n;
  }
}

export class DEXSwapModel {
  reserveA = 0n;
  reserveB = 0n;
  totalShares = 0n;
  shares = new Map<string, bigint>();

  execute(operation: DexOperation): OperationResult {
    try {
      switch (operation.kind) {
        case "AddLiquidity": {
          const amountA = BigInt(operation.amountA);
          const amountB = BigInt(operation.amountB);
          if (amountA === 0n || amountB === 0n) throw new Error("ZeroLiquidity");
          let minted: bigint;
          if (this.totalShares === 0n) {
            minted = amountA + amountB;
          } else {
            const shareA = (amountA * this.totalShares) / this.reserveA;
            const shareB = (amountB * this.totalShares) / this.reserveB;
            minted = shareA < shareB ? shareA : shareB;
          }
          if (minted === 0n) throw new Error("ZeroShares");
          this.reserveA += amountA;
          this.reserveB += amountB;
          this.totalShares += minted;
          this.shares.set(operation.user, this.shareOf(operation.user) + minted);
          return { ok: true, returnValues: [minted.toString()] };
        }
        case "RemoveLiquidity": {
          const shareAmount = BigInt(operation.shares);
          if (shareAmount === 0n) throw new Error("ZeroShares");
          if (this.shareOf(operation.user) < shareAmount) throw new Error("InsufficientShares");
          const amountA = (this.reserveA * shareAmount) / this.totalShares;
          const amountB = (this.reserveB * shareAmount) / this.totalShares;
          this.shares.set(operation.user, this.shareOf(operation.user) - shareAmount);
          this.totalShares -= shareAmount;
          this.reserveA -= amountA;
          this.reserveB -= amountB;
          return { ok: true, returnValues: [amountA.toString(), amountB.toString()] };
        }
        case "SwapAForB": {
          const amountIn = BigInt(operation.amountIn);
          if (amountIn === 0n) throw new Error("ZeroInput");
          if (this.reserveA === 0n || this.reserveB === 0n) throw new Error("InsufficientLiquidity");
          const amountInWithFee = amountIn * 997n;
          const amountOut = (amountInWithFee * this.reserveB) / (this.reserveA * 1000n + amountInWithFee);
          if (amountOut === 0n || amountOut >= this.reserveB) throw new Error("InsufficientOutput");
          this.reserveA += amountIn;
          this.reserveB -= amountOut;
          return { ok: true, returnValues: [amountOut.toString()] };
        }
        case "GetReserves":
          return { ok: true, returnValues: [this.reserveA.toString(), this.reserveB.toString()] };
        case "GetShares":
          return { ok: true, returnValues: [this.shareOf(operation.user).toString()] };
        case "TotalShares":
          return { ok: true, returnValues: [this.totalShares.toString()] };
      }
    } catch (err) {
      return { ok: false, returnValues: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  snapshot(users: string[]) {
    const entries: SnapshotEntry[] = [
      { key: "reserveA", value: { type: "uint256", value: this.reserveA } },
      { key: "reserveB", value: { type: "uint256", value: this.reserveB } },
      { key: "totalShares", value: { type: "uint256", value: this.totalShares } },
    ];
    for (const user of [...new Set(users)].sort()) {
      entries.push({ key: `shares.${user}`, value: { type: "uint256", value: this.shareOf(user) } });
    }
    return canonicalSnapshot("DEXSwap", entries);
  }

  private shareOf(user: string) {
    return this.shares.get(user) ?? 0n;
  }
}

