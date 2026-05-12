import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { ContractPromise } from "@polkadot/api-contract";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

type InvokeEnvelope = {
  version?: number;
  contract?: string;
  message: string;
  args: Record<string, unknown>;
};

type DeploymentRecord = {
  contracts?: Record<string, string>;
};

type InvokeRequest = {
  endpoint?: string;
  envelope?: InvokeEnvelope;
};

type InvokeResult = {
  ok: true;
  txHash: string;
  blockNumber: number;
  event: {
    endpoint: string;
    name: string;
    args: Record<string, unknown>;
  };
};

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_PORT = 18745;

function loadDeployment(): DeploymentRecord {
  const file = path.join(ROOT, "deployments", "xsmart", "bc2.json");
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as DeploymentRecord;
}

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function camelMessage(message: string): string {
  return message.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function uintArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing WASM arg ${name}`);
  }
  return String(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing WASM string arg ${name}`);
  }
  return value.trim();
}

function boolArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

function messageArgs(envelope: InvokeEnvelope): unknown[] {
  switch (envelope.message) {
    case "receive_lock_request":
      return [
        uintArg(envelope.args, "cross_chain_tx_id"),
        uintArg(envelope.args, "num"),
        uintArg(envelope.args, "timeout_blocks"),
      ];
    case "receive_update_request":
      return [
        uintArg(envelope.args, "cross_chain_tx_id"),
        uintArg(envelope.args, "new_remain"),
        stringArg(envelope.args, "user"),
        uintArg(envelope.args, "num"),
        uintArg(envelope.args, "total_cost"),
      ];
    case "receive_rollback_request":
    case "receive_timeout_rollback":
      return [uintArg(envelope.args, "cross_chain_tx_id")];
    case "gpact_segment":
      return [
        stringArg(envelope.args, "tx_id"),
        stringArg(envelope.args, "call_tree_hash"),
        uintArg(envelope.args, "chain_id"),
        uintArg(envelope.args, "segment_id"),
      ];
    case "gpact_signalling":
      return [
        stringArg(envelope.args, "tx_id"),
        stringArg(envelope.args, "call_tree_hash"),
        uintArg(envelope.args, "chain_id"),
        uintArg(envelope.args, "segment_id"),
        boolArg(envelope.args, "commit"),
        boolArg(envelope.args, "abort_tx"),
      ];
    case "gpact_timeout_unlock":
      return [
        stringArg(envelope.args, "tx_id"),
        uintArg(envelope.args, "chain_id"),
        uintArg(envelope.args, "segment_id"),
      ];
    case "atom_lock_do":
      return [
        stringArg(envelope.args, "invoke_id"),
        stringArg(envelope.args, "lock_hash"),
        stringArg(envelope.args, "kind"),
        stringArg(envelope.args, "user"),
        uintArg(envelope.args, "amount_a"),
        uintArg(envelope.args, "amount_b"),
      ];
    case "atom_unlock":
    case "atom_undo_unlock":
      return [
        stringArg(envelope.args, "invoke_id"),
        stringArg(envelope.args, "hash_key_hex"),
        stringArg(envelope.args, "kind"),
      ];
    default:
      throw new Error(`unsupported WASM message ${envelope.message}`);
  }
}

function syntheticEvent(endpoint: string, envelope: InvokeEnvelope): InvokeResult["event"] {
  switch (envelope.message) {
    case "receive_lock_request":
      const lockTxId = uintArg(envelope.args, "cross_chain_tx_id");
      return {
        endpoint,
        name: "CrossChainLockResponse",
        args: {
          crossChainTxId: lockTxId,
          stateContract: "0x0000000000000000000000000000000000000000",
          lockedState: "0x",
          irHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          proof: "0x",
        },
      };
    case "receive_update_request":
      const updateTxId = uintArg(envelope.args, "cross_chain_tx_id");
      return {
        endpoint,
        name: "CrossChainUpdateAck",
        args: {
          crossChainTxId: updateTxId,
          stateContract: "0x0000000000000000000000000000000000000000",
          success: true,
        },
      };
    case "receive_rollback_request":
    case "receive_timeout_rollback":
      const rollbackTxId = uintArg(envelope.args, "cross_chain_tx_id");
      return {
        endpoint,
        name: "CrossChainRollback",
        args: {
          crossChainTxId: rollbackTxId,
        },
      };
    case "gpact_segment":
      return {
        endpoint,
        name: "SegmentEvent",
        args: {
          crosschainTxId: stringArg(envelope.args, "tx_id"),
          chainId: uintArg(envelope.args, "chain_id"),
          segmentId: uintArg(envelope.args, "segment_id"),
          callTreeHash: stringArg(envelope.args, "call_tree_hash"),
          success: true,
          locked: true,
          result: "0x",
        },
      };
    case "gpact_signalling":
      return {
        endpoint,
        name: "SignallingEvent",
        args: {
          crosschainTxId: stringArg(envelope.args, "tx_id"),
          chainId: uintArg(envelope.args, "chain_id"),
          segmentId: uintArg(envelope.args, "segment_id"),
          commit: String(envelope.args.commit ?? "false") === "true",
        },
      };
    case "gpact_timeout_unlock":
      return {
        endpoint,
        name: "SignallingEvent",
        args: {
          crosschainTxId: stringArg(envelope.args, "tx_id"),
          chainId: uintArg(envelope.args, "chain_id"),
          segmentId: uintArg(envelope.args, "segment_id"),
          commit: false,
        },
      };
    case "atom_lock_do":
      return {
        endpoint,
        name: atomEventName(envelope.args, "Locked"),
        args: {
          invokeId: stringArg(envelope.args, "invoke_id"),
        },
      };
    case "atom_unlock":
      return {
        endpoint,
        name: atomEventName(envelope.args, "Unlocked"),
        args: {
          invokeId: stringArg(envelope.args, "invoke_id"),
        },
      };
    case "atom_undo_unlock":
      return {
        endpoint,
        name: atomEventName(envelope.args, "UndoUnlocked"),
        args: {
          invokeId: stringArg(envelope.args, "invoke_id"),
        },
      };
    default:
      throw new Error(`unsupported WASM message ${envelope.message}`);
  }
}

function atomEventName(args: Record<string, unknown>, suffix: string): string {
  const kind = stringArg(args, "kind").toLowerCase();
  if (kind.includes("train")) {
    return `AtomTrain${suffix}`;
  }
  if (kind.includes("flight")) {
    return `AtomFlight${suffix}`;
  }
  if (kind.includes("taxi")) {
    return `AtomTaxi${suffix}`;
  }
  return `AtomHotel${suffix}`;
}

function isAdapterMessage(message: string): boolean {
  return message.startsWith("gpact_") || message.startsWith("atom_");
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() === "" ? {} : JSON.parse(raw);
}

function writeJson(res: http.ServerResponse, code: number, payload: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function timeoutError(message: string, timeoutMs: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${message} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
}

async function main() {
  await cryptoWaitReady();

  const deployment = loadDeployment();
  const contracts = deployment.contracts ?? {};
  const wsUrl = env("BC2_WASM_WS_URL", contracts.bc2RpcWs || "ws://127.0.0.1:9944");
  const defaultEndpoint = env("XSMART_BC2_BRIDGE_CONTRACT", contracts.xBridgeBc2 || "");
  const metadataPath = env(
    "XSMART_BC2_BRIDGE_METADATA",
    contracts.bc2BridgeMetadataPath || path.join(ROOT, "contracts", "xsmart", "bc2", "bridge", "target", "ink", "xbridge_bc2.contract"),
  );
  const suri = env("XSMART_BC2_SURI", contracts.bc2SubmitterURI || "//Alice");
  const port = Number(env("XSMART_WASM_DAEMON_PORT", String(DEFAULT_PORT)));
  const invokeTimeoutMs = Number(env("XSMART_WASM_INVOKE_TIMEOUT_MS", "120000"));

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`missing WASM bridge metadata: ${metadataPath}`);
  }

  const provider = new WsProvider(wsUrl);
  const api = await ApiPromise.create({ provider });
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
  const keyring = new Keyring({ type: "sr25519" });
  const signer = keyring.addFromUri(suri);
  const gasLimit = api.registry.createType("WeightV2", {
    refTime: "500000000000",
    proofSize: "500000",
  });
  let queue: Promise<unknown> = Promise.resolve();

  async function invoke(request: InvokeRequest): Promise<InvokeResult> {
    const envelope = request.envelope;
    if (!envelope || !envelope.message || !envelope.args) {
      throw new Error("missing WASM invoke envelope");
    }
    const target = (request.endpoint || envelope.contract || defaultEndpoint).trim();
    if (!target) {
      throw new Error("missing WASM endpoint");
    }

    const contract = new ContractPromise(api, metadata, target);
    const method = camelMessage(envelope.message);
    const txFactory = (contract.tx as Record<string, unknown>)[method] || (contract.tx as Record<string, unknown>)[envelope.message];
    if (typeof txFactory !== "function") {
      throw new Error(`WASM contract method not found: ${envelope.message}`);
    }

    const args = messageArgs(envelope);
    const txLabel = String(
      envelope.args.tx_id ??
      envelope.args.invoke_id ??
      envelope.args.cross_chain_tx_id ??
      "unknown",
    );
    console.log(`[xsmart-wasm-daemon] invoke start message=${envelope.message} tx=${txLabel}`);
    const extrinsic = (txFactory as (...values: unknown[]) => any)({
      gasLimit,
      storageDepositLimit: null,
    }, ...args);
    let txHash = extrinsic.hash.toHex();

    const waitFinalized = env("XSMART_WASM_WAIT_FINALIZED", "1") === "1";
    const blockNumber = await Promise.race([
      new Promise<number>(async (resolve, reject) => {
      let unsub: (() => void) | undefined;
      const done = (fn: () => void) => {
        try {
          if (unsub) {
            unsub();
          }
        } catch {
        }
        fn();
      };
      try {
        unsub = await extrinsic.signAndSend(signer, (result: any) => {
          if (result.dispatchError) {
            done(() => reject(new Error(result.dispatchError.toString())));
            return;
          }
          if (!waitFinalized && result.status?.isInBlock) {
            api.rpc.chain.getHeader(result.status.asInBlock)
              .then((header) => done(() => resolve(header.number.toNumber())))
              .catch((error) => done(() => reject(error)));
            return;
          }
          if (waitFinalized && result.status?.isFinalized) {
            api.rpc.chain.getHeader(result.status.asFinalized)
              .then((header) => done(() => resolve(header.number.toNumber())))
              .catch((error) => done(() => reject(error)));
          }
        });
      } catch (error) {
        done(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
      }),
      timeoutError(`WASM invoke ${envelope.message} tx=${txLabel}`, invokeTimeoutMs),
    ]);
    console.log(`[xsmart-wasm-daemon] invoke done message=${envelope.message} tx=${txLabel} block=${blockNumber}`);

    return {
      ok: true,
      txHash,
      blockNumber,
      event: syntheticEvent(target, envelope),
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, { ok: true, endpoint: defaultEndpoint, wsUrl });
        return;
      }
      if (req.method === "POST" && req.url === "/invoke") {
        const request = await readJsonBody(req) as InvokeRequest;
        const task = queue.then(() => invoke(request));
        queue = task.catch(() => undefined);
        writeJson(res, 200, await task);
        return;
      }
      writeJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      console.error(`[xsmart-wasm-daemon] request failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[xsmart-wasm-daemon] listening on http://127.0.0.1:${port} defaultEndpoint=${defaultEndpoint || "(dynamic)"} ws=${wsUrl}`);
  });

  const shutdown = async () => {
    server.close();
    await api.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
