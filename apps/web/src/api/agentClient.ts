import type {
  ActivityItem,
  AgentEvent,
  BootstrapResponse,
  ConnectionState,
  MetaResponse,
  OpenAIConnection,
  OpenAIDeviceLogin,
  SessionResponse,
  Settings,
  SetupInput,
  SystemStatus,
} from "./model";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code = "unknown_error") {
    super(message);
    this.name = "ApiError";
  }
}

export class AgentClient {
  private csrfToken?: string;

  private async request<T>(path: string, init: RequestInit = {}, csrf = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (csrf && this.csrfToken) headers.set("x-csrf-token", this.csrfToken);
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers, credentials: "same-origin" });
    } catch {
      throw new ApiError("無法連線到 Agent-OS，請確認樹莓派仍在線上。", 0, "network_error");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      throw new ApiError(body?.message ?? `Agent-OS 回應錯誤 (${response.status})`, response.status, body?.code);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async bootstrap(): Promise<BootstrapResponse> {
    const meta = await this.request<MetaResponse>("/api/v1/meta");
    if (meta.setupRequired) return { meta, session: { authenticated: false } };
    const session = await this.request<SessionResponse>("/api/v1/auth/session");
    this.csrfToken = session.csrfToken;
    return { meta, session };
  }

  async setup(input: SetupInput): Promise<BootstrapResponse> {
    await this.request<void>("/api/v1/setup/complete", {
      method: "POST",
      body: JSON.stringify({ ...input, pairingCode: input.pairingCode.replace(/[\s-]/g, "").toUpperCase() }),
    });
    return this.bootstrap();
  }

  async login(password: string): Promise<BootstrapResponse> {
    await this.request<void>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    return this.bootstrap();
  }

  async logout(): Promise<void> {
    await this.request<void>("/api/v1/auth/logout", { method: "POST" }, true);
    this.csrfToken = undefined;
  }

  async dashboard(): Promise<{ system: SystemStatus; activity: ActivityItem[] }> {
    const [system, activity] = await Promise.all([
      this.request<SystemStatus>("/api/v1/system/status"),
      this.request<ActivityItem[]>("/api/v1/activity"),
    ]);
    return { system, activity };
  }

  settings(): Promise<Settings> {
    return this.request<Settings>("/api/v1/settings");
  }

  updateSettings(settings: Settings): Promise<Settings> {
    return this.request<Settings>("/api/v1/settings", { method: "PUT", body: JSON.stringify(settings) }, true);
  }

  openAIStatus(): Promise<OpenAIConnection> {
    return this.request<OpenAIConnection>("/api/v1/providers/openai");
  }

  startOpenAIOAuth(): Promise<OpenAIDeviceLogin> {
    return this.request<OpenAIDeviceLogin>("/api/v1/providers/openai/oauth/start", { method: "POST" }, true);
  }

  cancelOpenAIOAuth(loginId: string): Promise<void> {
    return this.request<void>("/api/v1/providers/openai/oauth/cancel", {
      method: "POST",
      body: JSON.stringify({ loginId }),
    }, true);
  }

  disconnectOpenAI(): Promise<void> {
    return this.request<void>("/api/v1/providers/openai/logout", { method: "POST" }, true);
  }

  subscribe(onEvent: (event: AgentEvent) => void, onState: (state: ConnectionState) => void): () => void {
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let attempts = 0;
    const connect = () => {
      if (stopped) return;
      onState(attempts ? "reconnecting" : "connecting");
      const url = new URL("/api/v1/events", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("open", () => { attempts = 0; onState("online"); });
      socket.addEventListener("message", (message) => {
        try { onEvent(JSON.parse(String(message.data)) as AgentEvent); } catch { /* Ignore malformed frames. */ }
      });
      socket.addEventListener("error", () => socket?.close());
      socket.addEventListener("close", () => {
        if (stopped) return;
        attempts += 1;
        onState("reconnecting");
        timer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5)));
      });
    };
    connect();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
      onState("offline");
    };
  }
}
