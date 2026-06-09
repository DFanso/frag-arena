import { describe, it, expect } from "vitest";
import { ConnRateLimiter, pickClientIp } from "../worker/ratelimit";

describe("ConnRateLimiter", () => {
  it("allows hits up to the limit, then blocks within the window", () => {
    const rl = new ConnRateLimiter(3, 1000);
    expect(rl.hit("a", 0)).toBe(true); // 1
    expect(rl.hit("a", 100)).toBe(true); // 2
    expect(rl.hit("a", 200)).toBe(true); // 3 (at limit)
    expect(rl.hit("a", 300)).toBe(false); // 4 — over
    expect(rl.hit("a", 999)).toBe(false); // still over, window not yet rolled
  });

  it("keeps blocking a sustained flood until the window rolls over", () => {
    const rl = new ConnRateLimiter(2, 1000);
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("a", 10)).toBe(true);
    expect(rl.hit("a", 20)).toBe(false);
    // A new window opens at >= windowMs from the window start (0), resetting the count.
    expect(rl.hit("a", 1000)).toBe(true);
    expect(rl.hit("a", 1100)).toBe(true);
    expect(rl.hit("a", 1200)).toBe(false);
  });

  it("tracks keys independently", () => {
    const rl = new ConnRateLimiter(1, 1000);
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("a", 0)).toBe(false); // a is over
    expect(rl.hit("b", 0)).toBe(true); // b is unaffected
  });

  it("reports the live count and resets it after the window expires", () => {
    const rl = new ConnRateLimiter(5, 1000);
    rl.hit("a", 0);
    rl.hit("a", 100);
    expect(rl.count("a", 200)).toBe(2);
    expect(rl.count("a", 1001)).toBe(0); // window expired -> 0
    expect(rl.count("missing", 0)).toBe(0); // unknown key -> 0
  });

  it("sweep() drops only expired windows", () => {
    const rl = new ConnRateLimiter(10, 1000);
    rl.hit("old", 0);
    rl.hit("fresh", 900);
    rl.sweep(1000); // old (started at 0) is now expired; fresh (900) is not
    expect(rl.count("old", 1000)).toBe(0);
    expect(rl.count("fresh", 1000)).toBe(1);
  });

  it("the over-limit hit is still counted (flood stays pinned)", () => {
    const rl = new ConnRateLimiter(1, 1000);
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("a", 1)).toBe(false);
    expect(rl.count("a", 2)).toBe(2);
  });
});

describe("pickClientIp (XFF trust gate, review fix #15)", () => {
  it("ignores X-Forwarded-For when not trusting a proxy (anti-spoof default)", () => {
    expect(pickClientIp("1.2.3.4", "10.0.0.9", false)).toBe("10.0.0.9");
    expect(pickClientIp("evil, 1.2.3.4", "10.0.0.9", false)).toBe("10.0.0.9");
  });
  it("falls back to the socket address when there is no usable XFF", () => {
    expect(pickClientIp(undefined, "10.0.0.9", true)).toBe("10.0.0.9");
    expect(pickClientIp("", "10.0.0.9", true)).toBe("10.0.0.9");
    expect(pickClientIp(undefined, undefined, false)).toBe("unknown");
  });
  it("when trusting a proxy, takes the LAST hop (client-prepended value ignored)", () => {
    expect(pickClientIp("evil, 203.0.113.7", "10.0.0.9", true)).toBe("203.0.113.7");
    expect(pickClientIp(["a", "b, 203.0.113.7"], "10.0.0.9", true)).toBe("203.0.113.7");
  });
});
