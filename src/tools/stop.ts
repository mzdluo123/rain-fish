import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const STOP_TOOL = "stop";

/**
 * Ends the run: nothing more happens until the next wake-up. When it is in the same assistant message as other tool calls, the
 * `afterToolCall` hook in `agent.ts` lets the whole batch end together (the loop only stops if every result asks for it).
 */
export function createStopTool() {
  return defineTool({
    name: STOP_TOOL,
    label: "Stop",
    description: "End this run. Call it when you have said and done everything you want to (it can be in the same step as your last `send`). You are not called again until the next wake-up. If you want to stay silent, just call it.",
    promptSnippet: "End the run until the next wake-up",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => ({ content: [{ type: "text", text: "Stopped. You will be woken up again later." }], details: {}, terminate: true }),
  });
}
