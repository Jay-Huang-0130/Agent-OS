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

export interface OpenAIBrowserLogin {
  type: "browser";
  loginId: string;
  authUrl: string;
}

export interface OpenAIDeviceLogin {
  type: "device";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export type OpenAIOAuthLogin = OpenAIBrowserLogin | OpenAIDeviceLogin;

export interface OpenAIAuthService {
  status(refresh?: boolean): Promise<OpenAIConnection>;
  startBrowserLogin(): Promise<OpenAIBrowserLogin>;
  startDeviceLogin(): Promise<OpenAIDeviceLogin>;
  completeBrowserLogin(redirectUrl: string): Promise<void>;
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

type ActiveLogin = {
  loginId: string;
  method: "browser" | "device";
  authUrl?: string;
};

function safeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown Codex error");
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function expectedLoopbackCallback(authUrl: string): { redirect: URL; state: string } {
  const authorization = new URL(authUrl);
  const redirectValue = authorization.searchParams.get("redirect_uri");
  const state = authorization.searchParams.get("state");
  if (!redirectValue || !state) {
    throw new Error("Codex did not provide a verifiable browser callback.");
  }
  const redirect = new URL(redirectValue);
  if (redirect.protocol !== "http:" || !isLoopbackHostname(redirect.hostname)) {
    throw new Error("Codex did not provide a safe loopback callback.");
  }
  return { redirect, state };
}

/**
 * Validate a browser-returned redirect before the Gateway forwards it to the
 * Codex loopback listener. This deliberately requires the exact callback
 * origin, path and OAuth state from the active authorization URL.
 */
export function validateLoopbackOAuthCallback(authUrl: string, redirectUrl: string): URL {
  const { redirect: expected, state: expectedState } = expectedLoopbackCallback(authUrl);
  const actual = new URL(redirectUrl);
  if (
    actual.protocol !== expected.protocol
    || actual.hostname !== expected.hostname
    || actual.port !== expected.port
    || actual.pathname !== expected.pathname
    || actual.username
    || actual.password
    || actual.hash
  ) {
    throw new Error("Only the callback URL created for this OpenAI sign-in can be submitted.");
  }
  if (actual.searchParams.get("state") !== expectedState) {
    throw new Error("The OpenAI callback state does not match this sign-in.");
  }
  if (!actual.searchParams.has("code") && !actual.searchParams.has("error")) {
    throw new Error("Paste the complete callback URL from the browser address bar.");
  }
  return actual;
}

export class CodexAuthBridge implements OpenAIAuthService {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private activeLogin: ActiveLogin | undefined;
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
      if (!completedId || completedId === this.activeLogin?.loginId) this.activeLogin = undefined;
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
          state: this.activeLogin ? "connecting" : "disconnected",
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

  async startBrowserLogin(): Promise<OpenAIBrowserLogin> {
    await this.ensureStarted();
    if (this.activeLogin) throw new Error("An OpenAI sign-in is already in progress.");
    const result = await this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    }, 30_000);
    const loginId = result.loginId;
    const authUrl = result.authUrl;
    if (typeof loginId !== "string" || typeof authUrl !== "string") {
      throw new Error("Codex returned an invalid OpenAI browser login response.");
    }
    // Reject an unverifiable callback up front instead of discovering it after
    // the user has completed authorization in another browser.
    expectedLoopbackCallback(authUrl);
    this.activeLogin = { loginId, method: "browser", authUrl };
    this.publish({ available: true, state: "connecting", authMode: null });
    return { type: "browser", loginId, authUrl };
  }

  async startDeviceLogin(): Promise<OpenAIDeviceLogin> {
    await this.ensureStarted();
    if (this.activeLogin) throw new Error("An OpenAI sign-in is already in progress.");
    const result = await this.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
    const loginId = result.loginId;
    const verificationUrl = result.verificationUrl;
    const userCode = result.userCode;
    if (typeof loginId !== "string" || typeof verificationUrl !== "string" || typeof userCode !== "string") {
      throw new Error("Codex returned an invalid OpenAI device login response.");
    }
    this.activeLogin = { loginId, method: "device" };
    this.publish({ available: true, state: "connecting", authMode: null });
    return { type: "device", loginId, verificationUrl, userCode };
  }

  async completeBrowserLogin(redirectUrl: string): Promise<void> {
    const active = this.activeLogin;
    if (!active || active.method !== "browser" || !active.authUrl) {
      throw new Error("There is no browser sign-in waiting for a callback.");
    }
    const callback = validateLoopbackOAuthCallback(active.authUrl, redirectUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(callback, { redirect: "manual", signal: controller.signal });
      if (response.status >= 400) {
        throw new Error("Codex rejected the OpenAI callback. Start a new sign-in and try again.");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("The local Codex callback timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("account/login/cancel", { loginId });
    if (this.activeLogin?.loginId === loginId) this.activeLogin = undefined;
    await this.status(false);
  }

  async logout(): Promise<void> {
    await this.ensureStarted();
    await this.request("account/logout", {});
    this.activeLogin = undefined;
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
