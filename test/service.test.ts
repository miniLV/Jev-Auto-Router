import assert from "node:assert/strict";
import test from "node:test";
import { sourceOwnWindow, UsageService } from "../src/service.js";
import type { ObservationWindow } from "../src/types.js";

test("UsageService passes the July bootstrap window to ccusage without leaking August 1", async () => {
  let received: ObservationWindow | undefined;
  const service = new UsageService(
    async () => ({ usageAvailable: false }),
    async (window) => { received = window; return undefined; },
    () => new Date("2026-07-30T18:00:00.000Z")
  );
  await service.refresh();
  assert.deepEqual(received, { since: "2026-07-16", until: "2026-07-30", timezone: "UTC" });
});

test("sourceOwnWindow uses UTC calendar months after the bootstrap", () => {
  assert.deepEqual(sourceOwnWindow(new Date("2026-08-01T00:00:00.000Z")), { since: "2026-08-01", until: "2026-08-01", timezone: "UTC" });
  assert.deepEqual(sourceOwnWindow(new Date("2026-12-20T00:00:00.000Z")), { since: "2026-12-01", until: "2026-12-20", timezone: "UTC" });
  assert.deepEqual(sourceOwnWindow(new Date("2028-02-20T00:00:00.000Z")), { since: "2028-02-01", until: "2028-02-20", timezone: "UTC" });
});
