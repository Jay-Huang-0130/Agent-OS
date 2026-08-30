import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { GatewayConfig } from "./config.js";

export type OpenAIConnectionState = "unavailable" | "disconnected" | "connecting" | "connected" | "error";

export interface OpenAIConnection {
  available: boolean;
  state: OpenAIConnectionState;
  authMode: string | null;
  email?: string;
  planType?: string;
  error?: string;
}

export interface OpenAIDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface OpenAIAuthService {
  status(refresh?: boolean): Promise<OpenAIConnection>;
  startDeviceLogin(): Promise<OpenAIDeviceLogin>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  onUpdate(listener: (status: OpenAIConnection) => void): () => void;
  close(): Promise<void>;
}

type RpcResult = Record<string, unknown>;
type PendingRequest = {
  resolve(value: RpcResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

function safeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown Codex error");
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

export class CodexAuthBridge implements OpenAIAuthService {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private activeLoginId: string | undefined;
  private shuttingDown = false;

  constructor(private readonly config: GatewayConfig) {}

  onUpdate(listener: (status: OpenAIConnection) => void): () => void {
    this.events.on("update", listener);
    return () => this.events.off("update", listener);
  }

  private publish(status: OpenAIConnection): OpenAIConnection {
    this.events.emit("update", status);
    return status;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    if (!existsSync(this.config.codexEntrypoint)) {
      throw new Error("OpenAI Codex runtime is not installed in this Agent-OS release.");
    }
    mkdirSync(this.config.codexHome, { recursive: true, mode: 0o700 });
    this.shuttingDown = false;
    const child = spawn(process.execPath, [this.config.codexEntrypoint, "app-server", "--stdio"], {
      cwd: this.config.codexHome,
      env: { ...process.env, CODEX_HOME: this.config.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => { /* Codex diagnostics can contain local paths; do not expose them to the UI. */ });
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) => {
      if (!this.shuttingDown) this.handleExit(new Error(`Codex app-server stopped (${signal ?? code ?? "unknown"}).`));
    });

    await this.request("initialize", {
      clientInfo: { name: "agent_os", title: "Agent-OS", version: this.config.version },
    }, 15_000);
    this.notify("initialized", {});
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-protocol output. Authentication secrets are never logged.
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(safeMessage(error.message ?? "Codex request failed.")));
      } else {
        pending.resolve((message.result ?? {}) as RpcResult);
      }
      return;
    }

    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "account/login/completed") {
      const completedId = typeof params.loginId === "string" ? params.loginId : undefined;
      if (!completedId || completedId === this.activeLoginId) this.activeLoginId = undefined;
      if (params.success === false) {
        this.publish({ available: true, state: "error", authMode: null, error: safeMessage(params.error) });
      } else {
        void this.status(false);
      }
    }
    if (message.method === "account/updated") void this.status(false);
  }

  private handleExit(error: Error): void {
    this.child = undefined;
    this.stdoutBuffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.shuttingDown) this.publish({ available: false, state: "error", authMode: null, error: safeMessage(error) });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResult> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async status(refresh = false): Promise<OpenAIConnection> {
    try {
      await this.ensureStarted();
      const result = await this.request("account/read", { refreshToken: refresh }, 20_000);
      const account = result.account as { type?: unknown; email?: unknown; planType?: unknown } | null | undefined;
      if (!account) {
        return this.publish({
          available: true,
          state: this.activeLoginId ? "connecting" : "disconnected",
          authMode: null,
        });
      }
      return this.publish({
        available: true,
        state: "connected",
        authMode: typeof account.type === "string" ? account.type : "unknown",
        ...(typeof account.email === "string" ? { email: account.email } : {}),
        ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
      });
    } catch (error) {
      return this.publish({
        available: existsSync(this.config.codexEntrypoint),
        state: existsSync(this.config.codexEntrypoint) ? "error" : "unavailable",
        authMode: null,
        error: safeMessage(error),
      });
    }
  }

  async startDeviceLogin(): Promise<OpenAIDeviceLogin> {
    await this.ensureStarted();
    if (this.activeLoginId) throw new Error("An OpenAI sign-in is already in progress.");
    const result = await this.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
    const loginId = result.loginId;
    const verificationUrl = result.verificationUrl;
    const userCode = result.userCode;
    if (typeof loginId !== "string" || typeof verificationUrl !== "string" || typeof userCode !== "string") {
      throw new Error("Codex returned an invalid OpenAI device login response.");
    }
    this.activeLoginId = loginId;
    this.publish({ available: true, state: "connecting", authMode: null });
    return { loginId, verificationUrl, userCode };
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("account/login/cancel", { loginId });
    if (this.activeLoginId === loginId) this.activeLoginId = undefined;
    await this.status(false);
  }

  async logout(): Promise<void> {
    await this.ensureStarted();
    await this.request("account/logout", {});
    this.activeLoginId = undefined;
    this.publish({ available: true, state: "disconnected", authMode: null });
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server is shutting down."));
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Process already stopped. */ }
        resolve();
      }, 2_000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once("exit", done);
      child.once("error", done);
      child.kill("SIGTERM");
    });
  }
}
