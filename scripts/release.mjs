import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) fail(`command failed: ${command} ${args.join(" ")}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`command failed: ${command} ${args.join(" ")}`);
  return result.stdout.trim();
}

function readVersionField(path) {
  const text = readFileSync(path, "utf8");
  const match = text.match(/"version":\s*"(\d+\.\d+\.\d+)"/);
  if (!match) fail(`no "version" field found in ${path}`);
  return match[1];
}

function writeVersionField(path, nextVersion) {
  const text = readFileSync(path, "utf8");
  const match = text.match(/"version":\s*"\d+\.\d+\.\d+"/);
  if (!match) fail(`no "version" field found in ${path}`);
  writeFileSync(path, text.replace(match[0], `"version": "${nextVersion}"`));
}

function readLockVersion(path) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(lock.version ?? "") || lock.packages?.[""]?.version !== lock.version) {
    fail(`${path} has inconsistent root versions.`);
  }
  return lock.version;
}

function writeLockVersion(path, nextVersion) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  lock.version = nextVersion;
  lock.packages[""].version = nextVersion;
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function readMarketplaceRef(path) {
  const marketplace = JSON.parse(readFileSync(path, "utf8"));
  const ref = marketplace.plugins?.find(({ name }) => name === "jev-auto-router")?.source?.ref;
  if (typeof ref !== "string") fail(`no jev-auto-router source ref found in ${path}`);
  return ref;
}

function writeMarketplaceRef(path, tag) {
  const marketplace = JSON.parse(readFileSync(path, "utf8"));
  const plugin = marketplace.plugins?.find(({ name }) => name === "jev-auto-router");
  if (!plugin?.source) fail(`no jev-auto-router source found in ${path}`);
  plugin.source.ref = tag;
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(left.split(".")[index]) - Number(right.split(".")[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const nextVersion = process.argv[2];
if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  fail("usage: node scripts/release.mjs <X.Y.Z>");
}

const tag = `v${nextVersion}`;
if (capture("git", ["status", "--porcelain"]) !== "") {
  fail("the working tree is not clean. Commit or stash pending changes first.");
}
if (capture("git", ["tag", "--list", tag]) !== "") {
  fail(`tag ${tag} already exists.`);
}

const packagePath = "package.json";
const pluginManifestPath = ".codex-plugin/plugin.json";
const packageLockPath = "package-lock.json";
const marketplacePath = ".agents/plugins/marketplace.json";
const currentVersion = readVersionField(packagePath);
const currentTag = `v${currentVersion}`;
if (
  readVersionField(pluginManifestPath) !== currentVersion ||
  readLockVersion(packageLockPath) !== currentVersion ||
  readMarketplaceRef(marketplacePath) !== currentTag
) {
  fail("package, plugin manifest, lockfile, and marketplace ref must match before release.");
}
if (compareVersions(nextVersion, currentVersion) <= 0) {
  fail(`next version must be greater than ${currentVersion}.`);
}
writeVersionField(packagePath, nextVersion);
writeVersionField(pluginManifestPath, nextVersion);
writeLockVersion(packageLockPath, nextVersion);
writeMarketplaceRef(marketplacePath, tag);

console.log(`release: ${currentVersion} -> ${nextVersion}`);
run("npm", ["test"]);
run("npm", ["run", "typecheck"]);
run("git", ["diff", "--check"]);

run("git", ["add", packagePath, pluginManifestPath, packageLockPath, marketplacePath]);
run("git", ["commit", "-m", `release: ${tag}`]);
run("git", ["tag", "-a", tag, "-m", tag]);

console.log(`release: committed and tagged ${tag} locally.`);
console.log(`release: push it yourself when ready: git push && git push origin ${tag}`);
