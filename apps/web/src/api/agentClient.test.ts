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
});
