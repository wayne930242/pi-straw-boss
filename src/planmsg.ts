import { graphOf } from "./duty.ts";

// docs/specs/2026-11-09-agent-kinds.md §2a, "A plan in the same message": pi prepares every tool call of an assistant message before any runs, so a `todo` call beside a `subagent` call has not written its state yet.
// The dispatch gate therefore reads the newest assistant message on the branch, which pi appends at `message_end`, before tools run (pinned pi 1.3.0; tests/duty-planmsg.test.ts is the tripwire for a bump).

interface Block { type?: string; id?: string; name?: string; arguments?: unknown }
const decode = (v: unknown): unknown => { if (typeof v !== "string") return v; try { return JSON.parse(v) as unknown; } catch { return undefined; } }; // models send `tasks` and `metadata` as JSON strings too (rpiv-todo normalises them)
const names = (m: unknown) => graphOf((decode(m) as { graph?: unknown } | undefined)?.graph) !== undefined;

/** Whether a `todo` call before the call `toolCallId` in the newest assistant message names a known graph: `create` with `metadata`, `create` with `tasks[].metadata`, or `update` with `metadata`. A codemode call (`parentToolCallId`) is in no message: state alone judges it. */
export function plannedInMessage(branch: readonly unknown[], toolCallId: string | undefined, parentToolCallId?: string): boolean {
	if (parentToolCallId) return false;
	const last = [...branch].reverse().find((e) => (e as { type?: string; message?: { role?: string } }).type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant") as { message?: { content?: unknown } } | undefined;
	const content = Array.isArray(last?.message?.content) ? (last!.message!.content as Block[]) : [];
	for (const block of content) {
		if (block.type !== "toolCall") continue;
		if (block.id === toolCallId) return false; // reached this call: a todo after it does not count
		const a = (decode(block.arguments) ?? {}) as { metadata?: unknown; tasks?: unknown };
		const tasks = decode(a.tasks);
		if (block.name === "todo" && (names(a.metadata) || (Array.isArray(tasks) && tasks.some((t) => names((t as { metadata?: unknown } | null)?.metadata))))) return true;
	}
	return false;
}
