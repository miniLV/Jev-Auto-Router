import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pairedComparison, type CandidateEvaluation, type EvaluationPlan, type PairedTask } from "./paired-evaluation.js";
import type { HarnessConfig } from "./config.js";

interface EvaluationBundle {
  schema_version: "jev-active-evaluation-bundle-v1";
  config: HarnessConfig;
  plan: EvaluationPlan;
  tasks: PairedTask[];
  candidate_evaluations: CandidateEvaluation[];
  evidence_manifest: unknown[];
}

async function main(): Promise<void> {
  const [file, reportOption, reportPathArg, ...extra] = process.argv.slice(2);
  if (!file) {
    process.stderr.write("Usage: npm run bench:evaluate -- <sanitized-evaluation-bundle.json> [--report <report.json>]\n");
    process.exitCode = 2;
    return;
  }
  if ((reportOption !== undefined && reportOption !== "--report") ||
      (reportOption === "--report" && !reportPathArg) || extra.length > 0) {
    process.stderr.write("Usage: npm run bench:evaluate -- <sanitized-evaluation-bundle.json> [--report <report.json>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const inputPath = resolve(file);
    const inputBytes = await readFile(inputPath);
    const parsed = JSON.parse(inputBytes.toString("utf8")) as Partial<EvaluationBundle>;
    if (parsed.schema_version !== "jev-active-evaluation-bundle-v1" || !parsed.config || !parsed.plan ||
        !Array.isArray(parsed.tasks) || !Array.isArray(parsed.candidate_evaluations) || !Array.isArray(parsed.evidence_manifest) ||
        !hasExactKeys(parsed as Record<string, unknown>, ["schema_version", "config", "plan", "tasks", "candidate_evaluations", "evidence_manifest"])) {
      throw new Error("evaluation bundle has an unsupported schema");
    }
    const reportDirectory = reportPathArg ? dirname(resolve(reportPathArg)) : process.cwd();
    const bundlePath = toPosix(relative(reportDirectory, inputPath));
    if (!isContainedRelativePath(bundlePath)) throw new Error("evaluation bundle must be inside the report directory");
    const report = pairedComparison(parsed.config, parsed.plan, parsed.tasks, parsed.candidate_evaluations);
    report.active_evidence_bundle = {
      schema_version: "jev-active-evaluation-bundle-v1",
      path: bundlePath,
      sha256: createHash("sha256").update(inputBytes).digest("hex"),
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPathArg) await writeFile(resolve(reportPathArg), output);
    else process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid evaluation file"}\n`);
    process.exitCode = 1;
  }
}

function hasExactKeys(value: Record<string, unknown>, fields: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isContainedRelativePath(value: string): boolean {
  return value.length > 0 && value !== "." && !value.startsWith("../") && value !== ".." &&
    !isAbsolute(value) && !value.includes("\\") && !value.split("/").some(part => part === "" || part === "." || part === "..");
}

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

void main();
