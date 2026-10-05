import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, me, mockApi } from "./test-utils.ts";
import { session } from "./session.svelte.ts";
import { socket } from "./socket.svelte.ts";

// Just enough of a WebSocket to drive the connection by hand.
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
}

const last = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  session.me = me;
  socket.close(); // from an earlier test
  mockApi({ "GET /me": () => json(me) });
});

describe("socket", () => {
  it("connects to the API and hands events on, ignoring what isn't JSON", () => {
    const events: unknown[] = [];
    socket.connect((e) => events.push(e));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(last().url).toBe(`ws://${location.host}/api/ws`);
    last().open();
    last().receive({ type: "online", users: [] });
    last().receive("not json");
    last().receive({ id: 1, content: "hi" });
    expect(events).toEqual([{ type: "online", users: [] }, { id: 1, content: "hi" }]);
  });

  it("doesn't connect when signed out, nor twice", () => {
    session.me = null;
    socket.connect(() => {});
    expect(FakeSocket.instances).toHaveLength(0);
    session.me = me;
    socket.connect(() => {});
    socket.connect(() => {});
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("sends JSON while open, and says when it can't", () => {
    expect(socket.send({ a: 1 })).toBe(false); // never connected
    socket.connect(() => {});
    expect(socket.send({ a: 1 })).toBe(false); // still connecting
    last().open();
    expect(socket.send({ a: 1 })).toBe(true);
    expect(last().sent).toEqual(['{"a":1}']);
  });

  it("reconnects with a growing delay, and starts over once connected", async () => {
    socket.connect(() => {});
    last().open();

    last().close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2); // after 1 s

    last().close(); // never opened
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3); // after 2 s

    last().open(); // a good connection: the next drop waits 1 s again
    last().close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("never waits longer than 30 seconds", async () => {
    socket.connect(() => {});
    for (let i = 0; i < 12; i++) {
      last().close();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const before = FakeSocket.instances.length;
    last().close();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeSocket.instances).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(before + 1);
  });

  it("checks the session when a connection is refused before opening", async () => {
    const api = mockApi({ "GET /me": () => json(me) });
    socket.connect(() => {});
    last().close();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.paths()).toContain("GET /me");

    api.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().close(); // a drop after a good connection isn't a refusal
    await vi.advanceTimersByTimeAsync(0);
    expect(api.paths()).not.toContain("GET /me");
  });

  it("stays closed after close(), even with a reconnect pending", async () => {
    socket.connect(() => {});
    last().close();
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.send({})).toBe(false);
  });

  it("doesn't reconnect once signed out", async () => {
    socket.connect(() => {});
    last().open();
    session.me = null;
    last().close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("can be connected again after close()", () => {
    socket.connect(() => {});
    socket.close();
    socket.connect(() => {});
    expect(FakeSocket.instances).toHaveLength(2);
    last().open();
    last().close();
    expect(vi.getTimerCount()).toBe(1); // reconnecting again
  });
});
