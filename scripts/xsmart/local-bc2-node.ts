import { execFileSync } from "child_process";
import * as http from "http";
import * as path from "path";
import { banner, repoRoot } from "../common";

export const LOCAL_BC2_NODE_IMAGE = "xsmart-substrate-contracts-node:local";
export const LOCAL_BC2_NODE_CONTAINER = "xsmart-bc2-local";
export const LOCAL_BC2_HTTP_URL =
  process.env.BC2_WASM_HTTP_URL || "http://127.0.0.1:18545";
export const LOCAL_BC2_WS_URL =
  process.env.BC2_WASM_WS_URL || "ws://127.0.0.1:18545";

function run(
  command: string,
  args: string[],
  cwd: string,
  stdio: "inherit" | "pipe" = "inherit"
): string {
  const out = execFileSync(command, args, {
    cwd,
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
  });
  return String(out ?? "").trim();
}

function tryRun(command: string, args: string[], cwd: string): string | null {
  try {
    return run(command, args, cwd, "pipe");
  } catch {
    return null;
  }
}

function dockerfilePath(root: string): string {
  return path.join(root, "docker", "xsmart-substrate-contracts-node.Dockerfile");
}

function imageExists(root: string): boolean {
  const out = tryRun("docker", ["image", "inspect", LOCAL_BC2_NODE_IMAGE], root);
  return Boolean(out && out.trim().length > 0);
}

function buildImage(root: string) {
  run(
    "docker",
    ["build", "-t", LOCAL_BC2_NODE_IMAGE, "-f", dockerfilePath(root), root],
    root
  );
}

function containerRunning(root: string): boolean {
  const out = tryRun(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", LOCAL_BC2_NODE_CONTAINER],
    root
  );
  return out?.trim() === "true";
}

function containerExists(root: string): boolean {
  const out = tryRun(
    "docker",
    ["inspect", "-f", "{{.Name}}", LOCAL_BC2_NODE_CONTAINER],
    root
  );
  return Boolean(out && out.trim().length > 0);
}

function removeContainer(root: string) {
  if (containerExists(root)) {
    run("docker", ["rm", "-f", LOCAL_BC2_NODE_CONTAINER], root);
  }
}

function rpcReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "chain_getHeader",
      params: [],
    });
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 2000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          resolve(res.statusCode === 200 && raw.includes("\"result\""));
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function waitReady(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rpcReady(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for local bc2 node RPC at ${url}`);
}

export async function ensureLocalBC2Node(root = repoRoot()) {
  if (process.env.XSMART_BC2_FORCE_NODE_BUILD === "1" || !imageExists(root)) {
    buildImage(root);
  }
  if (!containerRunning(root)) {
    removeContainer(root);
    run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        LOCAL_BC2_NODE_CONTAINER,
        "-p",
        "18545:9944",
        LOCAL_BC2_NODE_IMAGE,
      ],
      root
    );
  }
  await waitReady(LOCAL_BC2_HTTP_URL, 60000);
}

export function stopLocalBC2Node(root = repoRoot()) {
  removeContainer(root);
}

async function main() {
  const mode = process.argv[2] || "start";
  banner("xsmart", `bc2-local-${mode}`);
  const root = repoRoot();
  if (mode === "stop") {
    stopLocalBC2Node(root);
    console.log(`Stopped ${LOCAL_BC2_NODE_CONTAINER}`);
    return;
  }
  if (mode === "status") {
    console.log(
      JSON.stringify(
        {
          image: LOCAL_BC2_NODE_IMAGE,
          container: LOCAL_BC2_NODE_CONTAINER,
          running: containerRunning(root),
          httpUrl: LOCAL_BC2_HTTP_URL,
          wsUrl: LOCAL_BC2_WS_URL,
        },
        null,
        2
      )
    );
    return;
  }
  await ensureLocalBC2Node(root);
  console.log(`Local bc2 node ready at ${LOCAL_BC2_HTTP_URL}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
