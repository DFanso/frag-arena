import { describe, it, expect } from "vitest";
import { buildWsUrl, backoff } from "../src/net-helpers";

describe("buildWsUrl", () => {
  it("uses wss:// when the page is served over https", () => {
    const loc = { protocol: "https:", host: "cf-fps.example.workers.dev" };
    expect(buildWsUrl(loc, "public", "alice")).toBe(
      "wss://cf-fps.example.workers.dev/ws/public?name=alice",
    );
  });

  it("uses ws:// when the page is served over http (localhost dev)", () => {
    const loc = { protocol: "http:", host: "localhost:5173" };
    expect(buildWsUrl(loc, "arena1", "bob")).toBe(
      "ws://localhost:5173/ws/arena1?name=bob",
    );
  });

  it("includes the room code in the path", () => {
    const loc = { protocol: "https:", host: "h" };
    expect(buildWsUrl(loc, "my-room", "carol")).toBe(
      "wss://h/ws/my-room?name=carol",
    );
  });

  it("url-encodes the nickname query value", () => {
    const loc = { protocol: "https:", host: "h" };
    expect(buildWsUrl(loc, "public", "a b&c=d")).toBe(
      "wss://h/ws/public?name=a%20b%26c%3Dd",
    );
  });
});

describe("backoff", () => {
  it("starts at 500ms for attempt 0 and doubles for attempt 1", () => {
    expect(backoff(0)).toBe(500);
    expect(backoff(1)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(backoff(2)).toBe(2000);
    expect(backoff(3)).toBe(4000);
    expect(backoff(4)).toBe(8000);
  });

  it("caps at 8000ms", () => {
    expect(backoff(5)).toBe(8000);
    expect(backoff(50)).toBe(8000);
  });
});
