# Show conversation compaction in Chat

When the context window fills up, the agent pauses to summarise older history. Chat used to drop those events, so the pause looked like a stalled "Thinking…" and the earlier messages still looked fully present to the agent afterwards.

## Behaviour

- While compaction runs, the activity line reads "Compacting conversation…" with the Thinking shimmer.
- When it succeeds, a "Conversation compacted" divider appears after the last visible message. Messages above it are only a summary to the agent now.
- A compaction partway through a turn splits the reply around the divider.
- The divider is stored as `compacted: true` on that message, so it persists with the chat.
- A failed compaction ends the status without leaving a divider.

## Wire formats

Claude Code (checked against 2.1.310 with `/compact`), in this order:

1. `{"type":"system","subtype":"status","status":"compacting"}`
2. `{"type":"system","subtype":"status","status":null,"compact_result":"success"|"failed"}`. `status` is also sent with other values, such as `"requesting"`, and with `null` for permission-mode changes. These only end a compacting state.
3. A repeated `system/init` for the same session.
4. `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual"|"auto","pre_tokens":N,…}}`
5. Two `user` lines with string content: the synthetic summary and the command output. Chat already ignores these.

Codex app-server: `item/started` and `item/completed` with an item of `{ "type": "contextCompaction", "id" }`. Both methods are already forwarded by `codex.rs`.

`parseClaudeLine` and `createCodexParser` map both to `{ type: "compacting", active }` and `{ type: "compacted" }`. These go through the shared `reduceClaudeMessages` / `getClaudeActivity` path.

## Known limitation

Codex shows a whole turn as one message. If Codex compacts partway through a turn, the divider lands after the whole turn rather than at the exact point. Compaction at the start of a turn lands correctly, after the user's message.
