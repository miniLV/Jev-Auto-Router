import { spawnSync } from "node:child_process";

const REQUIRED_NODE_MAJOR = 22;
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
  if (result.error || result.status !== 0) fail("The setup command failed. Fix the error above, then rerun npm run setup.");
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

function nodeInstallInstructions() {
  if (process.platform === "win32") {
    return "  Windows nvm: nvm install 22 && nvm use 22\n  Or WinGet: winget install --id OpenJS.NodeJS.LTS --exact\n  Or download: https://nodejs.org/download";
  }
  return "  macOS / Linux nvm: nvm install 22 && nvm alias default 22\n  Or Homebrew: brew install node@22\n  Or download: https://nodejs.org/download";
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= REQUIRED_NODE_MAJOR) return;
  fail([
    `Node.js >=22 is required (found ${process.version}).`,
    "Install or upgrade it yourself using one of these commands:",
    nodeInstallInstructions(),
    "Open a new terminal after installation, then rerun npm run setup."
  ].join("\n"));
}

ensureNode();
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
