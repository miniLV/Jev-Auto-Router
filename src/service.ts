import { readOfficialSnapshot } from "./app-server.js";
import { makeViewModel } from "./credit.js";
import { readLocalUsage } from "./local.js";
import type { LocalUsage, ObservationWindow, OfficialSnapshot, SnapshotProvider, UsageViewModel } from "./types.js";

export function sourceOwnWindow(now = new Date()): ObservationWindow {
  const until = now;
  const since = new Date(until.valueOf() - 30 * 24 * 60 * 60 * 1000);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10), timezone: "UTC" };
}

export class UsageService implements SnapshotProvider {
  constructor(
    private readonly officialReader: () => Promise<OfficialSnapshot> = readOfficialSnapshot,
    private readonly localReader: (window: ObservationWindow) => Promise<LocalUsage | undefined> = readLocalUsage,
    private readonly now: () => Date = () => new Date()
  ) {}

  async refresh(): Promise<UsageViewModel> {
    const official = await this.officialReader();
    const local = await this.localReader(sourceOwnWindow(this.now()));
    return makeViewModel(official, local);
  }
}
