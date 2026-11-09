import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { imageRef, type ImageStore } from "../image-store.js";
import { MAX_SEARCH_LIMIT, type MessageStore } from "../store.js";
import { escapeText } from "../xml.js";

export const SEARCH_TOOL = "search_messages";
const MAX_TEXT = 300;

function parseTime(label: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${label} date: ${value} (use e.g. 2026-11-01 or 2026-11-01T20:00:00+08:00)`);
  return Math.floor(ms / 1000);
}

/** Read-only full-text search over the stored chat history of the one group this agent serves. */
export function createSearchMessagesTool(store: MessageStore, groupId: string, images?: ImageStore) {
  return defineTool({
    name: SEARCH_TOOL,
    label: "Search messages",
    description:
      "Full-text search over this group's stored chat history (QQ). Returns the most relevant messages with time and sender.",
    promptSnippet: "Search group chat history by keywords",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords; all must appear in the message. Chinese, Japanese and English work." }),
      sender: Type.Optional(Type.String({ description: "Restrict to a sender's user id or nickname" })),
      since: Type.Optional(Type.String({ description: "Earliest time, ISO 8601 (e.g. 2026-11-01)" })),
      until: Type.Optional(Type.String({ description: "Latest time, ISO 8601" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Max results (default 10)" })),
      with_images: Type.Optional(Type.Boolean({ description: "Only messages that carried pictures (their ids are listed as [图片: i42]; use query 图片 to list them all)" })),
    }),
    execute: async (_toolCallId, p) => {
      const hits = store.search({
        query: p.query,
        groupId,
        sender: p.sender,
        since: parseTime("since", p.since),
        until: parseTime("until", p.until),
        limit: p.limit,
        withImages: p.with_images,
      });
      const text = hits.length
        ? hits
            .map((h) => {
              const when = new Date(h.ts * 1000).toLocaleString("sv-SE");
              const body = h.text.length > MAX_TEXT ? `${h.text.slice(0, MAX_TEXT)}…` : h.text;
              // nicknames and text are written by group members: escape them like in the group prompt
              const ids = images?.idsOf(groupId, h.messageId) ?? [];
              const pics = ids.length ? ` [图片: ${ids.map(imageRef).join(",")}]` : "";
              return `[${when}] ${escapeText(h.nickname)} (${h.userId}): ${escapeText(body)}${pics}`;
            })
            .join("\n")
        : "No matching messages.";
      return { content: [{ type: "text", text }], details: { count: hits.length } };
    },
  });
}
