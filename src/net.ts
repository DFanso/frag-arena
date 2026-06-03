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
  private url: string;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  // The nickname is baked into the URL query (contract D5 — no JoinMsg).
  constructor(
    room: string,
    name: string,
    loc: LocationLike = window.location,
  ) {
    this.url = buildWsUrl(loc, room, name);
    this.open();
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
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      this.attempt = 0;
      this.emit("open", undefined);
    });

    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const msg = decode<ServerMsg>(raw);
      if (msg && typeof (msg as { t?: unknown }).t === "string") {
        this.emit((msg as { t: string }).t, msg);
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
