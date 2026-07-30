import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "../src/server.js";
import type { SnapshotProvider, UsageViewModel } from "../src/types.js";

let calls = 0;
const available: UsageViewModel = {
  officialCredit: { status: "available", limit: "500.00", used: "12.34", remaining: "487.66", remainingPercent: 97, resetsAt: "2026-08-01T00:00:00.000Z" },
  estimatedCreditAttribution: [
    { model: "gpt-5.6-terra", credits: "1.23", share: 0.1 },
    { model: "gpt-5.6-sol", credits: "11.11", share: 0.9 }
  ],
  attributionQuality: { status: "estimated", message: "Estimated from local model-token shares; official credit remains authoritative." }
};
const provider: SnapshotProvider = { refresh: async () => { calls += 1; return available; } };
const server = createDashboardServer(provider);

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function call(method: string, path: string, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: body ? { "content-type": "text/plain" } : undefined }, (res) => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: response }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("GET / renders one fresh snapshot with the three primary blocks", async () => {
  calls = 0;
  const response = await call("GET", "/");
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.match(response.body, /Official Credit/);
  assert.match(response.body, /Model credit mix/);
  assert.match(response.body, /Attribution quality/);
  assert.match(response.body, /model-donut/);
  assert.match(response.body, /id="donut-model">gpt-5\.6-sol/);
  assert.match(response.body, /90\.0%/);
  assert.match(response.body, /data-model=/);
  assert.match(response.body, /pointerenter/);
  assert.match(response.body, /Credit used/);
  assert.match(response.body, /Time to reset/);
  assert.match(response.body, /transform:scaleX\(0\.03\)/);
  assert.match(response.body, /id="export-json"/);
  assert.match(response.body, /fetch\("\/api\/usage"/);
  assert.match(response.body, /codex-usage-/);
  assert.match(response.body, /<button id="refresh" class="refresh" type="button">Refresh snapshot<\/button>/);
  assert.match(response.body, /addEventListener\("click",\(\)=>location\.reload\(\)\)/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const nonce = /<script nonce="([^"]+)">/.exec(response.body)?.[1];
  assert.ok(nonce);
  assert.ok(String(response.headers["content-security-policy"]).includes(`nonce-${nonce}`));
  assert.ok(String(response.headers["content-security-policy"]).includes("connect-src 'self'"));
  const nextResponse = await call("GET", "/");
  const nextNonce = /<script nonce="([^"]+)">/.exec(nextResponse.body)?.[1];
  assert.notEqual(nextNonce, nonce);
  assert.ok(String(nextResponse.headers["content-security-policy"]).includes(`nonce-${nextNonce}`));
});

test("GET /api/usage returns one fresh safe view model", async () => {
  calls = 0;
  const response = await call("GET", "/api/usage");
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(response.body), available);
  assert.doesNotMatch(response.body, /source error|prompt|sessionFile/i);
});

test("POST /api/refresh takes one fresh snapshot only when the body is empty", async () => {
  calls = 0;
  const response = await call("POST", "/api/refresh");
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(response.body), available);
  const rejected = await call("POST", "/api/refresh", "meaningful-body");
  assert.equal(rejected.status, 400);
  assert.equal(calls, 1);
});

test("known read failures are represented as a 200 availability state", async () => {
  const unavailableServer = createDashboardServer({ refresh: async () => ({
    officialCredit: { status: "unavailable" },
    estimatedCreditAttribution: [],
    attributionQuality: { status: "unavailable", message: "Official credit is unavailable, so estimates are unavailable." }
  }) });
  await new Promise<void>((resolve) => unavailableServer.listen(0, "127.0.0.1", resolve));
  const port = (unavailableServer.address() as AddressInfo).port;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/usage" }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
  await new Promise<void>((resolve, reject) => unavailableServer.close((error) => error ? reject(error) : resolve()));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).officialCredit.status, "unavailable");
});
