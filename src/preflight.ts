import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { itemKey } from "./peertargets.ts";
import { snapshotScan } from "./todo.ts";

// The todo preflight (docs/specs/2026-11-28-todo-preflight.md; boss 2026-11-28 「todo 驗收檢查」): a static look at the todo a launch works on, at the moment sb dispatches for it (`subagent` with
// `item`, `boss_pair` with `item`). It reads the raw `todo/v1` snapshot of the launcher's branch (the whole ledger, tombstones included, not the board's 200 rows) through an incremental scan.
// sb gates no dispatch on bookkeeping (0.83.0 removed the plan gate), so a missing or vague anchor and a deleted or unknown blocker only warn, on the tool's result; a cycle in what the todo
// waits on refuses, because that todo can never become ready and a worker on it starts work out of order.

export interface Preflight { refusal?: string; warnings: string[] }
type Raw = { id?: unknown; uid?: unknown; status?: unknown; anchor?: unknown; blockedBy?: unknown };

/** Words that open a command line: an anchor that starts with one is runnable as written. */
const COMMANDS = /^(?:npm|npx|pnpm|yarn|bun|bunx|node|deno|tsc|vitest|jest|go|cargo|make|just|uv|uvx|pytest|python3?|pip|dotnet|mvn|gradle|git|gh|glab|curl|bash|sh|zsh|rg|grep|ls|test|diff|jq|docker|kubectl|helm|terraform|ansible(?:-playbook)?|herdr|pi|sb|mpi|playwright|agent-browser|swift|xcodebuild|ruby|bundle|rake|php|composer|mix|elixir|ttt)\b/i;
/** Marks of a concrete check: code or a path, a flag, a file name, a number, an address, a quote, a comparison. */
const CONCRETE = /[`$/\\=<>≥≤]|(?:^|\s)--?[A-Za-z]|\w\.[A-Za-z]{1,6}\b|\d|https?:|["'“”‘’「」『』]|::|#\w/;
/** Whole anchors that name no check: what "done" means, said again. */
const VAGUE = new Set(["done", "complete", "completed", "finished", "fixed", "works", "it works", "working", "works fine", "works as expected", "as expected", "tests pass", "test passes", "tests passed", "tests green", "all tests pass",
	"all green", "green", "pass", "passes", "passed", "ok", "okay", "lgtm", "looks good", "good", "verified", "verify", "check", "checked", "check it", "tested", "test", "tests", "ci", "ci green", "ci passes", "build passes", "no errors",
	"tbd", "todo", "n/a", "na", "none", "-", "?", "make it work", "make it pass", "make tests pass", "完成", "做完", "測試通過", "通過", "沒問題", "正常", "可以用", "驗證", "已驗證", "測試", "綠燈", "全綠"]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** What is wrong with an anchor: none at all, or words that name no runnable check (no command, and no concrete observable such as a path, a number, or a sentence that says what is seen). */
export function anchorProblem(anchor: unknown): "missing" | "vague" | undefined {
	const a = typeof anchor === "string" ? anchor.trim() : "";
	if (!a) return "missing";
	const plain = a.toLowerCase().replace(/[.!。！]+$/u, "").replace(/\s+/g, " ").trim();
	if (VAGUE.has(plain)) return "vague"; // before the command words: `test passes` starts with one (review F009)
	if (COMMANDS.test(a) || CONCRETE.test(a)) return undefined;
	// A sentence that says what is seen: four words or more, or six CJK characters.
	const words = plain.replace(CJK, " ").split(" ").filter(Boolean).length, cjk = plain.match(CJK)?.length ?? 0;
	return words + cjk / 1.5 >= 4 ? undefined : "vague";
}

const quote = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 79)}…` : s);
const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x)) : []);

/** The first cycle reachable from `start` through `edges`, as the ids along it (its first id again at the end), else undefined. Iterative, so a 5000-long chain does not overflow the stack; each node's edges are asked once. */
function cycleFrom(start: number, edges: (id: number) => readonly number[]): number[] | undefined {
	const state = new Map<number, 1 | 2>(), path: number[] = [start], stack: { id: number; out: readonly number[]; next: number }[] = [{ id: start, out: edges(start), next: 0 }];
	state.set(start, 1);
	while (stack.length) {
		const top = stack[stack.length - 1]!;
		if (top.next >= top.out.length) { state.set(top.id, 2), stack.pop(), path.pop(); continue; }
		const to = top.out[top.next++]!, seen = state.get(to);
		if (seen === 1) return [...path.slice(path.indexOf(to)), to];
		if (seen === undefined) state.set(to, 1), path.push(to), stack.push({ id: to, out: edges(to), next: 0 });
	}
	return undefined;
}

/** A snapshot's rows by id and uid, and each row's open blockers once asked: built once per snapshot (the scan hands the same object until the list changes). */
interface Index { byId: Map<number, Raw>; byUid: Map<string, Raw>; open: Map<number, readonly number[]> }
const indexes = new WeakMap<object, Index>();
function indexOf(snapshot: object, tasks: readonly Raw[]): Index {
	let x = indexes.get(snapshot);
	if (x) return x;
	x = { byId: new Map(), byUid: new Map(), open: new Map() };
	for (const t of tasks) {
		if (!Number.isSafeInteger(t?.id)) continue;
		x.byId.set(t.id as number, t);
		if (typeof t.uid === "string") x.byUid.set(t.uid, t);
	}
	indexes.set(snapshot, x);
	return x;
}
/** The blockers that still hold a todo back, as capacity counts readiness (capacity.ts `capOfTodos`): known, neither done nor deleted. A done blocker frees it, whatever waits behind that one (review F005). */
const openBlockers = (x: Index, id: number): readonly number[] => {
	let out = x.open.get(id);
	if (!out) x.open.set(id, (out = idsOf(x.byId.get(id)?.blockedBy).filter((b) => { const s = x.byId.get(b)?.status; return s !== undefined && s !== "completed" && s !== "deleted"; })));
	return out;
};

/**
 * The preflight of `item` (a todo uid, or `<session8>#<id>`) against the launcher's todo snapshot; `session` is the launcher's session id. Undefined when there is nothing to judge: no item
 * key, or a `<session8>#<id>` of another session (its own main checks it). An rpiv-todo list has no anchors, so only its graph is judged; no list at all binds nothing, and says so.
 */
export function preflightOf(snapshot: unknown, item: string, session: string): Preflight | undefined {
	const key = itemKey(item), tasks = (snapshot as { tasks?: unknown } | null | undefined)?.tasks;
	if (!key) return undefined;
	if ("session" in key && !(key.session.length === 8 ? session.slice(0, 8).toLowerCase() === key.session.toLowerCase() : session === key.session)) return undefined;
	const x = Array.isArray(tasks) ? indexOf(snapshot as object, tasks as Raw[]) : undefined, task = x && ("uid" in key ? x.byUid.get(key.uid) : x.byId.get(key.id));
	if (!x || !task) return { warnings: [`sb preflight: item ${item} names no todo in your list, so this launch is bound to no todo.`] };
	const id = task.id as number;
	if (task.status === "deleted") return { warnings: [`sb preflight: todo #${id} is deleted, so this launch is bound to no open todo: restore the work as a new todo, or launch without item.`] };
	const cycle = cycleFrom(id, (n) => openBlockers(x, n));
	if (cycle) return { refusal: `sb preflight: todo #${id} waits on a blockedBy cycle (${cycle.map((n) => `#${n}`).join(" → ")}), so it never becomes ready: break the cycle with todo update removeBlockedBy, then launch again.`, warnings: [] };
	const warnings: string[] = [];
	if ((snapshot as { v?: unknown }).v === 1) {
		const problem = anchorProblem(task.anchor);
		if (problem === "missing") warnings.push(`sb preflight: todo #${id} has no anchor. Set the check that shows it done with todo update anchor (a command, or what is seen), so the result can be judged against it.`);
		else if (problem === "vague") warnings.push(`sb preflight: todo #${id}'s anchor ${quote(String(task.anchor).trim())} names no runnable check. Replace it with todo update anchor: a command to run, or what is seen when it is done.`);
	}
	const blockers = idsOf(task.blockedBy), deleted = blockers.filter((b) => x.byId.get(b)?.status === "deleted"), unknown = blockers.filter((b) => !x.byId.has(b));
	if (deleted.length || unknown.length) {
		const named = [deleted.length && `deleted ${deleted.map((b) => `#${b}`).join(", ")}`, unknown.length && `unknown ${unknown.map((b) => `#${b}`).join(", ")}`].filter(Boolean).join(" and ");
		warnings.push(`sb preflight: todo #${id} waits on ${named}: that dependency is gone. Drop it with todo update removeBlockedBy, or name the todo that replaced it.`);
	}
	return { warnings };
}

type Ctx = { sessionManager: { getBranch(): readonly unknown[]; getSessionId(): string } };

/** The preflight a session runs at its launches: one incremental scan of its branch, and the warnings each call carries to its result. With `pi`, those warnings ride on the launches' results (`register`). */
export function createPreflight(pi?: Pick<ExtensionAPI, "on">) {
	const scan = snapshotScan(), pending = new Map<string, string>();
	/** The preflight of a launch's `item` on the session's branch, or undefined without one or when the branch cannot be read (a replaced session's context throws). */
	const check = (item: unknown, ctx: Ctx | undefined): Preflight | undefined => {
		if (typeof item !== "string" || !item || !ctx) return undefined;
		try { return preflightOf(scan(ctx.sessionManager.getBranch()), item, ctx.sessionManager.getSessionId()); } catch { return undefined; }
	};
	const api = {
		check,
		/** pi's `tool_call` of a launch: the refusal of a cycle; warnings wait for the call's result. */
		admit(toolCallId: string, _tool: string, input: unknown, ctx: Ctx | undefined): { block: true; reason: string } | undefined {
			const p = check((input as { item?: unknown } | null | undefined)?.item, ctx);
			if (p?.refusal) return { block: true, reason: p.refusal };
			if (p?.warnings.length) pending.set(toolCallId, p.warnings.join("\n"));
			return undefined;
		},
		/** The warnings ride on the launch's result, once; a call the turn ended without a result (another extension blocked it) leaves none behind. */
		register(pi: Pick<ExtensionAPI, "on">): void {
			pi.on("tool_result", (event) => {
				const text = pending.get(event.toolCallId);
				if (text === undefined) return undefined;
				pending.delete(event.toolCallId);
				return { content: [...event.content, { type: "text" as const, text }] };
			});
			pi.on("turn_end", () => void pending.clear());
		},
	};
	if (pi) api.register(pi);
	return api;
}
export type PreflightCheck = ReturnType<typeof createPreflight>;
