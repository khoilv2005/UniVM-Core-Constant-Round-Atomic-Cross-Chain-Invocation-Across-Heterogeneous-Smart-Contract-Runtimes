import * as fs from "fs";
import { execFileSync, spawn } from "child_process";

const DEFAULT_PROXY_NAME = "xsmart-bc2-remote-proxy";
const DEFAULT_PROXY_PORT = "9944";

function run(command: string, args: string[], cwd: string, allowFailure = false) {
  try {
    return execFileSync(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: process.env,
      shell: process.platform === "win32",
    });
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    throw error;
  }
}

function sleepSeconds(seconds: number, cwd: string) {
  execFileSync("powershell", ["-Command", `Start-Sleep -Seconds ${seconds}`], {
    cwd,
    stdio: "ignore",
    env: process.env,
    shell: process.platform === "win32",
  });
}

function dockerReady(root: string): boolean {
  try {
    run("docker", ["version"], root);
    return true;
  } catch {
    return false;
  }
}

function ensureDockerDaemon(root: string) {
  if (dockerReady(root)) {
    return;
  }

  const desktopExe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
  if (process.platform === "win32" && fs.existsSync(desktopExe)) {
    const child = spawn(desktopExe, [], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    if (dockerReady(root)) {
      return;
    }
    sleepSeconds(2, root);
  }
  throw new Error("Docker daemon is not ready; required for bc2 remote proxy");
}

export function ensureBC2RemoteDockerProxy(root: string, remoteWsUrl: string): string {
  ensureDockerDaemon(root);
  const target = new URL(remoteWsUrl);
  const proxyName = process.env.XSMART_BC2_PROXY_CONTAINER?.trim() || `${DEFAULT_PROXY_NAME}-${process.pid}`;
  const listenPort = process.env.XSMART_BC2_PROXY_PORT?.trim() || DEFAULT_PROXY_PORT;
  const targetPort = target.port || (target.protocol === "wss:" ? "443" : "80");
  if (target.protocol !== "ws:") {
    throw new Error(`bc2 remote proxy only supports ws:// endpoints, got ${remoteWsUrl}`);
  }

  run("docker", ["rm", "-f", proxyName], root, true);
  run("docker", [
    "run", "-d",
    "--name", proxyName,
    "alpine/socat",
    "-d", "-d",
    `TCP-LISTEN:${listenPort},fork,reuseaddr`,
    `TCP:${target.hostname}:${targetPort}`,
  ], root);

  process.env.XSMART_BC2_DOCKER_NETWORK = `container:${proxyName}`;
  process.env.XSMART_BC2_DOCKER_WS_URL = `ws://127.0.0.1:${listenPort}`;
  process.env.XSMART_BC2_DEPLOY_MODE = "prod";
  return proxyName;
}

export function stopBC2RemoteDockerProxy(root: string, proxyName?: string) {
  const effectiveName = proxyName || process.env.XSMART_BC2_PROXY_CONTAINER?.trim() || DEFAULT_PROXY_NAME;
  run("docker", ["rm", "-f", effectiveName], root, true);
}
