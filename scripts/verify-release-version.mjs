import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`verify-release-version: ${message}`);
  process.exit(1);
}

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) fail("usage: node scripts/verify-release-version.mjs <vX.Y.Z>");

const version = tag.slice(1);
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const manifestVersion = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8")).version;
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8"));
const marketplaceRef = marketplace.plugins?.find(({ name }) => name === "jev-auto-router")?.source?.ref;

if (packageVersion !== version || manifestVersion !== version || lockfile.version !== version || lockfile.packages?.[""]?.version !== version || marketplaceRef !== tag) {
  fail(`expected ${tag} to match package, manifest, lockfile, and marketplace metadata.`);
}

console.log(`verify-release-version: ${tag} metadata is aligned.`);
