import { noopLogger } from "../logger.js";
import type { ApiResponse, Logger, OneBotClientOptions, OutboundSegment, PendingRequest, QQApi } from "../types.js";
import { toGroupMessage } from "./convert.js";
import { parseFrame } from "./frame.js";
import { sendGroupMsgDataSchema, sendGroupMsgRequestSchema } from "./schemas.js";

/**
 * OneBot v11 forward-WebSocket client. This is the only module that touches raw frames:
 * everything it hands out is validated and converted, everything it sends is validated first.
 * Reconnects with exponential backoff.
 */
export class OneBotClient implements QQApi {
  private ws: WebSocket | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private seq = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly requestTimeout: number;
  private readonly log: Logger;

  constructor(private readonly opts: OneBotClientOptions) {
    this.minBackoff = opts.minBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 10_000;
    this.backoff = this.minBackoff;
    this.log = (opts.logger ?? noopLogger).withTag("qq");
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.rejectAll(new Error("client stopped"));
  }

  async sendGroupMessage(groupId: string, message: OutboundSegment[]): Promise<{ messageId: string }> {
    const echo = `req-${++this.seq}`;
    const request = sendGroupMsgRequestSchema.parse({ action: "send_group_msg", params: { group_id: groupId, message }, echo });
    const res = await this.call(echo, request);
    if (res.status !== "ok" || res.retcode !== 0) {
      throw new Error(`send_group_msg failed (retcode ${res.retcode}): ${res.wording ?? res.message ?? res.status}`);
    }
    return { messageId: sendGroupMsgDataSchema.parse(res.data).message_id };
  }

  private call(echo: string, request: unknown): Promise<ApiResponse> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected to OneBot"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot request ${echo} timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify(request));
    });
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleFrame(data: unknown): void {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    const frame = parseFrame(raw);
    switch (frame.kind) {
      case "group_message": {
        const msg = toGroupMessage(frame.event);
        if (!msg) return;
        // Not awaited: a slow handler (an LLM call) must not stall the socket.
        (async () => this.opts.onGroupMessage(msg))().catch((err) => this.log.error(`handler error: ${errText(err)}`));
        return;
      }
      case "api_response": {
        const p = this.pending.get(frame.response.echo);
        if (!p) return;
        this.pending.delete(frame.response.echo);
        clearTimeout(p.timer);
        p.resolve(frame.response);
        return;
      }
      case "lifecycle":
        this.log.info(`lifecycle ${frame.subType} (self ${frame.selfId})`);
        return;
      case "invalid":
        this.log.warn(`dropped invalid frame: ${frame.reason}`);
        return;
      case "ignored":
        return;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const { url, token } = this.opts;
    const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = this.minBackoff;
      this.log.success(`connected to ${url}`);
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data);
    ws.onerror = () => {}; // always followed by onclose
    ws.onclose = () => {
      this.rejectAll(new Error("OneBot connection closed"));
      if (this.stopped) return;
      this.log.warn(`disconnected, retrying in ${this.backoff}ms`);
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    };
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
