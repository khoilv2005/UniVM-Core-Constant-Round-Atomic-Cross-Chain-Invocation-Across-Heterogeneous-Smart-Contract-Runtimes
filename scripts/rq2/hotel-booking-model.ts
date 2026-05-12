import { SnapshotEntry, canonicalSnapshot } from "./canonical-snapshot";

export type HotelInitialState = {
  bridge: string;
  price: string;
  remain: string;
  lockSize: string;
};

export type HotelOperation =
  | { kind: "BookLocal"; user: string; amount: string }
  | { kind: "LockState"; lockId: string; amount: string; timeoutBlocks: string }
  | { kind: "UnlockState"; lockId: string }
  | { kind: "GetPrice" }
  | { kind: "GetRemain" }
  | { kind: "GetAvailableRemain" }
  | { kind: "GetAccountBalance"; user: string }
  | { kind: "GetBooking"; user: string }
  | { kind: "IsStateLocked"; lockId: string };

export type OperationResult = {
  ok: boolean;
  returnValues: string[];
  error?: string;
};

type LockEntry = {
  lockedAmount: bigint;
  active: boolean;
};

export class HotelBookingModel {
  bridge: string;
  price: bigint;
  remain: bigint;
  lockSize: bigint;
  lockedTotal = 0n;
  accounts = new Map<string, bigint>();
  bookings = new Map<string, bigint>();
  locks = new Map<string, LockEntry>();

  constructor(initial: HotelInitialState) {
    this.bridge = initial.bridge;
    this.price = BigInt(initial.price);
    this.remain = BigInt(initial.remain);
    this.lockSize = BigInt(initial.lockSize);
    if (this.price <= 0n) {
      throw new Error("price must be > 0");
    }
    if (this.lockSize <= 0n) {
      this.lockSize = 1n;
    }
  }

  execute(operation: HotelOperation): OperationResult {
    try {
      switch (operation.kind) {
        case "BookLocal": {
          const amount = BigInt(operation.amount);
          if (amount === 0n) throw new Error("zero amount");
          if (this.availableRemain() < amount) throw new Error("insufficient available rooms");
          const cost = this.price * amount;
          this.remain -= amount;
          this.accounts.set(operation.user, this.balanceOf(operation.user) + cost);
          this.bookings.set(operation.user, this.bookingOf(operation.user) + amount);
          return { ok: true, returnValues: [cost.toString()] };
        }
        case "LockState": {
          const amount = BigInt(operation.amount);
          if (this.locks.get(operation.lockId)?.active) throw new Error("already locked");
          if (this.availableRemain() < amount) throw new Error("insufficient remain for lock");
          const lockedAmount = (amount > 0n ? amount : this.lockSize) * this.price;
          this.locks.set(operation.lockId, { lockedAmount, active: true });
          this.lockedTotal += lockedAmount;
          return { ok: true, returnValues: [this.price.toString(), this.remain.toString()] };
        }
        case "UnlockState": {
          const lock = this.locks.get(operation.lockId);
          if (!lock?.active) throw new Error("not locked");
          this.lockedTotal = this.lockedTotal > lock.lockedAmount ? this.lockedTotal - lock.lockedAmount : 0n;
          this.locks.delete(operation.lockId);
          return { ok: true, returnValues: [] };
        }
        case "GetPrice":
          return { ok: true, returnValues: [this.price.toString()] };
        case "GetRemain":
          return { ok: true, returnValues: [this.remain.toString()] };
        case "GetAvailableRemain":
          return { ok: true, returnValues: [this.availableRemain().toString()] };
        case "GetAccountBalance":
          return { ok: true, returnValues: [this.balanceOf(operation.user).toString()] };
        case "GetBooking":
          return { ok: true, returnValues: [this.bookingOf(operation.user).toString()] };
        case "IsStateLocked":
          return { ok: true, returnValues: [String(this.locks.get(operation.lockId)?.active === true)] };
        default: {
          const neverOperation: never = operation;
          throw new Error(`unknown operation ${(neverOperation as HotelOperation).kind}`);
        }
      }
    } catch (err) {
      return { ok: false, returnValues: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  snapshot(touchedUsers: string[], touchedLocks: string[]) {
    const entries: SnapshotEntry[] = [
      { key: "meta.bridge", value: { type: "string", value: this.bridge } },
      { key: "meta.price", value: { type: "uint256", value: this.price } },
      { key: "meta.remain", value: { type: "uint256", value: this.remain } },
      { key: "meta.lockSize", value: { type: "uint256", value: this.lockSize } },
      { key: "lockedTotal", value: { type: "uint256", value: this.lockedTotal } },
      { key: "availableRemain", value: { type: "uint256", value: this.availableRemain() } },
    ];

    for (const user of [...new Set(touchedUsers)].sort()) {
      entries.push({ key: `accounts.${user}`, value: { type: "uint256", value: this.balanceOf(user) } });
      entries.push({ key: `bookings.${user}`, value: { type: "uint256", value: this.bookingOf(user) } });
    }
    for (const lockId of [...new Set(touchedLocks)].sort()) {
      entries.push({
        key: `locks.${lockId}.active`,
        value: { type: "bool", value: this.locks.get(lockId)?.active === true },
      });
      entries.push({
        key: `locks.${lockId}.lockedAmount`,
        value: { type: "uint256", value: this.locks.get(lockId)?.lockedAmount ?? 0n },
      });
    }
    return canonicalSnapshot("HotelBooking", entries);
  }

  private availableRemain(): bigint {
    const lockedUnits = this.lockedTotal / this.price;
    return this.remain > lockedUnits ? this.remain - lockedUnits : 0n;
  }

  private balanceOf(user: string): bigint {
    return this.accounts.get(user) ?? 0n;
  }

  private bookingOf(user: string): bigint {
    return this.bookings.get(user) ?? 0n;
  }
}
