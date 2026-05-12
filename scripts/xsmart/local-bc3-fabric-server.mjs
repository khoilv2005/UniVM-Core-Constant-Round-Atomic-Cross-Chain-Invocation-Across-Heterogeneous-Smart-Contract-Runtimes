import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const port = Number(process.env.PORT || "18645");
const dataFile = process.env.DATA_FILE || "/data/fabric-sim-state.json";

const HOTEL_IR_HASH =
  "0x1471a6f5144bc6d79dfcd9410fb81ddabada6deb0664c46be1b23af558521bbb";

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function encodeUint256(value) {
  const out = Buffer.alloc(32);
  out.writeBigUInt64BE(BigInt(value), 24);
  return out;
}

function encodeBytes(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buf.length === 1 && buf[0] < 0x80) return Buffer.from(buf);
  if (buf.length <= 55) return Buffer.concat([Buffer.from([0x80 + buf.length]), buf]);
  const len = encodeLength(buf.length);
  return Buffer.concat([Buffer.from([0xb7 + len.length]), len, buf]);
}

function encodeList(items) {
  const payload = Buffer.concat(items);
  if (payload.length <= 55) return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
  const len = encodeLength(payload.length);
  return Buffer.concat([Buffer.from([0xf7 + len.length]), len, payload]);
}

function encodeLength(value) {
  let hex = Number(value).toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex");
}

function keccak(parts) {
  const h = createHash("sha3-256");
  for (const part of parts) h.update(part);
  return Buffer.from(h.digest());
}

function slotId(contractName, slotName, ...keys) {
  return keccak([Buffer.from("VASSP"), Buffer.from(contractName), Buffer.from(slotName), ...keys]);
}

function encodeString(value) {
  const raw = Buffer.from(String(value), "utf8");
  const paddedLen = Math.ceil(raw.length / 32) * 32;
  const padded = Buffer.alloc(paddedLen);
  raw.copy(padded);
  return Buffer.concat([encodeUint256(raw.length), padded]);
}

function encodeMetaTuple(meta) {
  return Buffer.concat([
    encodeUint256(32 * 4),
    encodeUint256(meta.price),
    encodeUint256(meta.remain),
    encodeUint256(meta.lockSize),
    encodeString(meta.bridge),
  ]);
}

function encodeVassp(state) {
  const pairs = [
    [slotId("HotelBooking", "META"), encodeMetaTuple(state.meta)],
    [slotId("HotelBooking", "LOCK_TOTAL"), encodeUint256(state.lockedTotal)],
  ];
  return encodeList(
    pairs.map(([slot, value]) => encodeList([encodeBytes(slot), encodeBytes(value)]))
  );
}

function defaultState() {
  return {
    meta: {
      bridge: "xbridge_bc3",
      price: 100,
      remain: 2000,
      lockSize: 1,
    },
    bridge: {
      relayerId: "xsmart-relayer",
      stateContract: "hotel_booking",
    },
    lockedTotal: 0,
    locks: {},
    accounts: {},
    bookings: {},
    block: 0,
  };
}

function loadState() {
  if (!existsSync(dataFile)) {
    ensureParent(dataFile);
    const initial = defaultState();
    writeFileSync(dataFile, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  return JSON.parse(readFileSync(dataFile, "utf8"));
}

function saveState(state) {
  ensureParent(dataFile);
  writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
}

function nextBlock(state) {
  state.block += 1;
  return state.block;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function syntheticTxHash(endpoint, message, args, block) {
  return `0x${createHash("sha256")
    .update(JSON.stringify({ endpoint, message, args, block }))
    .digest("hex")}`;
}

function availableRemain(state) {
  const lockedRooms = Math.floor(state.lockedTotal / state.meta.price);
  return Math.max(0, state.meta.remain - lockedRooms);
}

function ensureLockFree(state, txId) {
  const existing = state.locks[txId];
  if (existing && existing.active) throw new Error("already locked");
}

function unlockInternal(state, txId) {
  const entry = state.locks[txId];
  if (!entry || !entry.active) throw new Error("not locked");
  state.lockedTotal = Math.max(0, state.lockedTotal - entry.lockedAmount);
  delete state.locks[txId];
}

function invoke(state, endpoint, message, args) {
  if (endpoint !== "xbridge_bc3") {
    throw new Error(`unknown fabric endpoint ${endpoint}`);
  }

  const txId = String(args.cross_chain_tx_id ?? "");
  const block = nextBlock(state);

  if (message === "bootstrap") {
    state.meta.bridge = String(args.bridge || state.meta.bridge);
    state.meta.price = Number(args.price || state.meta.price);
    state.meta.remain = Number(args.remain || state.meta.remain);
    state.meta.lockSize = Number(args.lock_size || state.meta.lockSize);
    state.bridge.relayerId = String(args.relayer_id || state.bridge.relayerId);
    saveState(state);
    return {
      txHash: syntheticTxHash(endpoint, message, args, block),
      event: {
        name: "FabricBootstrapped",
        args: {
          bridge: state.meta.bridge,
          remain: state.meta.remain,
        },
      },
      state,
    };
  }

  if (!txId) {
    throw new Error("cross_chain_tx_id is required");
  }

  if (message === "receive_lock_request") {
    ensureLockFree(state, txId);
    const num = Number(args.num || 0);
    const timeoutBlocks = Number(args.timeout_blocks || 0);
    if (availableRemain(state) < num) throw new Error("insufficient remain for lock");
    const amt = (num > 0 ? num : state.meta.lockSize) * state.meta.price;
    state.locks[txId] = {
      lockedAmount: amt,
      lockBlock: block,
      timeoutBlocks,
      active: true,
    };
    state.lockedTotal += amt;
    const lockedState = `0x${encodeVassp(state).toString("hex")}`;
    saveState(state);
    return {
      txHash: syntheticTxHash(endpoint, message, args, block),
      event: {
        name: "CrossChainLockResponse",
        args: {
          crossChainTxId: txId,
          stateContract: "hotel_booking",
          lockedState,
          irHash: HOTEL_IR_HASH,
          proof: "0x",
        },
      },
      state,
    };
  }

  if (message === "receive_update_request") {
    unlockInternal(state, txId);
    const newRemain = Number(args.new_remain || 0);
    const user = String(args.user || "");
    const num = Number(args.num || 0);
    const totalCost = Number(args.total_cost || 0);
    state.meta.remain = newRemain;
    state.accounts[user] = Number(state.accounts[user] || 0) + totalCost;
    state.bookings[user] = Number(state.bookings[user] || 0) + num;
    saveState(state);
    return {
      txHash: syntheticTxHash(endpoint, message, args, block),
      event: {
        name: "CrossChainUpdateAck",
        args: {
          crossChainTxId: txId,
          stateContract: "hotel_booking",
          success: true,
        },
      },
      state,
    };
  }

  if (message === "receive_rollback_request") {
    unlockInternal(state, txId);
    saveState(state);
    return {
      txHash: syntheticTxHash(endpoint, message, args, block),
      event: {
        name: "CrossChainRollback",
        args: {
          crossChainTxId: txId,
          stateContract: "hotel_booking",
        },
      },
      state,
    };
  }

  if (message === "receive_timeout_rollback") {
    const entry = state.locks[txId];
    if (!entry || !entry.active) throw new Error("not locked");
    if (block <= Number(entry.lockBlock) + Number(entry.timeoutBlocks || 0)) {
      throw new Error("not timed out");
    }
    unlockInternal(state, txId);
    saveState(state);
    return {
      txHash: syntheticTxHash(endpoint, message, args, block),
      event: {
        name: "CrossChainRollback",
        args: {
          crossChainTxId: txId,
          stateContract: "hotel_booking",
        },
      },
      state,
    };
  }

  throw new Error(`unsupported fabric message ${message}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const state = loadState();

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, block: state.block });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      sendJson(res, 200, state);
      return;
    }
    if (req.method === "POST" && url.pathname === "/invoke") {
      const body = await readBody(req);
      const endpoint = String(body.endpoint || "");
      const message = String(body.message || "");
      const args = body.args || {};
      const result = invoke(state, endpoint, message, args);
      sendJson(res, 200, {
        ok: true,
        txHash: result.txHash,
        blockNumber: result.state.block,
        event: result.event,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`xsmart fabric simulator listening on ${port}`);
});
