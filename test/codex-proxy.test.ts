import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startCodexProxy } from "../src/codex-router/proxy.js";
import { NoopDecisionLog } from "../src/codex-router/log.js";
import type { JevResult, RouterConfig, RouteInput } from "../src/codex-router/types.js";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function upstreamServer(records: Recorded[]) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      records.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          models: [
            { slug: "gpt-6-luna", display_name: "Luna", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "medium" }] },
            { slug: "gpt-6-sol", display_name: "Sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
            { slug: "gpt-6.1-sol", display_name: "Sol 6.1", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
          ],
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.completed\ndata: ${JSON.stringify({ response: { model: "test" } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function config(baseUrl: string): RouterConfig {
  return {
    tiers: {
      fast: "gpt-6-luna",
      balanced: "gpt-6-sol",
      strong: "gpt-6.1-sol",
      long: "gpt-6-astra",
    },
    allowLong: false,
    minConfidence: 0.3,
    uncertainCeiling: "balanced",
    downgradeMaxContextTokens: 20_000,
    contextWindowTokens: 200_000,
    jevModel: "jev-1.13.0",
    jevEndpoint: "http://127.0.0.1:1/v1/systemone",
    jevTimeoutMs: 100,
    jevDeadlineMs: 200,
    jevMaxRetries: 0,
    apiKey: "test",
    defaultModel: "gpt-6-sol",
    autoModelDisplayName: "Jev Router",
    chatgptBaseUrl: baseUrl,
    apiBaseUrl: baseUrl,
    commentary: false,
    logFile: undefined,
    debug: false,
  };
}

function postBody(model: string, text: string, extra: unknown[] = []) {
  return JSON.stringify({
    model,
    prompt_cache_key: "session-1",
    stream: true,
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
      ...extra,
    ],
  });
}

async function post(url: string, body: string) {
  return fetch(`${url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-auth",
      accept: "text/event-stream",
    },
    body,
  });
}

test("proxy injects the virtual model and pins one model across a tool loop", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  const routeCalls: RouteInput[] = [];
  let call = 0;
  const route = async (input: RouteInput): Promise<JevResult> => {
    routeCalls.push(input);
    call += 1;
    return {
      answer: {
        choice: call === 1 ? "gpt-6-luna" : "gpt-6.1-sol",
        confidence: 0.95,
        model: "jev-1.13.0",
        latencyMs: 2,
      },
    };
  };
  const proxy = await startCodexProxy({ config: config(upstream.url), route, log: new NoopDecisionLog() });
  try {
    const models = await fetch(`http://127.0.0.1:${proxy.port}/models`);
    const catalog = (await models.json()) as { models: Array<{ slug: string }> };
    assert.equal(catalog.models.some((model) => model.slug === "jev-router"), true);

    const first = await post(
      `http://127.0.0.1:${proxy.port}`,
      postBody("jev-router", "fix the failing test"),
    );
    assert.equal(first.status, 200);
    await first.text();
    const firstUpstream = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(firstUpstream.model, "gpt-6-luna");
    assert.equal(records.at(-1)!.headers.authorization, "Bearer test-auth");

    const continuation = await post(
      `http://127.0.0.1:${proxy.port}`,
      postBody("jev-router", "fix the failing test", [
        { type: "function_call", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "failed" },
      ]),
    );
    assert.equal(continuation.status, 200);
    await continuation.text();
    assert.equal(routeCalls.length, 1);
    const continuationUpstream = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(continuationUpstream.model, "gpt-6-luna");

    const nextTurn = await post(
      `http://127.0.0.1:${proxy.port}`,
      postBody("jev-router", "now design the fix"),
    );
    assert.equal(nextTurn.status, 200);
    await nextTurn.text();
    assert.equal(routeCalls.length, 2);
    const nextUpstream = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(nextUpstream.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("an identical retry reuses the turn decision", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url),
    route: async () => {
      calls += 1;
      return { failure: { reason: "transport", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    const body = postBody("jev-router", "fix the failing test");
    const first = await post(`http://127.0.0.1:${proxy.port}`, body);
    await first.text();
    const second = await post(`http://127.0.0.1:${proxy.port}`, body);
    await second.text();
    assert.equal(calls, 1);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("a concrete model bypasses routing unchanged", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url),
    route: async () => {
      calls += 1;
      return { answer: { choice: "gpt-6-luna", confidence: 0.9, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    const response = await post(
      `http://127.0.0.1:${proxy.port}`,
      postBody("gpt-6.1-sol", "fix the failing test"),
    );
    await response.text();
    assert.equal(calls, 0);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
