import { readOfficialSnapshot } from "./app-server.js";
import { makeViewModel } from "./credit.js";
import { readLocalUsage } from "./local.js";
import type { LocalUsage, ObservationWindow, OfficialSnapshot, SnapshotProvider, UsageViewModel } from "./types.js";

function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function sourceOwnWindow(now = new Date()): ObservationWindow {
  const bootstrapEnd = Date.UTC(2026, 7, 1);
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = now.valueOf() < bootstrapEnd
    ? Date.UTC(2026, 6, 16)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return { since: utcDate(start), until: utcDate(currentDay), timezone: "UTC" };
}

export class UsageService implements SnapshotProvider {
  constructor(
    private readonly officialReader: () => Promise<OfficialSnapshot> = readOfficialSnapshot,
    private readonly localReader: (window: ObservationWindow) => Promise<LocalUsage | undefined> = readLocalUsage,
    private readonly now: () => Date = () => new Date()
  ) {}

  async refresh(): Promise<UsageViewModel> {
    const official = await this.officialReader();
    const window = sourceOwnWindow(this.now());
    const local = await this.localReader(window);
    return makeViewModel(official, local, window);
  }
}
