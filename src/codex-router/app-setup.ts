import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./types.js";
import { createConnection } from "node:net";

const DEFAULT_PORT = 18767;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function topLevelLines(text: string): { head: string[]; tail: string[] } {
  const lines = text.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable < 0) return { head: lines, tail: [] };
  return { head: lines.slice(0, firstTable), tail: lines.slice(firstTable) };
}

/** Edit only top-level keys and the jev provider table; preserve the rest. */
export function updateCodexConfig(text: string, port: number, catalogPath: string): string {
  const { head, tail } = topLevelLines(text);
  const values: Record<string, string> = {
    model: AUTO_MODEL,
    model_provider: "jev",
    model_catalog_json: catalogPath,
  };
  for (const [key, value] of Object.entries(values)) {
    const index = head.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const next = `${key} = ${tomlString(value)}`;
    if (index >= 0) head[index] = next;
    else head.push(next);
  }
  const headText = head.join("\n").replace(/\s+$/, "");
  const tailText = tail.join("\n").replace(/^\s+/, "");
  const provider = [
    "[model_providers.jev]",
    'name = "Jev Auto Router"',
    `base_url = ${tomlString(`http://127.0.0.1:${port}`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
  ].join("\n");
  let combined = tailText ? `${headText}\n\n${tailText}` : headText;
  const section = /^\[model_providers\.jev\][\s\S]*?(?=^\[|\Z)/m;
  if (section.test(combined)) combined = combined.replace(section, `${provider}\n`);
  else combined = `${combined.trimEnd()}\n\n${provider}\n`;
  return combined.replace(/\n{3,}/g, "\n\n");
}

/** Add the virtual model by cloning a conservative catalog entry. */
export function addAutoModel(catalog: unknown): unknown {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) {
    throw new Error("codex debug models returned an unexpected catalog");
  }
  if (catalog.models.some((entry) => isRecord(entry) && entry.slug === AUTO_MODEL)) return catalog;
  const models = catalog.models as unknown[];
  const template = models.find((entry) => isRecord(entry) && entry.slug === "gpt-6.1-sol")
    ?? models.find((entry) => isRecord(entry) && entry.slug === "gpt-6-luna")
    ?? models.find((entry) => isRecord(entry) && entry.visibility === "list")
    ?? models[0];
  if (!isRecord(template)) throw new Error("no model template in catalog");

  const auto: JsonRecord = {
    slug: AUTO_MODEL,
    display_name: "Jev Auto Router",
    description: "Jev picks model + effort once per turn; the model stays pinned through the tool loop.",
    default_reasoning_level: "high",
    supported_reasoning_levels: template.supported_reasoning_levels ?? [],
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a coding agent. Follow the user's instructions and use the provided tools.",
  };
  for (const key of [
    "shell_type",
    "apply_patch_tool_type",
    "truncation_policy",
    "context_window",
    "max_context_window",
    "experimental_supported_tools",
    "input_modalities",
    "supports_parallel_tool_calls",
    "supports_search_tool",
    "web_search_tool_type",
    "support_verbosity",
    "default_verbosity",
    "default_reasoning_summary",
    "use_responses_lite",
    "tool_mode",
    "multi_agent_version",
  ]) {
    if (key in template) auto[key] = template[key];
  }
  catalog.models = [auto, ...models];
  return catalog;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function readBundle(): string {
  const command = process.platform === "win32" ? "codex.cmd" : "codex";
  return execFileSync(command, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 400);
  });
}

function startProxy(port: number): void {
  mkdirSync(join(homedir(), ".codex-router"), { recursive: true, mode: 0o700 });
  const server = join(__dirname, "server.js");
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JEV_CODEX_PORT: String(port) },
  });
  child.unref();
  writeFileSync(join(homedir(), ".codex-router", "app-proxy.pid"), `${child.pid ?? ""}\n`, { mode: 0o600 });
}

function help(): void {
  process.stdout.write(
    "Usage: jev-codex setup-app [options]\n\n" +
      "Configure Codex app/ChatGPT app to use the local Jev Auto Router provider.\n\n" +
      "Options:\n" +
      "  --port <number>   Local proxy port (default: 18767)\n" +
      "  --no-start        Write config/catalog but do not start the proxy\n" +
      "  -h, --help        Show this help\n",
  );
}

export async function runAppSetup(args: readonly string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    help();
    return;
  }
  const portIndex = args.indexOf("--port");
  const requested = portIndex >= 0 ? Number(args[portIndex + 1]) : DEFAULT_PORT;
  const port = Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : DEFAULT_PORT;
  const noStart = args.includes("--no-start");

  const home = codexHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = join(home, "config.toml");
  const catalogPath = join(home, "model-catalog.jev-auto.json");
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const catalog = addAutoModel(JSON.parse(readBundle()));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (original) {
    const backup = join(home, `config.toml.bak-jev-auto-${stamp}`);
    writeFileSync(backup, original, { mode: 0o600 });
    process.stdout.write(`config backup: ${backup}\n`);
  }
  if (existsSync(catalogPath)) {
    writeFileSync(join(home, `model-catalog.jev-auto.json.bak-${stamp}`), readFileSync(catalogPath), { mode: 0o600 });
  }
  writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  writeFileSync(configPath, updateCodexConfig(original, port, catalogPath), { mode: 0o600 });

  process.stdout.write(`config: ${configPath}\n`);
  process.stdout.write(`catalog: ${catalogPath}\n`);
  process.stdout.write(`provider: http://127.0.0.1:${port}\n`);

  if (!noStart) {
    if (await portOpen(port)) {
      process.stdout.write(`proxy already listening on ${port}\n`);
    } else {
      startProxy(port);
      process.stdout.write(`proxy started on ${port}\n`);
    }
  }
  process.stdout.write(
    "\nNext: fully quit ChatGPT/Codex app (Cmd+Q), reopen it, create a NEW task, and select Jev Auto Router.\n",
  );
}
