import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_MAJOR = 22;
const scriptPath = fileURLToPath(import.meta.url);
const npmCommand = "npm";

function fail(message) {
  console.error(`setup: ${message}`);
  process.exit(1);
}

function canRun(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.error || result.status !== 0) fail(`Automatic repair failed. Fix the command above, then rerun npm run setup.`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function codexInstallInstructions() {
  if (process.platform === "win32") {
    return "  Windows / npm: npm install --global @openai/codex\n  Then run: codex";
  }
  return "  macOS / Linux: curl -fsSL https://chatgpt.com/codex/install.sh | sh\n  Or with npm: npm install --global @openai/codex\n  Then run: codex";
}

function nvmScript() {
  const configured = process.env.NVM_DIR ? join(process.env.NVM_DIR, "nvm.sh") : "";
  if (configured && existsSync(configured)) return configured;
  const normalized = process.execPath.replaceAll("\\", "/");
  const match = /^(.*)\/versions\/node\/[^/]+\/bin\/node$/.exec(normalized);
  const inferred = match ? join(match[1], "nvm.sh") : "";
  return inferred && existsSync(inferred) ? inferred : undefined;
}

function repairPlan() {
  if (process.platform === "win32") {
    if (canRun("nvm", ["version"])) return {
      label: "nvm install 22 && nvm use 22 (Windows may request administrator permission)",
      apply: () => { run("nvm", ["install", "22"]); run("nvm", ["use", "22"]); return { node: "node" }; }
    };
    if (canRun("winget")) return {
      label: "winget upgrade --id OpenJS.NodeJS.LTS --exact",
      apply: () => { run("winget", ["upgrade", "--id", "OpenJS.NodeJS.LTS", "--exact", "--accept-source-agreements", "--accept-package-agreements"]); return { node: "node" }; }
    };
    return undefined;
  }

  const script = nvmScript();
  if (script) return {
    label: "nvm install 22 && nvm alias default 22",
    apply: () => {
      run("bash", ["-c", '. "$1" && nvm install 22 && nvm alias default 22', "_", script]);
      const node = capture("bash", ["-c", '. "$1" && nvm which 22', "_", script]).split("\n").at(-1);
      return node ? { node, path: dirname(node) } : undefined;
    }
  };

  if (canRun("brew")) return {
    label: "brew install node@22",
    apply: () => {
      run("brew", ["install", "node@22"]);
      const prefix = capture("brew", ["--prefix", "node@22"]);
      return prefix ? { node: join(prefix, "bin", "node"), path: join(prefix, "bin") } : undefined;
    }
  };
  return undefined;
}

function confirm(question) {
  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.question(`setup: ${question} [yes/no] `, (answer) => {
      input.close();
      resolve(answer.trim() === "yes");
    });
  });
}

async function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= REQUIRED_NODE_MAJOR) return;
  const plan = repairPlan();
  if (!plan) fail(`Node.js >=22 is required (found ${process.version}). No supported Node manager was found for ${process.platform}. Install Node 22+ from https://nodejs.org/download, then rerun npm run setup.`);
  if (!await confirm(`Node.js >=22 is required (found ${process.version}). Run: ${plan.label}?`)) fail("Cancelled. No changes were made.");
  const repaired = plan.apply();
  if (!repaired) fail("Node.js was installed but is not active. Open a new terminal, then rerun npm run setup.");
  const env = repaired.path ? { ...process.env, PATH: `${repaired.path}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` } : process.env;
  const result = spawnSync(repaired.node, [scriptPath], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

await ensureNode();
if (!canRun(npmCommand)) fail("npm is required. Reinstall Node.js 22+, then rerun npm run setup.");
if (!canRun("codex")) fail([
  "Codex CLI is required for the full dashboard.",
  "It provides official Credit through codex app-server and creates the session logs used by ccusage.",
  "Install it yourself using one of the official routes:",
  codexInstallInstructions(),
  "Official guide: https://developers.openai.com/codex/cli/",
  "After installation, run codex once to sign in, then rerun npm run setup."
].join("\n"));

console.log(`setup: Node ${process.version}, npm ${capture(npmCommand, ["--version"])}, Codex ${capture("codex", ["--version"]).split("\n")[0]}`);
run(npmCommand, ["ci"]);
run(npmCommand, ["run", "typecheck"]);
run(npmCommand, ["test"]);
console.log("setup: ready. Run npm start.");
