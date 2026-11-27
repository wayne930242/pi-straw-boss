import { GRAPHS, type Graph } from "./duty.ts";
import { newestOf } from "./branchscan.ts";
import { type Todo, todosOf } from "./items.ts";
import { v1Of } from "./todoledger.ts";
import { planGraph } from "./boardplan.ts";

// A session's todo list in short, for its card on the map: its bridge reads it from the todo snapshots on its branch (bridge.ts) and the hub
// checks it (dialogs.ts) before it goes to the unit. A snapshot is pi-todo-ledger's `todo/v1` entry (its public contract, todoledger.ts), else rpiv-todo's records (docs/specs/2026-11-24-todo-ledger.md).

/** Done of total, and the task in progress as rpiv-todo words it while it runs; `steps` are the train's (docs/specs/2026-11-07-train-workers.md §11.1), the todos that carry a `metadata.sb`. */
export interface TodoSum { done: number; total: number; now?: string; steps?: StepLine[]; /** The graph of the plan the main runs (`planGraph`); the page shows it beside the main's kind (docs/specs/2026-11-09-agent-kinds.md §2). */ graph?: Graph; /** The id of the todo in progress, and the open todos' Herdr runs (`Todo.runs`): the todo an Ask blocks (docs/specs/2026-11-28-boss-asks.md). */ doing?: number; runs?: TodoRun[] }
export interface TodoRun { id: number; run: string }
export interface StepLine { id: number; kind: string; status: Todo["status"]; name?: string; round?: number; outcome?: "passed" | "failed" | "void" }
export const TODO_TEXT = 120, RUNS_MAX = 64;

type BranchEntry = { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } };
/** rpiv-todo's state entry, and the details of a `todo` tool result, when they hold a todo list. */
const stateOf = (entry: unknown): unknown => { const e = entry as BranchEntry; return e.type === "custom" && e.customType === "rpiv-todo-state" && todosOf(e.data) ? e.data : undefined; };
const resultOf = (entry: unknown): unknown => { const e = entry as BranchEntry; return e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo" && todosOf(e.message.details) ? e.message.details : undefined; };
/** A branch's todo list, oldest entry first: the newest valid `todo/v1` entry, which wins over rpiv-todo's records wherever they stand (the ledger's rule); else the snapshot rpiv-todo left last, its state entries winning over its tool results (rpiv-todo's own replay rule). Raw, with every task's metadata, for a reader that needs all of it (the train's guard); a snapshot is the whole list, never merged by id. */
export function snapshotOfBranch(entries: readonly unknown[]): unknown {
	let fromEntries: unknown, fromResults: unknown;
	for (let i = entries.length - 1; i >= 0; i--) { // from the leaf: the newest v1 entry wins, so the walk stops there
		const v1 = v1Of(entries[i]);
		if (v1 !== undefined) return v1;
		[fromEntries, fromResults] = [fromEntries ?? stateOf(entries[i]), fromResults ?? resultOf(entries[i])];
	}
	return fromEntries ?? fromResults;
}
/** `snapshotOfBranch` for a reader that asks again as its branch grows (the work board's refresh at every tool call): each call walks only what was appended since the last (branchscan.ts). */
export function snapshotScan(): (entries: readonly unknown[]) => unknown {
	const v1 = newestOf(v1Of), state = newestOf(stateOf), result = newestOf(resultOf);
	return (entries) => v1(entries) ?? state(entries) ?? result(entries);
}
/** The todo list from a branch's entries, oldest first. */
export const todosOfBranch = (entries: readonly unknown[]): Todo[] | undefined => todosOf(snapshotOfBranch(entries));
export { planGraph }; // boardplan.ts owns it: the board's plan and the page share it
/** The todo list in short from a branch's entries. */
export function todoOfBranch(entries: readonly unknown[]): TodoSum | undefined {
	const list = todosOfBranch(entries), doing = list?.find((t) => t.status === "in_progress");
	if (!list?.length) return undefined;
	const now = doing && (doing.activeForm || doing.subject).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, TODO_TEXT);
	const steps = list.flatMap((t): StepLine[] => (t.sb ? [{ id: t.id, kind: t.sb.kind, status: t.status, ...(t.sb.name && { name: t.sb.name }), ...(t.sb.round !== undefined && { round: t.sb.round }), ...(t.sb.outcome && { outcome: t.sb.outcome }) }] : []));
	const graph = planGraph(list), runs = list.filter((t) => t.status !== "completed").flatMap((t) => (t.runs ?? []).map((run) => ({ id: t.id, run }))).slice(0, RUNS_MAX);
	return { done: list.filter((t) => t.status === "completed").length, total: list.length, ...(now && { now }), ...(doing && { doing: doing.id }), ...(steps.length && { steps }), ...(graph && { graph }), ...(runs.length && { runs }) };
}

/** What the hub accepts from a bridge. */
export const todoOk = (v: unknown): v is TodoSum => {
	const t = v as Partial<TodoSum> | null;
	const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 200;
	const plain = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\p{Cc}\p{Cf}]/u.test(s);
	const step = (r: unknown) => {
		const x = r as Partial<StepLine> | null;
		return x !== null && typeof x === "object" && Object.keys(x).every((k) => ["id", "kind", "status", "name", "round", "outcome"].includes(k)) && Number.isSafeInteger(x.id) && x.id! >= 1 && plain(x.kind, 32) && ["pending", "in_progress", "completed"].includes(x.status as string)
			&& (x.name === undefined || plain(x.name, 64)) && (x.round === undefined || (Number.isSafeInteger(x.round) && x.round >= 1)) && (x.outcome === undefined || ["passed", "failed", "void"].includes(x.outcome));
	};
	return t !== null && typeof t === "object" && count(t.done) && count(t.total) && t.done! <= t.total! && t.total! > 0 && (t.now === undefined || plain(t.now, TODO_TEXT)) && (t.steps === undefined || (Array.isArray(t.steps) && t.steps.length <= 200 && t.steps.every(step))) && (t.graph === undefined || (GRAPHS as readonly string[]).includes(t.graph))
		&& (t.doing === undefined || (Number.isSafeInteger(t.doing) && t.doing >= 0)) && (t.runs === undefined || (Array.isArray(t.runs) && t.runs.length <= RUNS_MAX && t.runs.every((r) => Number.isSafeInteger(r?.id) && plain(r.run, 64))));
};
