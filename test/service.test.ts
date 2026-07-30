import assert from "node:assert/strict";
import test from "node:test";
import { UsageService } from "../src/service.js";
import type { ObservationWindow } from "../src/types.js";

test("UsageService passes a UTC date-only source-own past-30-days window to ccusage", async () => {
  let received: ObservationWindow | undefined;
  const service = new UsageService(
    async () => ({ usageAvailable: false }),
    async (window) => { received = window; return undefined; },
    () => new Date("2026-07-30T18:00:00.000Z")
  );
  await service.refresh();
  assert.deepEqual(received, { since: "2026-06-30", until: "2026-07-30", timezone: "UTC" });
});
