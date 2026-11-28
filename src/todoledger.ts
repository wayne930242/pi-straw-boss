// pi-todo-ledger's public contract, version 1 (its CONTRACT.md and schema/todo-v1.schema.json; docs/specs/2026-11-24-todo-ledger.md): the names and shapes sb reads and registers through, with no import of that package.
// A session's list is the newest valid `todo/v1` entry on its branch; the ledger asks registered guards before a change commits.
export const TODO_V1 = "todo/v1";
export const READY_EVENT = "todo:ready", CHANGED_EVENT = "todo:changed", GUARD_EVENT = "todo:guard";

/** One call that would change the list, as a guard's `check` receives it (`$defs/change`). */
export interface LedgerChange { op: "create" | "update" | "delete" | "clear"; params: Record<string, unknown>; before: unknown[]; after: unknown[]; sessionId: string; cwd: string; noop?: true }

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** Capacity-only deadlines by todo id, over the whole ledger (r2-F001). Date-only means midnight UTC; reject dates Date.parse would roll into the following month. */
export function todoDeadlines(snapshot: unknown): Map<number, number> {
	const dates = new Map<number, number>();
	if (isObject(snapshot) && Array.isArray(snapshot.tasks)) for (const t of snapshot.tasks) {
		const s = t?.metadata?.until, who = t?.metadata?.waitsOn;
		if (typeof who === "string" && who.trim()) { dates.set(t.id, 8.64e15); continue; } // No scheduled return: last representable instant.
		const at = untilOf(s);
		if (at !== undefined) dates.set(t.id, at);
	}
	return dates;
}
/** A `metadata.until` as an instant: a date, or a date and time with an uppercase T, hours 00 to 23, and an optional zone; a calendar day Date.parse would roll into the next month (2099-02-30) is none. */
export function untilOf(s: unknown): number | undefined {
	if (typeof s !== "string" || !/^\d{4}-\d\d-\d\d(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/.test(s)) return undefined;
	const at = Date.parse(s), day = s.slice(0, 10), midnight = Date.parse(day);
	return Number.isFinite(at) && Number.isFinite(midnight) && new Date(midnight).toISOString().startsWith(day) ? at : undefined;
}
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const id = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
const opt = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const str = (v: unknown) => typeof v === "string";
const evidence = (e: unknown) => isObject(e) && typeof e.command === "string" && e.command.length > 0 && opt(e.sha, str) && (e.result === "pass" || e.result === "fail") && typeof e.at === "string";
/** A task as `$defs/task` defines it; properties it does not name are allowed (later v1 releases may add optional ones). */
const task = (t: unknown) => isObject(t) && id(t.id) && typeof t.subject === "string" && STATUSES.has(t.status as string)
	&& opt(t.description, str) && opt(t.activeForm, str) && opt(t.owner, str) && opt(t.metadata, isObject)
	&& opt(t.blockedBy, (b) => Array.isArray(b) && b.every(id))
	&& opt(t.points, (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 10)
	&& opt(t.anchor, (a) => typeof a === "string" && a.length > 0)
	&& opt(t.evidence, (e) => Array.isArray(e) && e.every(evidence));
/** Whether `data` is a `todo/v1` snapshot (the schema's root): `v` 1, every task valid, and `nextId` an integer of at least 1. */
export const isSnapshotV1 = (data: unknown): boolean => isObject(data) && data.v === 1 && Array.isArray(data.tasks) && data.tasks.every(task) && id(data.nextId);
/** pi-todo-ledger's snapshot entry on a branch: its data when it matches the schema, else nothing (an invalid entry is skipped for an older one). */
export const v1Of = (entry: unknown): unknown => { const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | null; return e?.type === "custom" && e.customType === TODO_V1 && isSnapshotV1(e.data) ? e.data : undefined; };
