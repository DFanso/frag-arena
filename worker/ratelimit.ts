// worker/ratelimit.ts — pure, transport-agnostic per-key connection rate limiter. No runtime deps.
//
// Guards the WebSocket-upgrade path against connection floods *before* a socket is admitted
// (the per-connection RATE_LIMIT_MSGS_PER_SEC guard in GameRoomCore only fires once a socket is
// already accepted). A single bad actor opening thousands of upgrades could otherwise fill the
// room cap or burn the free-tier request budget.
//
// Design: a sliding-window counter keyed by client IP, held in the Worker isolate's memory.
// Cloudflare reuses one isolate across many requests, so this throttles bursts from a hot IP
// without an extra DO/KV round-trip per upgrade (which would itself bill against the free tier —
// the same reason the tick loop uses setInterval, not storage alarms). It is best-effort, not a
// global guarantee: a request that lands on a cold isolate starts a fresh window. That is the
// right trade-off here — the goal is to blunt floods cheaply, with the Cloudflare WAF rate-rule
// (documented in wrangler.jsonc) as the authoritative edge backstop.
//
// Pure: time is injected (defaults to Date.now), so the window logic is deterministically
// unit-testable without timers.

export interface RateWindow {
  windowStart: number; // epoch ms the current window opened
  count: number; // hits seen in the current window
}

export class ConnRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  /**
   * @param limit  max hits permitted per key within windowMs
   * @param windowMs sliding-window length in ms
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record one hit for `key` and report whether it is allowed. Returns false once the key has
   * exceeded `limit` within the current window (the over-limit hit is still counted, so a
   * sustained flood stays blocked until the window rolls over). Rolls the window forward lazily
   * on the first hit after it expires.
   */
  hit(key: string, now: number = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.windowStart >= this.windowMs) {
      w = { windowStart: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  /** Current hit count for `key` in its live window (0 if unknown or expired). For tests/metrics. */
  count(key: string, now: number = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || now - w.windowStart >= this.windowMs) return 0;
    return w.count;
  }

  /**
   * Drop windows that expired before `now`, bounding memory under a churn of distinct IPs. Cheap
   * to call opportunistically (e.g. once per upgrade); the map stays ~O(active IPs).
   */
  sweep(now: number = Date.now()): void {
    for (const [key, w] of this.windows) {
      if (now - w.windowStart >= this.windowMs) this.windows.delete(key);
    }
  }
}

/**
 * Resolve the rate-limit key (client IP) from a Node upgrade request. X-Forwarded-For is
 * CLIENT-CONTROLLED, so it is honored ONLY when `trustProxy` is set — i.e. the operator has
 * confirmed an upstream reverse proxy fronts the app and the port is not directly reachable.
 * When trusted we take the LAST hop (the address the trusted proxy itself appended; a value the
 * client prepended sits to the left and is ignored). When untrusted we key on the unspoofable
 * socket address. This closes the flood-guard bypass where each forged XFF value opened its own
 * fresh window (review fix #15). The Cloudflare path uses CF-Connecting-IP, which is unspoofable.
 */
export function pickClientIp(
  xff: string | string[] | undefined,
  remoteAddr: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && xff !== undefined) {
    const joined = Array.isArray(xff) ? xff.join(",") : xff;
    const hops = joined.split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return remoteAddr || "unknown";
}
