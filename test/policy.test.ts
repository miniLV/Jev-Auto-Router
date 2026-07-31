import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const skillRoot = join(repoRoot, "skills", "codex-auto-router");
const policyPath = join(skillRoot, "references", "routing-policy.md");

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? filesUnder(child) : [child];
  });
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const end = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, end === -1 ? undefined : end);
}

test("Runtime Router Policy is the only Skill routing authority", () => {
  const files = filesUnder(skillRoot);
  const declarations = files.filter((path) =>
    readFileSync(path, "utf8").includes("# Runtime Router Policy")
  );
  const modelMentions = files.flatMap((path) =>
    readFileSync(path, "utf8").match(/\bgpt-\d+(?:\.\d+)?-[a-z0-9-]+\b/gi) ?? []
  );

  assert.deepEqual(declarations.map((path) => relative(skillRoot, path)), ["references/routing-policy.md"]);
  assert.deepEqual(modelMentions, ["gpt-5.6-terra"]);
});

test("Policy fixes V1 routes, native parameters, limits, and receipt boundary", () => {
  const policy = readFileSync(policyPath, "utf8");
  const nativeParameters = section(policy, "## Native child parameters");
  const limits = section(policy, "## Root policy limits");
  const receipt = section(policy, "## Route receipt");

  assert.match(policy, /`ROOT_DIRECT`/);
  assert.match(policy, /`TERRA_HIGH_BACKGROUND`/);
  assert.match(nativeParameters, /model: gpt-5\.6-terra/);
  assert.match(nativeParameters, /reasoning_effort: high/);
  assert.match(nativeParameters, /fork_turns: none/);
  assert.doesNotMatch(nativeParameters, /maximum_(workers|followups)/);
  assert.match(limits, /Maximum active children: `1`/);
  assert.match(limits, /Maximum follow-ups to that child: `1`/);
  assert.match(receipt, /Main Task commentary/);
  assert.match(receipt, /never writes it to a file/i);
  assert.match(receipt, /Dashboard/);
  assert.match(receipt, /later Route Decision/);
});

test("Skill is explicit-only and all local entrypoint links resolve", () => {
  const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const metadata = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
  const localLinks = [...skill.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((href) => !/^[a-z]+:/i.test(href));

  assert.match(skill, /user explicitly invokes `\$codex-auto-router`/);
  assert.match(skill, /Do not infer invocation from task characteristics/);
  assert.match(metadata, /allow_implicit_invocation: false/);

  for (const href of localLinks) {
    assert.ok(existsSync(resolve(dirname(join(skillRoot, "SKILL.md")), href)), href);
  }
});

test("lifecycle keeps one Worker ownership boundary and resolves partial writes", () => {
  const packet = readFileSync(join(skillRoot, "references", "task-packet.md"), "utf8");
  const lifecycle = readFileSync(join(skillRoot, "references", "native-subagent-lifecycle.md"), "utf8");

  assert.match(packet, /exact Worker-owned paths/i);
  assert.match(packet, /captured preflight baseline/i);
  assert.match(lifecycle, /Root must not edit a Worker-owned path/i);
  assert.match(lifecycle, /explicitly adopt/i);
  assert.match(lifecycle, /restore it to the captured preflight baseline/i);
  assert.match(lifecycle, /one focused\nfollow-up/i);
});

test("known superseded routing artifacts and references remain absent", () => {
  const stalePaths = [
    ["docs", "claude-code-review-packet.md"].join("/"),
    ["docs", "adr", "0001-root-role-capability-and-routing-levels.md"].join("/"),
    ["docs", "adr", "0002-personal-dashboard-credit-boundary.md"].join("/"),
    ["docs", "adr", "0003-short-lived-app-server-adapter.md"].join("/"),
    ["docs", "adr", "0004-loopback-only-dashboard.md"].join("/")
  ];
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean);

  for (const stalePath of stalePaths) {
    assert.ok(!existsSync(join(repoRoot, stalePath)), stalePath);
  }

  for (const path of trackedFiles) {
    if (path === "test/policy.test.ts") continue;
    const absolutePath = join(repoRoot, path);
    if (!existsSync(absolutePath)) continue;
    const contents = readFileSync(absolutePath, "utf8");
    for (const stalePath of stalePaths) {
      assert.ok(!contents.includes(stalePath), `${path} references ${stalePath}`);
    }
  }
});
