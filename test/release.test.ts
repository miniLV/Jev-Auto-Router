import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync("scripts/release.mjs", "utf8");
const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

test("release keeps version metadata aligned and runs the complete verification gate", () => {
  assert.match(release, /const packageLockPath = "package-lock\.json"/);
  assert.match(release, /const marketplacePath = "\.agents\/plugins\/marketplace\.json"/);
  assert.match(release, /readLockVersion\(packageLockPath\) !== currentVersion/);
  assert.match(release, /writeLockVersion\(packageLockPath, nextVersion\)/);
  assert.match(release, /readMarketplaceRef\(marketplacePath\) !== currentTag/);
  assert.match(release, /writeMarketplaceRef\(marketplacePath, tag\)/);
  assert.match(release, /next version must be greater than/);
  assert.match(release, /run\("npm", \["test"\]\)/);
  assert.match(release, /run\("npm", \["run", "typecheck"\]\)/);
  assert.match(release, /run\("git", \["diff", "--check"\]\)/);
  assert.match(release, /git", \["add", packagePath, pluginManifestPath, packageLockPath, marketplacePath\]/);
});

test("tag workflow verifies aligned metadata before creating a GitHub release", () => {
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /verify-release-version\.mjs "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" --generate-notes/);
  assert.match(execFileSync("node", ["scripts/verify-release-version.mjs", `v${version}`], { encoding: "utf8" }), /metadata is aligned/);
});
