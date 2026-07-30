import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "../src/server.js";

test("the dashboard rejects a Host that is not its current loopback authority", async () => {
  let calls = 0;
  const server = createDashboardServer({ refresh: async () => {
    calls += 1;
    return {
      officialCredit: { status: "unavailable" as const },
      estimatedCreditAttribution: [],
      attributionQuality: { status: "unavailable" as const, message: "Official credit is unavailable, so estimates are unavailable." }
    };
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: "127.0.0.1:1" } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(status, 403);
  assert.equal(calls, 0);
});
