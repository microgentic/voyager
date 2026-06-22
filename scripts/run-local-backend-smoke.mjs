import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? "local-bootstrap-secret";
const readyTimeoutMs = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 60_000);
const smokeTimeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function spawnCommand(command, args, options = {}) {
  const { env, ...spawnOptions } = options;
  return spawn(command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      ...env
    },
    ...spawnOptions
  });
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const { commandTimeoutMs, ...spawnOptions } = options;
    const child = spawnCommand(command, args, { stdio: "inherit", ...spawnOptions });
    let timeout;
    let killTimeout;
    let timedOut = false;
    if (commandTimeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, commandTimeoutMs);
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${commandTimeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a smoke-test port");
  }
  return address.port;
}

async function waitForWorker(child, port) {
  let output = "";
  const readyNeedles = [`localhost:${port}`, `127.0.0.1:${port}`, "Ready on"];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`wrangler dev did not become ready within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (readyNeedles.some((needle) => output.includes(needle))) {
        finish();
      }
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => fail(new Error(`wrangler dev exited before readiness with ${code ?? signal}`));

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForHealth(baseUrl) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < readyTimeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Worker health check did not pass: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const sendSignal = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  };
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => sendSignal("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    sendSignal("SIGTERM");
  });
}

const persistDir = await mkdtemp(join(tmpdir(), "voyager-backend-smoke-"));
const port = await freePort();
let worker;
const workerVars = [
  `BOOTSTRAP_TOKEN:${bootstrapToken}`,
  "CALL_RING_TIMEOUT_MS:5000",
  "CALLS_ENABLED:1",
  "AUDIO_CALLS_ENABLED:1",
  "VIDEO_CALLS_ENABLED:1",
  "SCREEN_SHARE_ENABLED:1",
  "CALLS_REALTIME_MEDIA_ENABLED:1"
];
if (process.env.CLOUDFLARE_REALTIME_MOCK === "1") {
  workerVars.push("CLOUDFLARE_REALTIME_MOCK:1");
}

try {
  await runCommand(npx, ["wrangler", "d1", "migrations", "apply", "voyager-dev-control", "--local", "--persist-to", persistDir], {
    commandTimeoutMs: 60_000
  });

  worker = spawnCommand(npx, [
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persistDir,
    "--port",
    String(port),
    ...workerVars.flatMap((value) => ["--var", value]),
    "--show-interactive-dev-session=false"
  ], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForWorker(worker, port);
  await waitForHealth(baseUrl);
  await runCommand("node", ["scripts/backend-first-smoke.mjs"], {
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      BOOTSTRAP_TOKEN: bootstrapToken
    },
    commandTimeoutMs: smokeTimeoutMs
  });
} finally {
  if (worker) {
    await terminate(worker);
  }
  if (process.env.KEEP_SMOKE_STATE !== "1") {
    await rm(persistDir, { recursive: true, force: true });
  } else {
    console.log(`Kept smoke state at ${persistDir}`);
  }
}
