export type OfficialCredit =
  | { status: "available"; limit: string; used: string; remaining: string; remainingPercent: number; resetsAt: string }
  | { status: "unavailable" };

export interface UsageViewModel {
  officialCredit: OfficialCredit;
  estimatedCreditAttribution: Array<{ model: string; credits: string }>;
  attributionQuality: { status: "estimated" | "unavailable"; message: string };
}

export interface SnapshotProvider {
  refresh(): Promise<UsageViewModel>;
}

export interface OfficialRateLimit {
  limit: string;
  used: string;
  remaining: string;
  remainingPercent: number;
  resetsAt: string;
}

export interface OfficialSnapshot {
  rateLimit?: OfficialRateLimit;
  usageAvailable: boolean;
}

export interface LocalUsage {
  models: Array<{ model: string; tokens: number }>;
  skippedEntries: number;
}

export interface ObservationWindow {
  since: string;
  until: string;
  timezone: string;
}
