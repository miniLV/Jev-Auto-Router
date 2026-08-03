export type OfficialCredit =
  | { status: "available"; limit: string; used: string; remaining: string; remainingPercent: number; resetsAt: string }
  | { status: "unavailable" };

export interface UsageViewModel {
  observationWindow: ObservationWindow;
  officialCredit: OfficialCredit;
  estimatedCreditAttribution: Array<{ model: string; credits: string; share: number }>;
  attributionQuality: { status: "estimated" | "unavailable"; message: string };
  diagnostics: ReadinessDiagnostic[];
}

export interface ReadinessDiagnostic {
  source: "official" | "local";
  code: "codex-missing" | "ccusage-missing" | "read-timeout" | "invalid-response" | "unavailable" | "no-usage";
  message: string;
  remediation: string;
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
  diagnostic?: ReadinessDiagnostic;
}

export interface LocalUsage {
  models: Array<{ model: string; tokens: number }>;
  skippedEntries: number;
  diagnostic?: ReadinessDiagnostic;
}

export interface ObservationWindow {
  since: string;
  until: string;
  timezone: string;
}
