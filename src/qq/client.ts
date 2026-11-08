import { noopLogger } from "../logger.js";
import type { ApiResponse, GroupHistoryPage, GroupMessage, EventLog, Logger, OneBotClientOptions, OutboundSegment, PendingRequest, QQApi, QQHistoryApi } from "../types.js";
import { noopEventLog } from "../trace/event-log.js";
import { toGroupMessage } from "./convert.js";
import { parseFrame } from "./frame.js";
import {
  getGroupListDataSchema,
  getGroupListRequestSchema,
  getGroupMsgHistoryDataSchema,
  getGroupMsgHistoryRequestSchema,
  historyMessageSchema,
  sendGroupMsgDataSchema,
  sendGroupMsgRequestSchema,
} from "./schemas.js";

/**
 * OneBot v11 forward-WebSocket client. This is the only module that touches raw frames:
 * everything it hands out is validated and converted, everything it sends is validated first.
 * Reconnects with exponential backoff.
 */
export class OneBotClient implements QQApi, QQHistoryApi {
  private ws: WebSocket | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private seq = 0;
  private selfId?: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly requestTimeout: number;
  private readonly log: Logger;
  private readonly events: EventLog;

  constructor(private readonly opts: OneBotClientOptions) {
    this.minBackoff = opts.minBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 10_000;
    this.backoff = this.minBackoff;
    this.log = (opts.logger ?? noopLogger).withTag("qq");
    this.events = opts.events ?? noopEventLog;
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

  /**
   * `get_group_msg_history`: up to `count` messages ending at `beforeSeq` (inclusive; undefined = the latest).
   * Items that fail validation are skipped, so one odd message does not lose the page.
   */
  async getGroupHistory(groupId: string, beforeSeq: string | undefined, count: number): Promise<GroupHistoryPage> {
    const echo = `req-${++this.seq}`;
    const request = getGroupMsgHistoryRequestSchema.parse({ action: "get_group_msg_history", params: { group_id: groupId, message_seq: beforeSeq, count }, echo });
    const res = await this.call(echo, request);
    if (res.status !== "ok" || res.retcode !== 0) {
      throw new Error(`get_group_msg_history failed (retcode ${res.retcode}): ${res.wording ?? res.message ?? res.status}`);
    }
    const messages: GroupMessage[] = [];
    let oldest: GroupHistoryPage["oldest"];
    let skipped = 0;
    for (const raw of getGroupMsgHistoryDataSchema.parse(res.data).messages) {
      const r = historyMessageSchema.safeParse(raw);
      if (!r.success) {
        skipped++;
        continue;
      }
      const e = r.data;
      if (e.message_seq !== undefined && (!oldest || Number(e.message_seq) < Number(oldest.seq))) {
        oldest = { seq: e.message_seq, ts: e.time };
      }
      const msg = toGroupMessage({ ...e, group_id: e.group_id ?? groupId, self_id: e.self_id ?? this.selfId ?? "" });
      if (msg) messages.push(msg);
    }
    if (skipped > 0) this.log.warn(`history of group ${groupId}: skipped ${skipped} invalid item(s)`);
    messages.sort((a, b) => a.ts - b.ts);
    return { messages, oldest };
  }

  async getGroupList(): Promise<string[]> {
    const echo = `req-${++this.seq}`;
    const res = await this.call(echo, getGroupListRequestSchema.parse({ action: "get_group_list", params: {}, echo }));
    if (res.status !== "ok" || res.retcode !== 0) {
      throw new Error(`get_group_list failed (retcode ${res.retcode}): ${res.wording ?? res.message ?? res.status}`);
    }
    return getGroupListDataSchema.parse(res.data).map((g) => g.group_id);
  }

  /** One API round trip, recorded in the event log (action, latency, outcome). */
  private async call(echo: string, request: unknown): Promise<ApiResponse> {
    const action = typeof request === "object" && request !== null && "action" in request ? request.action : undefined;
    const t0 = Date.now();
    try {
      const res = await this.transmit(echo, request);
      this.events.emit("qq.api", { action, ms: Date.now() - t0, ok: res.status === "ok" && res.retcode === 0, retcode: res.retcode });
      return res;
    } catch (err) {
      this.events.emit("qq.api", { action, ms: Date.now() - t0, ok: false, error: err });
      throw err;
    }
  }

  private transmit(echo: string, request: unknown): Promise<ApiResponse> {
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
        this.selfId = frame.event.self_id;
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
        this.events.emit("qq.lifecycle", { sub_type: frame.subType, self_id: frame.selfId });
        this.selfId = frame.selfId;
        this.opts.onSelfId?.(frame.selfId);
        return;
      case "invalid":
        this.log.warn(`dropped invalid frame: ${frame.reason}`);
        this.events.emit("qq.frame_invalid", { reason: frame.reason });
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
      this.events.emit("qq.connected", {});
      this.opts.onConnect?.();
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data);
    ws.onerror = () => {}; // always followed by onclose
    ws.onclose = () => {
      this.rejectAll(new Error("OneBot connection closed"));
      if (this.stopped) return;
      this.log.warn(`disconnected, retrying in ${this.backoff}ms`);
      this.events.emit("qq.disconnected", { retry_in_ms: this.backoff });
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    };
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
