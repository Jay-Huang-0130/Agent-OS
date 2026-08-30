import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentDatabase } from "./database.js";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "agent_os_session";

export interface AuthenticatedSession {
  tokenHash: string;
  userId: string;
  displayName: string;
  csrfToken: string;
  expiresAt: string;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, expectedHash: string, salt: string): Promise<boolean> {
  const candidate = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function readSession(request: FastifyRequest, database: AgentDatabase): AuthenticatedSession | undefined {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  const tokenHash = hashToken(token);
  const record = database.getSession(tokenHash);
  if (!record) return undefined;
  return {
    tokenHash,
    userId: record.userId,
    displayName: record.displayName,
    csrfToken: record.csrfToken,
    expiresAt: record.expiresAt,
  };
}

export function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  database: AgentDatabase,
): AuthenticatedSession | undefined {
  const session = readSession(request, database);
  if (!session) {
    void reply.code(401).send({ error: "authentication_required", message: "Please sign in to Agent-OS." });
    return undefined;
  }
  return session;
}

export function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  session: AuthenticatedSession,
): boolean {
  const value = request.headers["x-csrf-token"];
  if (typeof value !== "string" || value.length !== session.csrfToken.length) {
    void reply.code(403).send({ error: "invalid_csrf_token", message: "Refresh the page and try again." });
    return false;
  }
  const valid = timingSafeEqual(Buffer.from(value), Buffer.from(session.csrfToken));
  if (!valid) void reply.code(403).send({ error: "invalid_csrf_token", message: "Refresh the page and try again." });
  return valid;
}

export function createSession(database: AgentDatabase, userId: string, ttlSeconds: number) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1_000);
  database.createSession({
    tokenHash: hashToken(token),
    userId,
    csrfToken,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return { token, csrfToken, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}
