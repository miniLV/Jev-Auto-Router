import { loadConfig } from "./config.js";
import { startCodexProxy } from "./proxy.js";

/** Standalone proxy for debugging; the normal entry point is `jev-codex`. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const requestedPort = Number(process.env.JEV_CODEX_PORT ?? "0");
  const proxy = await startCodexProxy({
    config,
    port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0,
  });
  process.stdout.write(`codex-router listening on http://127.0.0.1:${proxy.port}\n`);
  const stop = (): void => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

declare const require: { main?: unknown } | undefined;
try {
  const req = typeof require !== "undefined" ? require : undefined;
  if (req && (req as { main?: unknown }).main === module) {
    void main();
  }
} catch {
  // Imported as a library.
}
