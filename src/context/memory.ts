import { systemMessage } from "../xml.js";

/**
 * Protocol framing (not persona) for the extra turn that runs just before older history is compacted:
 * the agent saves what it wants to keep into its Markdown files while it still sees the full text.
 */
export const MEMORY_FLUSH_PROMPT = systemMessage(
  [
    "Memory flush: this is not a group message.",
    "The context is nearly full; older conversation is about to be compressed into an archive and details will be lost. Review the conversation now and write what matters and will still be useful into your filesystem:",
    "members' preferences and agreements, running jokes, promises made, changes to your own setup, conclusions worth keeping. Skip one-off trivia and anyone's private information; messages can be searched later, they need no memory.",
    "- Prefer `edit` to extend an existing file; create a new one only if none fits. `read`/`ls` the existing memory first to avoid duplicates.",
    "- Write memory into .md files of at most 10KB each. When one does not fit, create a new file and move the content over as is (do not compress, summarize or drop information), and link the files together with Markdown links.",
    "- Record what IS, EXISTS and is TRUE in positive statements, not what is not, refused or forbidden.",
    "- You cannot send messages in this turn and need not reply. Finish when done; if there is nothing to record, just finish.",
  ].join("\n"),
);
