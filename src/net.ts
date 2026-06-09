// src/net.ts — WebSocket transport: connect, reconnect/backoff, send, dispatch.
import {
  encode,
  decode,
  type ClientMsg,
  type ServerMsg,
} from "../worker/protocol";
import { buildWsUrl, backoff, type LocationLike } from "./net-helpers";

type Handler = (payload: any) => void;

export class Net {
  private url = "";
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private room: string;
  private name: string;
  private bots: number;
  private loc: LocationLike;

  // The nickname is baked into the URL query (contract D5 — no JoinMsg). A session token from
  // the welcome is persisted per-room and sent on reconnect so the server can restore identity.
  constructor(
    room: string,
    name: string,
    bots = 0,
    loc: LocationLike = window.location,
  ) {
    this.room = room;
    this.name = name;
    this.bots = bots;
    this.loc = loc;
    this.open();
  }

  private tokenKey(): string { return `cf-fps-token-${this.room}`; }
  private readToken(): string {
    try { return sessionStorage.getItem(this.tokenKey()) ?? ""; } catch { return ""; }
  }
  private saveToken(tok: string): void {
    try { sessionStorage.setItem(this.tokenKey(), tok); } catch { /* storage unavailable */ }
  }
  // Rebuild the WS URL fresh on every connect so a reconnect carries the latest token.
  private buildUrl(): string {
    let url = buildWsUrl(this.loc, this.room, this.name);
    if (this.bots > 0) url += `&bots=${this.bots}`; // room creator requests AI bots (#31)
    const tok = this.readToken();
    if (tok) url += `&token=${encodeURIComponent(tok)}`;
    return url;
  }

  // Register a handler for a server message "t", or the synthetic "open"/"close".
  on(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  // JSON-encode and send a client message (no-op while disconnected).
  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  // Permanently close: stop reconnecting and shut the socket.
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private emit(type: string, payload: any): void {
    const list = this.handlers.get(type);
    if (list) for (const h of list) h(payload);
  }

  private open(): void {
    this.url = this.buildUrl();
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      this.attempt = 0;
      this.emit("open", undefined);
    });

    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const msg = decode<ServerMsg>(raw);
      if (msg && typeof (msg as { t?: unknown }).t === "string") {
        const m = msg as { t: string; token?: string };
        // Persist the session token from the welcome so reconnects restore identity.
        if (m.t === "welcome" && typeof m.token === "string") this.saveToken(m.token);
        this.emit(m.t, msg);
      }
    });

    this.ws.addEventListener("close", () => {
      this.emit("close", undefined);
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // Let the subsequent "close" event drive reconnection.
      if (this.ws) this.ws.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = backoff(this.attempt);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.open();
    }, delay);
  }
}
