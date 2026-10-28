import { type Todo, todosOf } from "./items.ts";

// A session's todo list in short, for its card on the map: its bridge reads it from rpiv-todo's snapshots on its branch (bridge.ts) and the hub
// checks it (dialogs.ts) before it goes to the unit.

/** Done of total, and the task in progress as rpiv-todo words it while it runs. */
export interface TodoSum { done: number; total: number; now?: string }
export const TODO_TEXT = 120;

/** The todo list from a branch's entries, oldest first: rpiv-todo's state entries win over its tool results (rpiv-todo's own replay rule). */
export function todosOfBranch(entries: readonly unknown[]): Todo[] | undefined {
	let fromEntries: Todo[] | undefined, fromResults: Todo[] | undefined;
	for (let i = entries.length - 1; i >= 0 && !fromEntries; i--) { // from the leaf: the newest state entry wins, so the walk stops there
		const e = entries[i] as { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type === "custom" && e.customType === "rpiv-todo-state") fromEntries = todosOf(e.data);
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") fromResults ??= todosOf(e.message.details);
	}
	return fromEntries ?? fromResults;
}
/** The todo list in short from a branch's entries. */
export function todoOfBranch(entries: readonly unknown[]): TodoSum | undefined {
	const list = todosOfBranch(entries), doing = list?.find((t) => t.status === "in_progress");
	if (!list?.length) return undefined;
	const now = doing && (doing.activeForm || doing.subject).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, TODO_TEXT);
	return { done: list.filter((t) => t.status === "completed").length, total: list.length, ...(now && { now }) };
}

/** What the hub accepts from a bridge. */
export const todoOk = (v: unknown): v is TodoSum => {
	const t = v as Partial<TodoSum> | null;
	const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 200;
	return t !== null && typeof t === "object" && count(t.done) && count(t.total) && t.done! <= t.total! && t.total! > 0 && (t.now === undefined || (typeof t.now === "string" && t.now.length > 0 && t.now.length <= TODO_TEXT && !/[\p{Cc}\p{Cf}]/u.test(t.now)));
};
