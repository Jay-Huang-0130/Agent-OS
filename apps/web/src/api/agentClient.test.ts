import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient, ApiError } from "./agentClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AgentClient", () => {
  it("stops bootstrap at metadata while first-time setup is required", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: "Agent-OS",
      version: "0.1.0",
      setupRequired: true,
      secure: true,
      hostname: "agent-os.local",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AgentClient().bootstrap();

    expect(result.meta.setupRequired).toBe(true);
    expect(result.session.authenticated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "invalid_credentials",
      message: "密碼錯誤",
    }), { status: 401, headers: { "content-type": "application/json" } })));

    await expect(new AgentClient().login("wrong"))
      .rejects.toEqual(expect.objectContaining<ApiError>({
        name: "ApiError",
        status: 401,
        code: "invalid_credentials",
        message: "密碼錯誤",
      }));
  });

  it("starts OpenAI OAuth with the authenticated CSRF token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "Agent-OS", version: "0.1.0", setupRequired: false, secure: true, hostname: "pi",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true, csrfToken: "csrf-test", user: { id: "owner", displayName: "Owner", initials: "OW" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        loginId: "8d1e249e-57a0-47cb-af4d-1e55b71fbf40",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient();
    await client.bootstrap();

    const login = await client.startOpenAIOAuth();

    expect(login.userCode).toBe("ABCD-1234");
    const [path, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(path).toBe("/api/v1/providers/openai/oauth/start");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-test");
  });
});
