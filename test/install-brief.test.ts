import assert from "node:assert/strict";
import test from "node:test";
import { AddressInfo } from "node:net";
import { configFromEnv, createProductionProxy, createRouterServer, fetchJevTransport } from "../src/index.js";
import { MemoryTelemetry } from "../src/proxy.js";
import {
  DEFAULT_ROUTER_COMMIT,
  DEFAULT_TRIAL_ROOT,
  parseInstallBriefInput,
  renderInstallBrief,
  renderInstallPage,
} from "../src/install-brief.js";
import { testCatalog } from "./routing-fixtures.js";

const valid = { baseline: "gpt-6-sol/medium", repoPath: "/Users/x/jev-auto-router" };

test("brief inputs fall back to pinned defaults", () => {
  const input = parseInstallBriefInput(valid);
  assert.equal(input.routerCommit, DEFAULT_ROUTER_COMMIT);
  assert.equal(input.proxyPort, 8787);
  assert.equal(input.pickerLabel, "Jev Auto Router");
  assert.equal(input.trialRoot, DEFAULT_TRIAL_ROOT);
  assert.equal(input.upstreamBaseUrl, undefined);
});

test("baseline and repoPath are required and validated", () => {
  assert.throws(() => parseInstallBriefInput({ repoPath: "/r" }), /baseline is required/);
  for (const baseline of ["", "gpt-6-sol", "a/b/c", "a /b"]) {
    assert.throws(() => parseInstallBriefInput({ ...valid, baseline }), /<model>\/<effort>/);
  }
  assert.throws(() => parseInstallBriefInput({ baseline: valid.baseline }), /repoPath is required/);
  assert.equal(parseInstallBriefInput({ baseline: valid.baseline }, "/fallback/repo").repoPath, "/fallback/repo");
});

test("port and router commit are validated", () => {
  for (const port of ["0", "70000", "abc", "1.5"]) {
    assert.throws(() => parseInstallBriefInput({ ...valid, port }), /port must be an integer/);
  }
  assert.throws(() => parseInstallBriefInput({ ...valid, routerCommit: "main" }), /commit hash/);
});

test("the caller edge must be a valid non-recursive http(s) URL", () => {
  assert.equal(
    parseInstallBriefInput({ ...valid, upstreamBaseUrl: "http://127.0.0.1:4200/" }).upstreamBaseUrl,
    "http://127.0.0.1:4200",
  );
  assert.throws(() => parseInstallBriefInput({ ...valid, upstreamBaseUrl: "ftp://x" }), /http\(s\)/);
  assert.throws(
    () => parseInstallBriefInput({ ...valid, upstreamBaseUrl: "http://127.0.0.1:8787" }),
    /non-recursive/,
  );
  assert.throws(
    () => parseInstallBriefInput({ ...valid, port: "4200", upstreamBaseUrl: "http://localhost:4200" }),
    /non-recursive/,
  );
});

test("the brief substitutes the trial parameters into every command block", () => {
  const brief = renderInstallBrief(parseInstallBriefInput({
    ...valid,
    port: "8788",
    upstreamBaseUrl: "http://127.0.0.1:4200",
    trialRoot: "$HOME/Documents/trial-x",
    pickerLabel: "Jev Auto",
  }));
  assert.match(brief, /gpt-6-sol\/medium/);
  assert.match(brief, /http:\/\/127\.0\.0\.1:8788/);
  assert.match(brief, /\$HOME\/Documents\/trial-x/);
  assert.match(brief, /JEV_UPSTREAM_BASE_URL="http:\/\/127\.0\.0\.1:4200"/);
  assert.match(brief, /「Jev Auto」/);
});

test("without a prefilled caller edge the brief instructs on-site discovery and non-recursion checks", () => {
  const brief = renderInstallBrief(parseInstallBriefInput(valid));
  assert.match(brief, /codex-router" status/);
  assert.match(brief, /<caller-edge-base-url>/);
  assert.match(brief, /递归禁止/);
});

test("the brief keeps the borrowed integration layer but excludes its runtime policy", () => {
  const brief = renderInstallBrief(parseInstallBriefInput(valid));
  assert.match(brief, new RegExp(`checkout ${DEFAULT_ROUTER_COMMIT}`));
  assert.match(brief, /picker set jev\/auto show/);
  assert.match(brief, /chatgpt-session enable/);
  assert.match(brief, /不执行.*install-service\.sh/s);
  assert.match(brief, /route lease、Astra 强制策略、配额回退、retry\/重放一律排除/);
  assert.match(brief, /shadow 模式/);
});

test("the brief keeps secrets out of commands, git and logs, and stays rollbackable", () => {
  const brief = renderInstallBrief(parseInstallBriefInput(valid));
  assert.match(brief, /chmod 600/);
  assert.match(brief, /JEV_API_KEY=<用户的 TypeSafe Jev API Key>/);
  assert.doesNotMatch(brief, /JEV_API_KEY=[A-Za-z0-9_-]{8,}/);
  assert.match(brief, /config\.sha256/);
  assert.match(brief, /## 第 7 步：回滚/);
  assert.match(brief, /picker set jev\/auto hide/);
});

test("the config page prefills the local repo path and never asks for a key", () => {
  const page = renderInstallPage('/Users/x/repo"<script>');
  assert.match(page, /\/Users\/x\/repo&quot;&lt;script&gt;/);
  assert.match(page, /name="baseline" required/);
  assert.doesNotMatch(page, /api[-_ ]?key/i);
});

test("the server serves the install page and brief endpoint", async () => {
  const config = configFromEnv({
    JEV_BASELINE: "gpt-6-luna/max",
    JEV_UPSTREAM_BASE_URL: "http://127.0.0.1:8788",
  });
  const proxy = createProductionProxy(
    config,
    testCatalog(),
    fetchJevTransport("http://127.0.0.1:1", "unused"),
    new MemoryTelemetry(),
  );
  const server = createRouterServer(config, testCatalog(), proxy);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/install`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    const brief = await fetch(`${base}/install/brief?baseline=gpt-6-sol/medium`);
    assert.equal(brief.status, 200);
    assert.match(await brief.text(), /gpt-6-sol\/medium/);

    const invalid = await fetch(`${base}/install/brief`);
    assert.equal(invalid.status, 400);
    assert.match(JSON.stringify(await invalid.json()), /baseline is required/);

    const recursive = await fetch(`${base}/install/brief?baseline=gpt-6-sol/medium&upstreamBaseUrl=http://127.0.0.1:8787`);
    assert.equal(recursive.status, 400);
    assert.match(JSON.stringify(await recursive.json()), /non-recursive/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
