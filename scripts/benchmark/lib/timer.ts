/**
 * Unified event-timestamp logger used across all baselines + XSmartContract.
 *
 * Contract:
 *   - t0 = moment the client calls submit() (user-visible cross-chain submit)
 *   - t1 = moment the final confirmation event is observed on the user's chain
 *          (e.g. CrossChainUpdateAck / SignallingEvent / InvocationSettled)
 *   - latency_ms = t1 - t0 (wall-clock, Date.now())
 *
 * Output format: newline-delimited JSON (JSONL).
 * One file per (system, depth, run) triple so a crashed run never corrupts
 * earlier results.
 */

import * as fs from "fs";
import * as path from "path";

export type TimerEvent =
  | "SUBMIT"
  | "LOCK_REQ"
  | "LOCK_ACK"
  | "EXECUTE"
  | "UPDATE_REQ"
  | "UPDATE_ACK"
  | "ROOT"
  | "SIGNAL"
  | "SEGMENT"
  | "INVOKE_INIT"
  | "JUDGE_VOTE"
  | "SETTLE"
  | "FINAL_CONFIRM"
  | "ABORT"
  | "ERROR";

export interface TimerRecord {
  ts_ms: number;
  event: TimerEvent;
  system: string;
  depth: number;
  run: number;
  tx_id: string;
  block?: number;
  detail?: Record<string, unknown>;
}

export interface TimerSummary {
  system: string;
  depth: number;
  run: number;
  tx_id: string;
  t0_submit_ms: number | null;
  t1_final_ms: number | null;
  latency_ms: number | null;
  status: "ok" | "error" | "timeout";
  error?: string;
  events: TimerRecord[];
}

export interface TimerOptions {
  system: string; // "integratex" | "atom" | "gpact" | "xsmart"
  depth: number;
  run: number;
  outDir: string; // benchmark-results/<timestamp>/jsonl/
}

export class Timer {
  private readonly events: TimerRecord[] = [];
  private readonly opts: TimerOptions;
  private tx: string = "";
  private status: "ok" | "error" | "timeout" = "ok";
  private err?: string;

  constructor(opts: TimerOptions) {
    this.opts = opts;
    fs.mkdirSync(opts.outDir, { recursive: true });
  }

  setTxId(id: string) {
    this.tx = id;
  }

  stamp(event: TimerEvent, detail?: Record<string, unknown>, block?: number) {
    const rec: TimerRecord = {
      ts_ms: Date.now(),
      event,
      system: this.opts.system,
      depth: this.opts.depth,
      run: this.opts.run,
      tx_id: this.tx,
      block,
      detail,
    };
    this.events.push(rec);
    return rec;
  }

  markError(err: string) {
    this.status = "error";
    this.err = err;
    this.stamp("ERROR", { error: err });
  }

  markTimeout() {
    this.status = "timeout";
    this.stamp("ABORT", { reason: "timeout" });
  }

  summary(): TimerSummary {
    const submit = this.events.find((e) => e.event === "SUBMIT");
    const final = [...this.events]
      .reverse()
      .find((e) => e.event === "FINAL_CONFIRM");
    const t0 = submit?.ts_ms ?? null;
    const t1 = final?.ts_ms ?? null;
    return {
      system: this.opts.system,
      depth: this.opts.depth,
      run: this.opts.run,
      tx_id: this.tx,
      t0_submit_ms: t0,
      t1_final_ms: t1,
      latency_ms: t0 !== null && t1 !== null ? t1 - t0 : null,
      status: this.status,
      error: this.err,
      events: this.events,
    };
  }

  flush(): string {
    const sum = this.summary();
    const fname = `${this.opts.system}_d${this.opts.depth}_r${String(
      this.opts.run
    ).padStart(3, "0")}.jsonl`;
    const fpath = path.join(this.opts.outDir, fname);
    const lines = [
      JSON.stringify({ kind: "summary", ...sum, events: undefined }),
      ...this.events.map((e) => JSON.stringify({ kind: "event", ...e })),
    ];
    fs.writeFileSync(fpath, lines.join("\n") + "\n");
    return fpath;
  }
}

/** Convenience helper to start a timer + stamp SUBMIT in one call. */
export function startRun(opts: TimerOptions): Timer {
  const t = new Timer(opts);
  t.stamp("SUBMIT");
  return t;
}
