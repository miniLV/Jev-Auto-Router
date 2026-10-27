import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startCodexProxy } from "../src/codex-router/proxy.js";
import { NoopDecisionLog } from "../src/codex-router/log.js";
import { MemorySessionStore } from "../src/codex-router/session-store.js";
import { conversationKey } from "../src/codex-router/turn.js";
import type { JevResult, RouterConfig, RouteInput } from "../src/codex-router/types.js";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function upstreamServer(records: Recorded[], usage?: Record<string, unknown>) {
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
            { slug: "gpt-6-luna", display_name: "Luna", visibility: "list", supported_in_api: true, supports_reasoning_effort_updates: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
            { slug: "gpt-6-sol", display_name: "Sol", visibility: "list", supported_in_api: true, supports_reasoning_effort_updates: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
            { slug: "gpt-6.1-sol", display_name: "Sol 6.1", visibility: "list", supported_in_api: true, supports_reasoning_effort_updates: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
          ],
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: "test", usage } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function config(baseUrl: string, overrides: Partial<RouterConfig> = {}): RouterConfig {
  const base: RouterConfig = {
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
    lockAfterTurns: 0,
    maxSwitchesPerSession: 0,
    switchCooldownTurns: 0,
    cacheTtlMs: 30 * 60 * 1000,
    contextWindowTokens: 200_000,
    prices: undefined,
    assumedRemainingTurns: 3,
    taskTurnBudget: 0,
    lockBeforeEndTurns: 2,
    outputTokensPerTurn: 1_000,
    effortRouting: "off",
    effortCap: "high",
    effortFallback: "high",
    upgradeMode: "always",
    upgradeComplexityThreshold: 0.8,
    upgradeFailureTtlMs: 10 * 60 * 1000,
    stripEncryptedReasoning: false,
    sessionTtlMs: 24 * 60 * 60 * 1000,
    sessionFile: undefined,
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
  return { ...base, ...overrides };
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


test("switch cooldown keeps the pinned model for one turn after a change", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  const choices = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-sol"];
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { switchCooldownTurns: 1 }),
    route: async () => {
      const choice = choices[calls] ?? "gpt-6.1-sol";
      calls += 1;
      return { answer: { choice, confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    for (const prompt of ["first", "cooldown", "after cooldown"]) {
      const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", prompt));
      await response.text();
    }
    assert.equal(calls, 2);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("session lock stops automatic switching after the configured turn count", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { lockAfterTurns: 2, switchCooldownTurns: 0 }),
    route: async () => {
      calls += 1;
      return {
        answer: {
          choice: calls === 1 ? "gpt-6-luna" : "gpt-6.1-sol",
          confidence: 0.95,
          model: "jev",
          latencyMs: 1,
        },
      };
    },
    log: new NoopDecisionLog(),
  });
  try {
    for (const prompt of ["one", "two", "three"]) {
      const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", prompt));
      await response.text();
    }
    assert.equal(calls, 2);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("switch budget stops further automatic changes", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { maxSwitchesPerSession: 1, switchCooldownTurns: 0 }),
    route: async () => {
      calls += 1;
      return { answer: { choice: "gpt-6.1-sol", confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    for (const prompt of ["one", "two"]) {
      const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", prompt));
      await response.text();
    }
    assert.equal(calls, 1);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("an expired cache TTL resets the session switch guards", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let now = 1_000;
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { lockAfterTurns: 1, cacheTtlMs: 1_000, switchCooldownTurns: 0 }),
    now: () => now,
    route: async () => {
      calls += 1;
      return {
        answer: {
          choice: calls === 1 ? "gpt-6-luna" : "gpt-6.1-sol",
          confidence: 0.95,
          model: "jev",
          latencyMs: 1,
        },
      };
    },
    log: new NoopDecisionLog(),
  });
  try {
    const first = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "one"));
    await first.text();
    now += 2_000;
    const second = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "two"));
    await second.text();
    assert.equal(calls, 2);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("an explicit user override still works after the session lock", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { lockAfterTurns: 1, switchCooldownTurns: 0 }),
    route: async () => {
      calls += 1;
      return { answer: { choice: "gpt-6.1-sol", confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    const first = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "one"));
    await first.text();
    const second = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "use luna for this one"));
    await second.text();
    assert.equal(calls, 2);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-luna");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});


test("price break-even blocks a downgrade when the remaining turns are too few", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  const proxy = await startCodexProxy({
    config: config(upstream.url, {
      prices: {
        "gpt-6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6.1-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4 },
      },
      assumedRemainingTurns: 1,
      switchCooldownTurns: 0,
    }),
    route: async () => ({ answer: { choice: "gpt-6-luna", confidence: 0.95, model: "jev", latencyMs: 1 } }),
    log: new NoopDecisionLog(),
  });
  try {
    const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "x".repeat(100_000)));
    await response.text();
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("cold observed cache lets a large-context downgrade pass", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records, {
    input_tokens: 100_000,
    input_tokens_details: { cached_tokens: 0 },
    cache_write_input_tokens: 100_000,
    output_tokens: 500,
  });
  const store = new MemorySessionStore();
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, {
      prices: {
        "gpt-6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6.1-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4 },
      },
      assumedRemainingTurns: 1,
      switchCooldownTurns: 0,
    }),
    route: async () => {
      calls += 1;
      return { answer: { choice: calls === 1 ? "gpt-6.1-sol" : "gpt-6-luna", confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
    store,
  });
  try {
    const first = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "keep the strong model"));
    await first.text();
    const second = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "x".repeat(100_000)));
    await second.text();
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-luna");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("triggered upgrades require a failure or a high-complexity signal", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { upgradeMode: "triggered", switchCooldownTurns: 0 }),
    route: async () => {
      calls += 1;
      return {
        answer: {
          choice: calls === 1 ? "gpt-6-luna" : "gpt-6.1-sol",
          confidence: 0.95,
          model: "jev",
          latencyMs: 1,
          scores: {
            taskComplexity: calls > 2 ? 0.9 : 0.2,
            reasoningRequired: calls > 2 ? 0.9 : 0.2,
            toolComplexity: 0.2,
            contextSize: 0,
          },
        },
      };
    },
    log: new NoopDecisionLog(),
  });
  try {
    for (const prompt of ["first", "low", "high"]) {
      const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", prompt));
      await response.text();
    }
    assert.equal(calls, 3);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6.1-sol");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("loads a persisted session pin before routing", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  const store = new MemorySessionStore();
  const key = conversationKey({
    prompt_cache_key: "session-1",
    input: [{ role: "user", content: "warmup" }],
  });
  store.states[key] = {
    tier: "fast",
    model: "gpt-6-luna",
    updatedAt: Date.now(),
    turns: 2,
    switches: 1,
    turnsSinceSwitch: 1,
  };
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { lockAfterTurns: 1 }),
    route: async () => {
      calls += 1;
      return { answer: { choice: "gpt-6.1-sol", confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
    store,
  });
  try {
    const response = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "continue"));
    await response.text();
    assert.equal(calls, 0);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-luna");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("a compaction resets cache warmth before the next decision", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, {
      prices: {
        "gpt-6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6.1-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
        "gpt-6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4 },
      },
      assumedRemainingTurns: 1,
      switchCooldownTurns: 0,
    }),
    route: async () => {
      calls += 1;
      return { answer: { choice: calls === 1 ? "gpt-6.1-sol" : "gpt-6-luna", confidence: 0.95, model: "jev", latencyMs: 1 } };
    },
    log: new NoopDecisionLog(),
  });
  try {
    const first = await post(`http://127.0.0.1:${proxy.port}`, postBody("jev-router", "first"));
    await first.text();
    const compacted = JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "session-1",
      stream: true,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [
        { type: "compaction" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(100_000) }] },
      ],
    });
    const second = await post(`http://127.0.0.1:${proxy.port}`, compacted);
    await second.text();
    assert.equal(calls, 2);
    const forwarded = JSON.parse(records.at(-1)!.body) as { model: string };
    assert.equal(forwarded.model, "gpt-6-luna");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("effort updates keep the top-level effort and reinsert earlier updates", async () => {
  const records: Recorded[] = [];
  const upstream = await upstreamServer(records);
  let calls = 0;
  const proxy = await startCodexProxy({
    config: config(upstream.url, { effortRouting: "turn", effortCap: "high", switchCooldownTurns: 0 }),
    route: async () => {
      calls += 1;
      return {
        answer: {
          choice: "gpt-6-luna",
          confidence: 0.95,
          model: "jev",
          latencyMs: 1,
          scores: {
            taskComplexity: calls === 1 ? 0.8 : 0.1,
            reasoningRequired: calls === 1 ? 0.8 : 0.1,
            toolComplexity: 0.1,
            contextSize: 0,
          },
        },
      };
    },
    log: new NoopDecisionLog(),
  });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then((response) => response.text());
    const tools = [{ type: "function", name: "exec_command", parameters: { type: "object" } }];
    const first = JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "effort-session",
      stream: true,
      reasoning: { effort: "medium" },
      tools,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }],
    });
    await (await post(`http://127.0.0.1:${proxy.port}`, first)).text();
    const firstBody = JSON.parse(records.at(-1)!.body) as { reasoning: { effort: string }; input: Array<Record<string, unknown>> };
    assert.equal(firstBody.reasoning.effort, "medium");
    assert.equal(firstBody.input[0].type, "configuration_update");
    assert.equal((firstBody.input[0].reasoning as { effort: string }).effort, "high");

    const continuation = JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "effort-session",
      stream: true,
      reasoning: { effort: "medium" },
      tools,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
        { type: "function_call", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
    await (await post(`http://127.0.0.1:${proxy.port}`, continuation)).text();
    assert.equal(calls, 1);
    const continuationBody = JSON.parse(records.at(-1)!.body) as { input: Array<Record<string, unknown>> };
    assert.equal(continuationBody.input[0].type, "configuration_update");

    const second = JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "effort-session",
      stream: true,
      reasoning: { effort: "medium" },
      tools,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
      ],
    });
    await (await post(`http://127.0.0.1:${proxy.port}`, second)).text();
    assert.equal(calls, 2);
    const secondBody = JSON.parse(records.at(-1)!.body) as { reasoning: { effort: string }; input: Array<Record<string, unknown>> };
    assert.equal(secondBody.reasoning.effort, "medium");
    assert.deepEqual(secondBody.input.map((item) => item.type === "configuration_update" ? "update" : item.role), [
      "update",
      "user",
      "assistant",
      "update",
      "user",
    ]);
    assert.equal((secondBody.input[0].reasoning as { effort: string }).effort, "high");
    assert.equal((secondBody.input[3].reasoning as { effort: string }).effort, "low");
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
