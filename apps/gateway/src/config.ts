import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface GatewayConfig {
  host: string;
  port: number;
  stateDir: string;
  databasePath: string;
  pairingCodePath: string;
  codexHome: string;
  codexEntrypoint: string;
  pythonExecutable: string;
  webDistPath: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  sessionTtlSeconds: number;
  version: string;
}

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const stateDir = process.env.AGENT_OS_STATE_DIR
    ? resolve(process.env.AGENT_OS_STATE_DIR)
    : join(homedir(), ".local", "state", "agent-os");

  const tlsCertPath = process.env.AGENT_OS_TLS_CERT_FILE;
  const tlsKeyPath = process.env.AGENT_OS_TLS_KEY_FILE;

  return {
    host: process.env.AGENT_OS_HOST ?? "0.0.0.0",
    port: integerFromEnv("AGENT_OS_PORT", 8787),
    stateDir,
    databasePath: process.env.AGENT_OS_DATABASE_PATH ?? join(stateDir, "agent-os.db"),
    pairingCodePath: process.env.AGENT_OS_PAIRING_CODE_FILE ?? join(stateDir, "pairing-code"),
    codexHome: process.env.AGENT_OS_CODEX_HOME
      ? resolve(process.env.AGENT_OS_CODEX_HOME)
      : join(stateDir, "credentials", "codex"),
    codexEntrypoint: process.env.AGENT_OS_CODEX_ENTRYPOINT
      ? resolve(process.env.AGENT_OS_CODEX_ENTRYPOINT)
      : resolve(process.cwd(), "node_modules", "@openai", "codex", "bin", "codex.js"),
    pythonExecutable: process.env.AGENT_OS_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    webDistPath: process.env.AGENT_OS_WEB_DIST
      ? resolve(process.env.AGENT_OS_WEB_DIST)
      : resolve(process.cwd(), "apps", "web", "dist"),
    ...(tlsCertPath ? { tlsCertPath: resolve(tlsCertPath) } : {}),
    ...(tlsKeyPath ? { tlsKeyPath: resolve(tlsKeyPath) } : {}),
    sessionTtlSeconds: integerFromEnv("AGENT_OS_SESSION_TTL_SECONDS", 60 * 60 * 24 * 7),
    version: process.env.AGENT_OS_VERSION ?? "0.1.0",
    ...overrides,
  };
}

export function publicDeviceName(): string {
  return process.env.AGENT_OS_DEVICE_NAME ?? hostname();
}
