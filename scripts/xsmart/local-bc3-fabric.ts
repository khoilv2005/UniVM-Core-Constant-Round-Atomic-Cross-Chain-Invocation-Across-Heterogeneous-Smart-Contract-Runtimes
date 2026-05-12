import { execFileSync } from "child_process";
import * as http from "http";
import * as path from "path";
import { banner, repoRoot } from "../common";

export const LOCAL_BC3_FABRIC_IMAGE = "xsmart-fabric-sim:local";
export const LOCAL_BC3_FABRIC_CONTAINER = "xsmart-bc3-fabric-local";
export const LOCAL_BC3_FABRIC_HTTP_URL =
  process.env.BC3_FABRIC_HTTP_URL || "http://127.0.0.1:18645";

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
  return path.join(root, "docker", "xsmart-fabric-sim.Dockerfile");
}

function imageExists(root: string): boolean {
  const out = tryRun("docker", ["image", "inspect", LOCAL_BC3_FABRIC_IMAGE], root);
  return Boolean(out && out.trim().length > 0);
}

function buildImage(root: string) {
  run(
    "docker",
    ["build", "-t", LOCAL_BC3_FABRIC_IMAGE, "-f", dockerfilePath(root), root],
    root
  );
}

function containerRunning(root: string): boolean {
  const out = tryRun(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", LOCAL_BC3_FABRIC_CONTAINER],
    root
  );
  return out?.trim() === "true";
}

function containerExists(root: string): boolean {
  const out = tryRun(
    "docker",
    ["inspect", "-f", "{{.Name}}", LOCAL_BC3_FABRIC_CONTAINER],
    root
  );
  return Boolean(out && out.trim().length > 0);
}

function removeContainer(root: string) {
  if (containerExists(root)) {
    run("docker", ["rm", "-f", LOCAL_BC3_FABRIC_CONTAINER], root);
  }
}

function health(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(`${url}/health`, { method: "GET", timeout: 2000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += String(chunk);
      });
      res.on("end", () => {
        resolve(res.statusCode === 200 && raw.includes("\"ok\":true"));
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitReady(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for local bc3 fabric simulator at ${url}`);
}

export async function ensureLocalBC3Fabric(root = repoRoot()) {
  if (process.env.XSMART_BC3_FORCE_IMAGE_BUILD === "1" || !imageExists(root)) {
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
        LOCAL_BC3_FABRIC_CONTAINER,
        "-p",
        "18645:18645",
        LOCAL_BC3_FABRIC_IMAGE,
      ],
      root
    );
  }
  await waitReady(LOCAL_BC3_FABRIC_HTTP_URL, 30000);
}

export function stopLocalBC3Fabric(root = repoRoot()) {
  removeContainer(root);
}

async function main() {
  const mode = process.argv[2] || "start";
  banner("xsmart", `bc3-fabric-local-${mode}`);
  const root = repoRoot();
  if (mode === "stop") {
    stopLocalBC3Fabric(root);
    console.log(`Stopped ${LOCAL_BC3_FABRIC_CONTAINER}`);
    return;
  }
  if (mode === "status") {
    console.log(
      JSON.stringify(
        {
          image: LOCAL_BC3_FABRIC_IMAGE,
          container: LOCAL_BC3_FABRIC_CONTAINER,
          running: containerRunning(root),
          httpUrl: LOCAL_BC3_FABRIC_HTTP_URL,
        },
        null,
        2
      )
    );
    return;
  }
  await ensureLocalBC3Fabric(root);
  console.log(`Local bc3 fabric simulator ready at ${LOCAL_BC3_FABRIC_HTTP_URL}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
