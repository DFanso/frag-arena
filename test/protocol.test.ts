import { describe, it, expect } from "vitest";
import {
  encode,
  decode,
  sanitizeRoom,
  sanitizeName,
  sanitizeChat,
  addCredits,
  canBuy,
  defaultOwnedWeapons,
  CHAT_MAX_LEN,
  CREDITS_CAP,
  STARTING_CREDITS,
  CREDITS_PER_HIT,
  CREDITS_PER_KILL,
  SERVER_TICK_HZ,
  WEAPONS,
  ROCKET_ID,
  ROCKET_CLIP,
  DEFAULT_WEAPON,
  GRENADE_START,
  GRENADE_MAX,
  type InMsg,
  type ShootMsg,
  type SnapMsg,
  type RocketMsg,
  type RocketFxMsg,
  type ChatMsg,
  type BuyMsg,
  type BoughtMsg,
} from "../worker/protocol";

describe("encode/decode round-trip", () => {
  it("round-trips an InMsg", () => {
    const msg: InMsg = {
      t: "in",
      seq: 1287,
      ts: 1717430000123,
      p: [1, 2, 3],
      r: [0.5, -0.25],
      v: [0, 0, -1],
    };
    const raw = encode(msg);
    expect(typeof raw).toBe("string");
    const back = decode<InMsg>(raw);
    expect(back).toEqual(msg);
  });

  it("round-trips a ShootMsg", () => {
    const msg: ShootMsg = {
      t: "shoot",
      seq: 42,
      ts: 1717430000150,
      o: [0, 1, 0],
      d: [0, 0, -1],
      w: 0,
      hit: 7,
      head: true,
    };
    const raw = encode(msg);
    const back = decode<ShootMsg>(raw);
    expect(back).toEqual(msg);
  });

  it("round-trips a SnapMsg", () => {
    const msg: SnapMsg = {
      t: "snap",
      tick: 48213,
      ts: 1717430000200,
      ack: { 7: 1290 },
      players: [
        {
          id: 7,
          name: "neo",
          p: [10, 1, -4],
          r: [0.1, 0.2],
          v: [0, 0, 0],
          hp: 74,
          st: 1,
          frags: 3,
          deaths: 1,
          credits: 1075, // issue #25: server-authoritative balance rides along in the snap
        },
      ],
    };
    const raw = encode(msg);
    const back = decode<SnapMsg>(raw);
    expect(back).toEqual(msg);
  });
});

describe("decode error handling", () => {
  it("returns null on invalid JSON", () => {
    expect(decode<InMsg>("not json {")).toBeNull();
  });
});

describe("sanitizeRoom", () => {
  it("defaults undefined/empty to 'public'", () => {
    expect(sanitizeRoom(undefined)).toBe("public");
    expect(sanitizeRoom("")).toBe("public");
  });
  it("lowercases and strips disallowed characters", () => {
    expect(sanitizeRoom("Hello World!")).toBe("helloworld");
    expect(sanitizeRoom("Room_42-x")).toBe("room_42-x");
  });
  it("falls back to 'public' when nothing survives stripping", () => {
    expect(sanitizeRoom("!!!@@@")).toBe("public");
  });
  it("caps length at 24 characters", () => {
    const long = "a".repeat(40);
    expect(sanitizeRoom(long)).toBe("a".repeat(24));
    expect(sanitizeRoom(long).length).toBe(24);
  });
});

describe("sanitizeName", () => {
  it("defaults undefined/empty to 'anon'", () => {
    expect(sanitizeName(undefined)).toBe("anon");
    expect(sanitizeName("")).toBe("anon");
    expect(sanitizeName("   ")).toBe("anon");
  });
  it("trims and strips non-ascii characters", () => {
    expect(sanitizeName("  héllo  ")).toBe("hllo");
    expect(sanitizeName("ab\u{1F600}cd")).toBe("abcd");
  });
  it("caps length at 16 characters", () => {
    const long = "x".repeat(30);
    expect(sanitizeName(long)).toBe("x".repeat(16));
    expect(sanitizeName(long).length).toBe(16);
  });
});

describe("sanitizeChat (issue #10)", () => {
  it("returns '' for undefined / empty / blank input", () => {
    expect(sanitizeChat(undefined)).toBe("");
    expect(sanitizeChat("")).toBe("");
    expect(sanitizeChat("   \t  ")).toBe("");
  });
  it("collapses internal whitespace runs and trims the ends", () => {
    expect(sanitizeChat("  hello    world  ")).toBe("hello world");
    expect(sanitizeChat("nice\tshot\n\nGG")).toBe("nice shot GG");
  });
  it("strips non-printable / non-ASCII characters", () => {
    expect(sanitizeChat("gg\u{1F600}wp")).toBe("gg wp"); // emoji → space → collapsed/trim
    expect(sanitizeChat("héllo")).toBe("h llo");
  });
  it("caps length at CHAT_MAX_LEN", () => {
    const long = "a".repeat(CHAT_MAX_LEN + 40);
    expect(sanitizeChat(long).length).toBe(CHAT_MAX_LEN);
  });
});

describe("ChatMsg round-trip (issue #10)", () => {
  it("round-trips a ChatMsg", () => {
    const msg: ChatMsg = { t: "chat", from: 3, name: "neo", body: "follow the white rabbit" };
    expect(decode<ChatMsg>(encode(msg))).toEqual(msg);
  });
});

describe("addCredits (issue #25)", () => {
  it("adds an award onto the current balance", () => {
    expect(addCredits(STARTING_CREDITS, CREDITS_PER_HIT)).toBe(STARTING_CREDITS + CREDITS_PER_HIT);
    expect(addCredits(STARTING_CREDITS, CREDITS_PER_KILL)).toBe(STARTING_CREDITS + CREDITS_PER_KILL);
  });
  it("clamps the result up at CREDITS_CAP", () => {
    expect(addCredits(CREDITS_CAP - 5, CREDITS_PER_KILL)).toBe(CREDITS_CAP);
    expect(addCredits(CREDITS_CAP, 1)).toBe(CREDITS_CAP);
  });
  it("floors a negative result at 0", () => {
    expect(addCredits(10, -50)).toBe(0);
    expect(addCredits(0, -1)).toBe(0);
  });
  it("respects an explicit cap argument", () => {
    expect(addCredits(90, 50, 100)).toBe(100);
    expect(addCredits(40, 30, 100)).toBe(70);
  });
});

describe("buy menu (issue #26)", () => {
  // The first buyable weapon in the catalog (the Sniper today) — pick it generically so the test
  // stays correct if costs / ids change.
  const buyable = WEAPONS.find((w) => w.buyable)!;

  it("the catalog has a free default weapon and at least one buyable gun", () => {
    expect(WEAPONS[DEFAULT_WEAPON]!.cost).toBe(0);
    expect(WEAPONS[DEFAULT_WEAPON]!.buyable).toBe(false); // the starter is owned, never bought
    expect(WEAPONS[ROCKET_ID]!.buyable).toBe(false);      // the rocket is a tower pickup, not buyable
    expect(buyable).toBeDefined();
    expect(buyable.cost).toBeGreaterThan(0);
  });

  it("defaultOwnedWeapons owns only DEFAULT_WEAPON", () => {
    const owned = defaultOwnedWeapons();
    expect(owned.length).toBe(WEAPONS.length);
    expect(owned[DEFAULT_WEAPON]).toBe(true);
    expect(owned.filter(Boolean).length).toBe(1);
    expect(owned[buyable.id]).toBe(false);
  });

  it("canBuy: accepts an affordable, unowned, buyable weapon", () => {
    expect(canBuy(buyable.id, buyable.cost, defaultOwnedWeapons())).toBe(true);
    expect(canBuy(buyable.id, buyable.cost + 1, defaultOwnedWeapons())).toBe(true);
  });

  it("canBuy: rejects when too poor", () => {
    expect(canBuy(buyable.id, buyable.cost - 1, defaultOwnedWeapons())).toBe(false);
  });

  it("canBuy: rejects an already-owned weapon", () => {
    const owned = defaultOwnedWeapons();
    owned[buyable.id] = true;
    expect(canBuy(buyable.id, CREDITS_CAP, owned)).toBe(false);
  });

  it("canBuy: rejects a non-buyable weapon (rifle, rocket) and out-of-range ids", () => {
    const rich = defaultOwnedWeapons().map(() => false); // own nothing, infinite budget below
    expect(canBuy(DEFAULT_WEAPON, CREDITS_CAP, rich)).toBe(false); // free starter isn't "bought"
    expect(canBuy(ROCKET_ID, CREDITS_CAP, rich)).toBe(false);      // tower pickup, not buyable
    expect(canBuy(-1, CREDITS_CAP, rich)).toBe(false);
    expect(canBuy(WEAPONS.length, CREDITS_CAP, rich)).toBe(false);
  });

  it("round-trips a BuyMsg and a BoughtMsg", () => {
    const buy: BuyMsg = { t: "buy", weaponId: buyable.id };
    expect(decode<BuyMsg>(encode(buy))).toEqual(buy);
    const bought: BoughtMsg = { t: "bought", weaponId: buyable.id, credits: 1234 };
    expect(decode<BoughtMsg>(encode(bought))).toEqual(bought);
  });
});

describe("constants", () => {
  it("exposes SERVER_TICK_HZ", () => {
    expect(SERVER_TICK_HZ).toBe(64);
  });

  it("defines a sane credits economy (issue #25)", () => {
    expect(CREDITS_PER_KILL).toBeGreaterThan(CREDITS_PER_HIT); // a kill is worth more than a hit
    expect(STARTING_CREDITS).toBeLessThanOrEqual(CREDITS_CAP);
  });

  it("defines the rocket launcher weapon and grenade-resource bounds", () => {
    expect(WEAPONS[ROCKET_ID]?.name).toBe("Rocket");
    expect(ROCKET_CLIP).toBeGreaterThan(0);
    expect(GRENADE_START).toBeLessThanOrEqual(GRENADE_MAX);
  });
});

describe("rocket message round-trips", () => {
  it("round-trips a client RocketMsg", () => {
    const msg: RocketMsg = {
      t: "rocket", seq: 5, ts: 1717430000333, o: [0, 1, 0], d: [0, 0, -1], p: [0, 1, -20], hit: 3, barrel: null,
    };
    expect(decode<RocketMsg>(encode(msg))).toEqual(msg);
  });

  it("round-trips a server RocketFxMsg", () => {
    const msg: RocketFxMsg = { t: "rocketfx", o: [0, 1, 0], d: [0, 0, -1], p: [0, 1, -20], travelMs: 333 };
    expect(decode<RocketFxMsg>(encode(msg))).toEqual(msg);
  });
});
