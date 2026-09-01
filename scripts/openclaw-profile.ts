import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DISCORD_CHANNEL_ALLOWLIST_PATH,
  OPENCLAW_DISCORD_TOKEN_ENV,
  OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_TOKEN_ENV,
  OPENCLAW_PROFILE_NAME,
  OPENCLAW_RUNTIME_ROOT,
  OPENCLAW_VERSION,
  OPENCLAW_WORKSPACE_DIRECTORY
} from "../src/constants.js";
import { JsonDiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import {
  buildOpenClawProfilePatch,
  buildOpenClawProfileReplacementPaths
} from "../src/openclaw/openclaw-profile-config.js";
import {
  assertOpenClawGatewayPortIsolation,
  isSupportedOpenClawNodeVersion,
  parseListeningTcpPorts,
  requirePinnedOpenClawVersion
} from "../src/openclaw/openclaw-runtime.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_STATE_ROOT = join(homedir(), `.openclaw-${OPENCLAW_PROFILE_NAME}`);
const PROFILE_ENV_PATH = join(PROFILE_STATE_ROOT, ".env");
const OPENCLAW_ENTRY_PATH = join(
  PROJECT_ROOT,
  "node_modules",
  "openclaw",
  "openclaw.mjs"
);

type ProfileCommand =
  | "prepare"
  | "seed-secrets"
  | "auth"
  | "install"
  | "start"
  | "stop"
  | "status"
  | "validate"
  | "security";

async function main(): Promise<void> {
  const command = process.argv[2] as ProfileCommand | undefined;
  if (!command) {
    throw new Error(
      "Usage: npm run openclaw:profile -- <prepare|seed-secrets|auth|install|start|stop|status|validate|security>"
    );
  }
  const nodeBinary = await resolveNodeBinary();
  await verifyRuntime(nodeBinary);
  if (command === "prepare") {
    await prepareProfile(nodeBinary);
    process.stdout.write("The isolated OpenClaw profile is prepared.\n");
    return;
  }
  if (command === "seed-secrets") {
    await seedProfileSecrets();
    process.stdout.write("The isolated profile secret file is ready.\n");
    return;
  }
  if (command === "auth") {
    await runOpenClaw(
      nodeBinary,
      ["models", "auth", "login", "--provider", "openai", "--device-code", "--set-default"],
      { inherit: true }
    );
    return;
  }
  if (command === "install") {
    await requireProfileSecrets();
    await runOpenClaw(
      nodeBinary,
      ["gateway", "install", "--port", String(OPENCLAW_GATEWAY_PORT), "--runtime", "node"]
    );
    process.stdout.write("The isolated OpenClaw managed service is installed.\n");
    return;
  }
  if (command === "start" || command === "stop") {
    await runOpenClaw(nodeBinary, ["gateway", command]);
    process.stdout.write(`The isolated OpenClaw service ${command} command completed.\n`);
    return;
  }
  if (command === "status") {
    await runOpenClaw(nodeBinary, ["gateway", "status", "--deep", "--json"]);
    process.stdout.write("The isolated OpenClaw profile status check passed.\n");
    return;
  }
  if (command === "validate") {
    await runOpenClaw(nodeBinary, ["config", "validate"]);
    await runOpenClaw(nodeBinary, ["plugins", "inspect", "image-feedback-round", "--runtime", "--json"]);
    process.stdout.write("The isolated OpenClaw config and plugin contract are valid.\n");
    return;
  }
  if (command === "security") {
    await runOpenClaw(nodeBinary, ["security", "audit", "--json"]);
    process.stdout.write("The isolated OpenClaw security audit completed.\n");
    return;
  }
  throw new Error("Unsupported OpenClaw profile command.");
}

async function prepareProfile(nodeBinary: string): Promise<void> {
  const listenerOutput = await spawnCaptured(
    "/usr/sbin/lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"],
    undefined,
    [0, 1]
  );
  assertOpenClawGatewayPortIsolation(
    OPENCLAW_GATEWAY_PORT,
    parseListeningTcpPorts(listenerOutput)
  );
  const configured = await new JsonDiscordChannelAllowlistStore(
    join(PROJECT_ROOT, DISCORD_CHANNEL_ALLOWLIST_PATH)
  ).getAll();
  if (configured.length !== 1) {
    throw new Error("Configure exactly one Discord channel before preparing OpenClaw.");
  }
  const channelUrl = new URL(configured[0] as string);
  const parts = channelUrl.pathname.split("/").filter(Boolean);
  const guildId = parts[1];
  const channelId = parts[2];
  if (!guildId || guildId === "@me" || !channelId) {
    throw new Error("The OpenClaw POC requires one configured Discord server channel.");
  }
  await mkdir(
    join(PROJECT_ROOT, OPENCLAW_RUNTIME_ROOT, OPENCLAW_WORKSPACE_DIRECTORY),
    {
    recursive: true,
    mode: 0o700
    }
  );
  const patch = buildOpenClawProfilePatch({
    projectRoot: PROJECT_ROOT,
    guildId,
    channelId
  });
  const replacementArgs = buildOpenClawProfileReplacementPaths().flatMap(
    (path) => ["--replace-path", path]
  );
  await runOpenClaw(nodeBinary, [
    "config",
    "patch",
    "--stdin",
    ...replacementArgs
  ], {
    input: `${JSON.stringify(patch)}\n`
  });
  await runOpenClaw(nodeBinary, ["config", "validate"]);
}

async function seedProfileSecrets(): Promise<void> {
  const discordToken = process.env[OPENCLAW_DISCORD_TOKEN_ENV]?.trim();
  if (!discordToken) {
    throw new Error(
      `Export ${OPENCLAW_DISCORD_TOKEN_ENV} in the current terminal before seeding the isolated profile.`
    );
  }
  await mkdir(PROFILE_STATE_ROOT, { recursive: true, mode: 0o700 });
  await chmod(PROFILE_STATE_ROOT, 0o700);
  try {
    await lstat(PROFILE_ENV_PATH);
    throw new Error("The isolated profile secret file already exists; it was not changed.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const handle = await open(PROFILE_ENV_PATH, "wx", 0o600);
  try {
    await handle.writeFile(
      [
        `${OPENCLAW_DISCORD_TOKEN_ENV}=${discordToken}`,
        `${OPENCLAW_GATEWAY_TOKEN_ENV}=${randomBytes(32).toString("hex")}`,
        ""
      ].join("\n"),
      "utf8"
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(PROFILE_ENV_PATH, 0o600);
}

async function requireProfileSecrets(): Promise<void> {
  let contents: string;
  try {
    const metadata = await lstat(PROFILE_ENV_PATH);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("unsupported");
    }
    contents = await readFile(PROFILE_ENV_PATH, "utf8");
  } catch {
    throw new Error("The isolated profile secret file is missing or unsupported.");
  }
  for (const name of [OPENCLAW_DISCORD_TOKEN_ENV, OPENCLAW_GATEWAY_TOKEN_ENV]) {
    if (!new RegExp(`^${name}=\\S+$`, "m").test(contents)) {
      throw new Error("The isolated profile secret file is incomplete.");
    }
  }
}

async function resolveNodeBinary(): Promise<string> {
  const configured = process.env.OPENCLAW_NODE_BIN?.trim();
  const candidate = configured || process.execPath;
  if (!isAbsolute(candidate)) {
    throw new Error("OPENCLAW_NODE_BIN must be an absolute path.");
  }
  const result = await spawnCaptured(candidate, ["-p", "process.versions.node"]);
  if (!isSupportedOpenClawNodeVersion(result.trim())) {
    throw new Error(
      "OpenClaw requires a supported Node runtime; set OPENCLAW_NODE_BIN to Node 22.22+, 24.15+, or 25.9+."
    );
  }
  return candidate;
}

async function verifyRuntime(nodeBinary: string): Promise<void> {
  const packageRecord = JSON.parse(
    await readFile(join(PROJECT_ROOT, "node_modules", "openclaw", "package.json"), "utf8")
  ) as { version?: string };
  requirePinnedOpenClawVersion(packageRecord.version ?? "");
  await spawnCaptured(nodeBinary, [OPENCLAW_ENTRY_PATH, "--version"]);
  if (OPENCLAW_VERSION !== packageRecord.version) {
    throw new Error("The pinned OpenClaw runtime is unavailable.");
  }
}

async function runOpenClaw(
  nodeBinary: string,
  args: string[],
  options: { input?: string; inherit?: boolean } = {}
): Promise<void> {
  const commandArgs = [
    OPENCLAW_ENTRY_PATH,
    "--profile",
    OPENCLAW_PROFILE_NAME,
    ...args
  ];
  if (options.inherit) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(nodeBinary, commandArgs, {
        cwd: PROJECT_ROOT,
        stdio: "inherit"
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error("The interactive OpenClaw command did not complete."));
        }
      });
    });
    return;
  }
  await spawnCaptured(nodeBinary, commandArgs, options.input);
}

async function spawnCaptured(
  executable: string,
  args: string[],
  input?: string,
  acceptedExitCodes: readonly number[] = [0]
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && acceptedExitCodes.includes(code)) {
        resolvePromise(Buffer.concat(output).toString("utf8"));
      } else {
        reject(new Error("The isolated OpenClaw command did not complete."));
      }
    });
    child.stdin.end(input);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "OpenClaw profile command failed."}\n`);
  process.exitCode = 1;
});
