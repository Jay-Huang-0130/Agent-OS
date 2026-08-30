import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

function lanAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

const config = loadConfig();
const app = await buildApp(config, { logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down Agent-OS Gateway");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
  const urls = lanAddresses().map((address) => `${protocol}://${address}:${config.port}`);
  app.log.info({ urls: urls.length ? urls : [`${protocol}://localhost:${config.port}`] }, "Agent-OS is ready");
  if (existsSync(config.pairingCodePath)) {
    const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
    app.log.warn({ pairingCode }, "first-time pairing code");
  }
} catch (error) {
  app.log.error(error, "Agent-OS Gateway failed to start");
  process.exit(1);
}
