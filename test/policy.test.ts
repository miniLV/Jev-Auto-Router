import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const skillRoot = join(repoRoot, "skills", "codex-auto-router");
const referencesRoot = join(skillRoot, "references");
const policyPath = join(referencesRoot, "routing-policy.md");

test("Router Policy is the only Skill runtime file with exact model routing", () => {
  const skillFiles = [
    join(skillRoot, "SKILL.md"),
    ...readdirSync(referencesRoot)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(referencesRoot, name))
  ];

  assert.ok(existsSync(policyPath));
  const policy = readFileSync(policyPath, "utf8");
  assert.equal(policy.match(/gpt-5\.6-terra/g)?.length, 1);

  for (const path of skillFiles) {
    if (path === policyPath) continue;
    assert.doesNotMatch(readFileSync(path, "utf8"), /\bgpt-\d/i, path);
  }
});

test("Skill is explicit-only and reads the canonical policy", () => {
  const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const metadata = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");

  assert.match(skill, /references\/routing-policy\.md/);
  assert.match(metadata, /allow_implicit_invocation: false/);
  assert.doesNotMatch(skill, /Codex Orchestration|LOW\/MEDIUM\/HIGH|Planner\/Advisor\/Executor/);
});

test("superseded ADR files are absent", () => {
  const adrRoot = join(repoRoot, "docs", "adr");
  const adrFiles = existsSync(adrRoot)
    ? readdirSync(adrRoot).filter((name) => name.endsWith(".md"))
    : [];

  assert.deepEqual(adrFiles, []);
});
