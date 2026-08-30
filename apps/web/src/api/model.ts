export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
export type ServiceState = "healthy" | "starting" | "degraded" | "stopped";

export interface MetaResponse {
  name: string;
  version: string;
  setupRequired: boolean;
  secure: boolean;
  hostname: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: { id: string; displayName: string; initials: string };
  csrfToken?: string;
}

export interface BootstrapResponse {
  meta: MetaResponse;
  session: SessionResponse;
}

export interface ResourceMetric {
  value: number;
  unit: "%" | "GB" | "°C";
  detail: string;
  status: "normal" | "warning" | "critical";
}

export interface SystemStatus {
  generatedAt: string;
  overall: "healthy" | "degraded" | "unavailable";
  host: { name: string; address: string; platform: string; uptimeSeconds: number; version: string };
  resources: Record<"cpu" | "memory" | "storage" | "temperature", ResourceMetric>;
  services: Array<{ id: string; name: string; detail: string; state: ServiceState; latencyMs?: number }>;
}

export interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  kind: "system" | "security" | "settings" | "update";
  occurredAt: string;
}

export interface Settings {
  deviceName: string;
  language: "zh-Hant" | "en";
  timezone: string;
  theme: "system" | "light" | "dark";
}

export interface SetupInput {
  pairingCode: string;
  password: string;
  displayName: string;
}

export type AgentEvent =
  | { type: "heartbeat"; data: { at: string } }
  | { type: "activity.created"; data: ActivityItem }
  | { type: "settings.updated"; data: Settings };
