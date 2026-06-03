import { describe, it, expect } from "vitest";
import { env, exports } from "cloudflare:workers";

// Helper: drive the Worker's default export through real workerd routing.
// exports.default is typed as Fetcher (1-2 arg fetch) at compile time, but at
// runtime in workerd it's a full ExportedHandler whose fetch takes (request, env, ctx).
// We cast through `any` to pass all three args and preserve the `this` binding.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (exports.default as any).fetch(new Request(input, init), env, {
    waitUntil() {},
    passThroughOnException() {},
  }) as Promise<Response>;
}

describe("worker routing", () => {
  it("GET /api/health returns { ok: true }", async () => {
    const res = await fetchWorker("https://example.com/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it("GET /ws/public without an Upgrade header returns 426", async () => {
    const res = await fetchWorker("https://example.com/ws/public");
    expect(res.status).toBe(426);
  });

  it("WebSocket upgrade to /ws/test returns 101 and yields a welcome or snap", async () => {
    const res = await fetchWorker("https://example.com/ws/test?name=tester", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);

    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    if (!ws) throw new Error("no webSocket on the 101 response");
    ws.accept();

    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no message within 2s")),
        2000,
      );
      ws.addEventListener("message", (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(typeof event.data === "string" ? event.data : "");
      });
      // Send a valid InMsg so the room is exercised; welcome/snap arrives regardless.
      ws.send(
        JSON.stringify({
          t: "in",
          seq: 1,
          ts: Date.now(),
          p: [0, 1, 0],
          r: [0, 0],
          v: [0, 0, 0],
        }),
      );
    });

    const parsed = JSON.parse(first) as { t: string };
    expect(["welcome", "snap"]).toContain(parsed.t);

    ws.close();
  });
});
