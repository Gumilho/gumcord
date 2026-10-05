// Helpers for the unit tests.
import { vi } from "vitest";

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export type Handler = (req: { url: string; method: string; body: unknown; signal?: AbortSignal | null }) => Response | Promise<Response>;

// Stands in for the backend: routes are "METHOD /path" (without /api), answered by the handler.
// Anything else is a 404, and every request is recorded.
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace(/^\/api/, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    return handler ? handler({ url, method, body, signal: init.signal }) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetch: fetchMock, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
}

export const me = { id: 1, name: "me", avatar: "", admin: false };
export const admin = { ...me, admin: true };
export const server = (id: number, name = `server ${id}`) => ({ id, name, icon: "" });
export const channel = (id: number, serverId = 1, kind: "text" | "voice" = "text", name = `ch${id}`) =>
  ({ id, server_id: serverId, name, kind });
export const message = (id: number, channelId: number, authorId = 2, content = `m${id}`) =>
  ({ id, channel_id: channelId, author_id: authorId, author: `user${authorId}`, content, created_at: "2026-01-01 00:00:00" });
