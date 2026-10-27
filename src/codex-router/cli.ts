import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { startCodexProxy } from "./proxy.js";
import { AUTO_MODEL } from "./types.js";

const PROVIDER = "jev";

export function loadEnvFiles(): void {
  for (const file of [
    join(process.cwd(), ".env"),
    join(homedir(), ".jev-router.env"),
    join(homedir(), ".jev-codex.env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing files are fine; real environment values still apply.
    }
  }
}

interface CodexCommand {
  file: string;
  prefix: string[];
  shell: boolean;
}

export function resolveCodex(pathValue = process.env.PATH ?? ""): CodexCommand | undefined {
  const win = process.platform === "win32";
  const extensions = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const directory of pathValue.split(win ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const file = join(directory.replace(/^"|"$/g, ""), `codex${extension}`);
      try {
        accessSync(file, constants.F_OK);
      } catch {
        continue;
      }
      if (/\.ps1$/i.test(file)) return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
      return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
    }
  }
  return undefined;
}

export function hasExplicitModel(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
}

/**
 * Launch Codex with a temporary provider. A user-specified concrete model is
 * preserved; otherwise the virtual sentinel is selected and the proxy owns the
 * real model choice.
 */
export function buildCodexArgs(baseURL: string, args: readonly string[]): string[] {
  const prefix = hasExplicitModel(args) ? [] : ["--model", AUTO_MODEL];
  return [
    ...prefix,
    "--config", `model_provider="${PROVIDER}"`,
    "--config", `model_providers.${PROVIDER}.name="Jev Router"`,
    "--config", `model_providers.${PROVIDER}.base_url="${baseURL}"`,
    "--config", `model_providers.${PROVIDER}.wire_api="responses"`,
    "--config", `model_providers.${PROVIDER}.requires_openai_auth=true`,
    "--config", `model_providers.${PROVIDER}.supports_websockets=false`,
    ...args,
  ];
}

export async function runCodex(): Promise<void> {
  loadEnvFiles();
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(
      "[jev] OpenAI Codex is not installed, or `codex` is not on your PATH.\n" +
        "[jev] jev-codex runs the real Codex CLI; install it first.\n",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  let args = process.argv.slice(2);
  let close = async (): Promise<void> => {};
  if (config.apiKey) {
    const proxy = await startCodexProxy({ config });
    close = proxy.close;
    args = buildCodexArgs(`http://127.0.0.1:${proxy.port}`, args);
    if (config.debug) process.stderr.write(`[jev] proxy listening on 127.0.0.1:${proxy.port}\n`);
  } else {
    process.stderr.write(
      "[jev] no JEV_API_KEY or TYPESAFE_API_KEY found; starting Codex without routing.\n" +
        `[jev] add JEV_API_KEY=... to ${join(homedir(), ".jev-router.env")} and restart jev-codex.\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env: process.env },
  );
  child.on("error", (error) => {
    void close();
    process.stderr.write(`[jev] could not start Codex: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    void close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
