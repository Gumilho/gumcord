import { describe, expect, it, vi } from "vitest";
import { errorText, fetchWithTimeout, wsUrl } from "./net.ts";

// A fetch that never answers, and fails the way a real one does when it's aborted.
function hangingFetch() {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (init.signal?.aborted) abort(); // as the real one does
    else init.signal?.addEventListener("abort", abort);
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchWithTimeout", () => {
  it("gives up on a stalled server", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const result = fetchWithTimeout("/api/x", {}, 1000);
    const failed = expect(result).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    result.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await failed;
  });

  it("stops when the caller aborts, and when it already had", async () => {
    hangingFetch();
    const ctrl = new AbortController();
    const result = fetchWithTimeout("/api/x", { signal: ctrl.signal });
    ctrl.abort();
    await expect(result).rejects.toThrow("aborted");

    const done = new AbortController();
    done.abort();
    await expect(fetchWithTimeout("/api/x", { signal: done.signal })).rejects.toThrow("aborted");
  });

  it("passes the request through, and doesn't leave its timer running", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithTimeout("/api/x", { method: "POST", body: "b" });
    expect(await res.text()).toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/x");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: "b" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("errorText", () => {
  it("is the server's reason", async () => {
    expect(await errorText(new Response("a channel with that name already exists", { status: 409 })))
      .toBe("a channel with that name already exists");
  });

  it("says the status when the server gave no reason", async () => {
    expect(await errorText(new Response("", { status: 502 }))).toBe("Failed (502).");
    expect(await errorText(new Response("  \n", { status: 500 }))).toBe("Failed (500).");
  });
});

describe("wsUrl", () => {
  it("follows the page's address and scheme", () => {
    expect(wsUrl("/api/ws")).toBe(`ws://${location.host}/api/ws`);
    expect(wsUrl()).toBe(`ws://${location.host}`);
    vi.stubGlobal("location", { protocol: "https:", host: "chat.example.com" });
    expect(wsUrl("/rtc")).toBe("wss://chat.example.com/rtc");
  });
});
