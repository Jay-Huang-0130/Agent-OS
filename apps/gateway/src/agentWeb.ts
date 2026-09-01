import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenAIOAuthBrowserLaunch {
  openedOnAgentWeb: boolean;
  humanUrl?: string;
}

export interface OpenAIOAuthBrowser {
  open(authUrl: string): Promise<OpenAIOAuthBrowserLaunch>;
}

export function isAllowedOpenAIAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (url.hostname === "auth.openai.com" || url.hostname === "chatgpt.com");
  } catch {
    return false;
  }
}

export function parseAgentWebInfo(output: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of output.split(/\r?\n/gu)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!/^[A-Z0-9_]+$/u.test(key)) continue;
    info[key] = line.slice(separator + 1);
  }
  return info;
}

export function isAllowedAgentWebOAuthSocket(value: string | undefined): value is string {
  return value === "/run/agent-web-oauth/open.sock";
}

function validHumanUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class AgentWebOAuthBrowser implements OpenAIOAuthBrowser {
  private readonly controller: string;

  constructor(controller = process.env.AGENT_OS_BROWSER_CTL) {
    const localController = join(homedir(), ".local", "bin", "agent-webctl");
    this.controller = controller ?? (existsSync(localController) ? localController : "agent-webctl");
  }

  private info(): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      execFile(this.controller, ["info"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) reject(error);
        else resolve(parseAgentWebInfo(stdout));
      });
    });
  }

  private openUrl(authUrl: string, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: socketPath });
      let response = "";
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        finish(new Error("Agent Web OAuth browser timed out."));
      }, 25_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const finishFromResponse = () => finish(
        response.trim() === "OK"
          ? undefined
          : new Error("Agent Web could not open the OAuth page."),
      );
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.end(`${authUrl}\n`));
      socket.on("data", (chunk: string) => {
        response += chunk;
        if (response.length > 1024) {
          socket.destroy();
          finish(new Error("Agent Web returned an invalid OAuth response."));
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("end", finishFromResponse);
      socket.once("close", finishFromResponse);
    });
  }

  async open(authUrl: string): Promise<OpenAIOAuthBrowserLaunch> {
    if (!isAllowedOpenAIAuthUrl(authUrl)) return { openedOnAgentWeb: false };
    try {
      const info = await this.info();
      const humanUrl = validHumanUrl(info.HUMAN_URL);
      if (
        info.READY !== "true"
        || info.OPENAI_OAUTH_BROWSER_AVAILABLE !== "true"
        || info.OPENAI_OAUTH_BROWSER_PROTOCOL !== "agent-web-openai-oauth-v1"
        || !isAllowedAgentWebOAuthSocket(info.OPENAI_OAUTH_BROWSER_SOCKET)
        || !humanUrl
      ) {
        return { openedOnAgentWeb: false };
      }
      await this.openUrl(authUrl, info.OPENAI_OAUTH_BROWSER_SOCKET);
      return { openedOnAgentWeb: true, humanUrl };
    } catch {
      return { openedOnAgentWeb: false };
    }
  }
}
