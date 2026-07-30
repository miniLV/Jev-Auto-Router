import { createDashboardServer } from "./server.js";
import { UsageService } from "./service.js";

const server = createDashboardServer(new UsageService());
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});

const stop = (): void => { server.close(() => process.exit(0)); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
