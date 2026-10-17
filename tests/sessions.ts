// Builders for pi session files in the key order pi writes them: messages and most entries start with type, id, parentId; custom entries end with them.

export const header = (id = "sess-1", cwd = "/work/demo") => ({ type: "session", version: 3, id, timestamp: "2026-10-17T08:00:00.000Z", cwd });
export const message = (id: string, parentId: string | null, message: Record<string, unknown>) => ({ type: "message", id, parentId, timestamp: "2026-10-17T08:00:01.000Z", message });
export const user = (id: string, parentId: string | null, text: string) => message(id, parentId, { role: "user", content: [{ type: "text", text }], timestamp: 1 });
export const assistant = (id: string, parentId: string | null, content: unknown[], extra: Record<string, unknown> = {}) =>
	message(id, parentId, { role: "assistant", content, model: "m-1", usage: { totalTokens: 1234 }, stopReason: "stop", timestamp: 1, ...extra });
export const result = (id: string, parentId: string | null, toolCallId: string, text: string, isError = false) =>
	message(id, parentId, { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 1 });
export const custom = (id: string, parentId: string | null, customType: string, content: string, display: boolean, details?: unknown) =>
	({ type: "custom_message", customType, content, display, details, id, parentId, timestamp: "2026-10-17T08:00:02.000Z" });
export const compaction = (id: string, parentId: string | null, summary: string) => ({ type: "compaction", id, parentId, timestamp: "2026-10-17T08:00:03.000Z", summary, firstKeptEntryId: parentId, tokensBefore: 90_000 });
export const text = (value: string) => ({ type: "text", text: value });
export const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
export const lines = (entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");
