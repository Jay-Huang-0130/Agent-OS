import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  loadavg,
  networkInterfaces,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ServiceState = "healthy" | "starting" | "degraded" | "stopped";

export interface ResourceMetric {
  value: number;
  unit: "%" | "GB" | "°C";
  detail: string;
  status: "normal" | "warning" | "critical";
}

export interface SystemStatus {
  generatedAt: string;
  overall: "healthy" | "degraded" | "unavailable";
  host: {
    name: string;
    address: string;
    platform: string;
    uptimeSeconds: number;
    version: string;
  };
  resources: {
    cpu: ResourceMetric;
    memory: ResourceMetric;
    storage: ResourceMetric;
    temperature: ResourceMetric;
  };
  services: Array<{
    id: string;
    name: string;
    detail: string;
    state: ServiceState;
    latencyMs?: number;
  }>;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function statusFor(value: number, warning: number, critical: number): ResourceMetric["status"] {
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return "normal";
}

function lanAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

function storageMetric(): ResourceMetric {
  try {
    const root = platform() === "win32" ? process.cwd().slice(0, 3) : "/";
    const stats = statfsSync(root, { bigint: true });
    const total = Number(stats.blocks * stats.bsize);
    const available = Number(stats.bavail * stats.bsize);
    const used = Math.max(0, total - available);
    const percent = total === 0 ? 0 : round((used / total) * 100);
    return {
      value: percent,
      unit: "%",
      detail: `${round(used / 1024 ** 3)} / ${round(total / 1024 ** 3)} GB`,
      status: statusFor(percent, 80, 92),
    };
  } catch {
    return { value: 0, unit: "%", detail: "Storage metrics unavailable", status: "warning" };
  }
}

function temperatureMetric(): ResourceMetric {
  const thermalPath = "/sys/class/thermal/thermal_zone0/temp";
  if (existsSync(thermalPath)) {
    const value = Number.parseFloat(readFileSync(thermalPath, "utf8")) / 1_000;
    if (Number.isFinite(value)) {
      const rounded = round(value);
      return {
        value: rounded,
        unit: "°C",
        detail: "Raspberry Pi SoC",
        status: statusFor(rounded, 70, 82),
      };
    }
  }
  return { value: 0, unit: "°C", detail: "Sensor unavailable", status: "normal" };
}

async function browserService() {
  const startedAt = performance.now();
  const localController = join(homedir(), ".local", "bin", "agent-webctl");
  const controller = process.env.AGENT_OS_BROWSER_CTL ?? (existsSync(localController) ? localController : "agent-webctl");
  try {
    const { stdout } = await execFileAsync(controller, ["info"], {
      timeout: 2_000,
      windowsHide: true,
    });
    const ready = stdout.split(/\r?\n/u).some((line) => line.trim() === "READY=true");
    return {
      id: "browser",
      name: "Agent Web",
      state: ready ? ("healthy" as const) : ("degraded" as const),
      detail: ready ? "Persistent browser is ready." : "Browser component is not ready.",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    return {
      id: "browser",
      name: "Agent Web",
      state: "stopped" as const,
      detail: "Optional browser component is not installed.",
    };
  }
}

function platformLabel(): string {
  if (platform() !== "linux") return `${platform()} ${arch()}`;
  try {
    return execFileSync("uname", ["-srmo"], { encoding: "utf8", timeout: 1_000 }).trim();
  } catch {
    return `linux ${arch()}`;
  }
}

export async function collectSystemStatus(version: string): Promise<SystemStatus> {
  const total = totalmem();
  const used = Math.max(0, total - freemem());
  const memoryPercent = total === 0 ? 0 : round((used / total) * 100);
  const coreCount = Math.max(1, cpus().length);
  const cpuPercent = Math.min(100, round(((loadavg()[0] ?? 0) / coreCount) * 100));
  const browser = await browserService();
  const storage = storageMetric();
  const temperature = temperatureMetric();
  const addresses = lanAddresses();
  const degraded = memoryPercent >= 92 || storage.status === "critical" || temperature.status === "critical";

  return {
    generatedAt: new Date().toISOString(),
    overall: degraded ? "degraded" : "healthy",
    host: {
      name: hostname(),
      address: addresses[0] ?? "127.0.0.1",
      platform: platformLabel(),
      uptimeSeconds: Math.floor(uptime()),
      version,
    },
    resources: {
      cpu: {
        value: cpuPercent,
        unit: "%",
        detail: `${coreCount} cores · load ${round(loadavg()[0] ?? 0, 2)}`,
        status: statusFor(cpuPercent, 75, 92),
      },
      memory: {
        value: memoryPercent,
        unit: "%",
        detail: `${round(used / 1024 ** 3)} / ${round(total / 1024 ** 3)} GB`,
        status: statusFor(memoryPercent, 80, 92),
      },
      storage,
      temperature,
    },
    services: [
      {
        id: "gateway",
        name: "Agent-OS Gateway",
        state: "healthy",
        detail: "Management API and event stream are online.",
        latencyMs: 0,
      },
      browser,
      {
        id: "model",
        name: "Model runtime",
        state: "stopped",
        detail: "Model providers are introduced in Phase 3.",
      },
    ],
  };
}
