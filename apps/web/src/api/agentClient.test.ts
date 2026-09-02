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
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-test");
  });

  it("creates durable Goals with CSRF and an idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "Agent-OS", version: "0.1.0", setupRequired: false, secure: true, hostname: "pi",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true, csrfToken: "csrf-phase-4", user: { id: "owner", displayName: "Owner", initials: "OW" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "goal-1", status: "ACTIVE" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient();
    await client.bootstrap();

    await client.createGoal({
      title: "Phase 4 Goal",
      desiredOutcome: "A real Secretary Portfolio",
      completionCriteria: ["Portfolio is connected to SQLite"],
      autonomy: "PREPARE",
    });

    const [path, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(path).toBe("/api/v1/goals");
    expect(init.method).toBe("POST");
    expect(headers.get("x-csrf-token")).toBe("csrf-phase-4");
    expect(headers.get("idempotency-key")).toBeTruthy();
  });

  it("loads the complete Goal detail used by the clickable Goal drawer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      goal: { id: "goal-1", title: "AI Goal" }, plans: [{ id: "plan-1" }],
      tasks: [{ id: "task-1" }], wakes: [], timeline: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await new AgentClient().goalDetail("goal/1");

    expect(detail.tasks[0]?.id).toBe("task-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/goals/goal%2F1/detail", expect.any(Object));
  });

  it("sends unclassified natural language through the unified assistant intake", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "Agent-OS", version: "0.1.0", setupRequired: false, secure: true, hostname: "pi",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true, csrfToken: "csrf-assistant", user: { id: "owner", displayName: "Owner", initials: "OW" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        request: { id: "request-1", message: "幫我找實習", status: "PENDING_ROUTING" },
        router: { state: "PENDING_RUNTIME", executionMode: null, confidence: null },
        assistantMessage: "已保存",
      }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient();
    await client.bootstrap();

    await client.submitAssistantRequest("幫我找實習", { conversationId: "bf2abf83-6fea-4a3e-925c-52d2bde3264f", model: "gpt-test" });

    const [path, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(path).toBe("/api/v1/assistant/requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ message: "幫我找實習",
      conversationId: "bf2abf83-6fea-4a3e-925c-52d2bde3264f", model: "gpt-test" });
    expect(headers.get("x-csrf-token")).toBe("csrf-assistant");
    expect(headers.get("idempotency-key")).toBeTruthy();
  });
});
