import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CarView } from "../src/train/cars.ts";
import type { Contract } from "../src/train/contract.ts";
import { createTrainGuard, type GuardEnv } from "../src/trainguard.ts";
import { trainHandoff } from "../src/opener.ts";
import { CODE, runCheck, sb, slip, type Json } from "./train-fixtures.ts";

// A rig for the train guard (docs/specs/2026-11-07-train-workers.md §7): a fake pi with its event bus and handlers, a session branch the test fills, and a small rpiv-todo that applies what the guard let through the way
// rpiv-todo applies it (create, update with merged metadata, delete, clear) and writes its state entry. The guard, the files it writes, and git are real, all inside a folder of the test root.
// The todo list comes by one of two paths (docs/specs/2026-11-24-todo-ledger.md): rpiv-todo, whose call the guard checks at `tool_call`, or pi-todo-ledger, emulated here by its public contract (CONTRACT.md of pi-todo-ledger): it hears
// `todo:guard` registrations, asks `todo:ready` when it loads, runs each guard's `check` on the change before it commits (a valid update that changes nothing too, flagged `noop`), refuses with `Error: guard <id> refused: <reason>`, and writes
// a `todo/v1` entry and emits `todo:changed` for every change. SB_TEST_TODO_PATH=ledger (tests/train-guard-ledger.test.ts) runs a suite on the second.

export interface Entry { type: string; customType?: string; data?: unknown; message?: unknown; content?: string; timestamp?: string }
export interface Reply { ok: boolean; reason?: string }
type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
let scratch: string[] = [];
export const cleanup = () => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
export const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export const MANIFEST_HEADER = `train:\n  project: acme\n  app: web\n  code: ${CODE}\n  integrator: sess-integ-1\n`;
/** The handoff the tower sends a new train, as `trainHandoff` words it. */
export const handoffOf = (manifest: string) => trainHandoff("Base A", { id: "sess-integ-1", name: "integ acme" }, manifest, { id: "tower-1", name: "tower" }, { project: "acme", code: CODE });
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();

/** What a guard that starts again on the same session shares with the one before it. */
export interface Shared { root: string; stateDir: string; cwd: string; entries: Entry[]; list: { tasks: Json[]; nextId: number }; now(): number }
export type TodoPath = "rpiv" | "ledger";
/** The pi session id of the rig's session, as pi-todo-ledger names it in a change. */
export const SESSION_ID = "sess-pi-1";
export const LEDGER_GUARD = "sb-train";
export interface RigOptions { /** Which todo extension keeps the list: rpiv-todo (the guard checks its calls at tool_call) or pi-todo-ledger (the guard is its `todo:guard`); default SB_TEST_TODO_PATH, else rpiv. */ todo?: TodoPath; /** With the ledger: it loaded before sb (its `todo:ready` went unheard), so sb learns of it from its `todo:changed` at session_start, or not at all with `quiet`. */ ledgerFirst?: boolean; quiet?: boolean; /** The answer of the merge-train contract check (train/contract.ts); left out, nothing is checked. */ contract?: Contract | (() => Contract); /** The `integration.accept` of app `web` in the rig's `.straw-boss/apps.json` (none by default); `apps` is the file's own text, or `false` for no file. */ appAccept?: string[]; apps?: string | false; /** The sb server's answer about the cars (cars-read); the guard asks for it and reads no car file. Left out, the guard has no link to a server. */ cars?: { views: CarView[]; error?: string }; manifest?: string; main?: boolean; /** The main's kind; default integrator, as the guard behaved before kinds. */ duty?: string; train?: boolean; node?: string; cli?: string; stateName?: string; now?: number; /** A guard that starts again on the same session: the folders, the branch and the todo list of an earlier rig (a /reload). */ reuse?: Shared }

export type Rig = ReturnType<typeof build>;
export const rig = (o: RigOptions = {}): Rig => build(o);
function build(o: RigOptions) {
	const root = o.reuse?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "sb-tg-")));
	if (!o.reuse) scratch.push(root);
	const stateDir = o.reuse?.stateDir ?? join(root, o.stateName ?? "state"), cwd = o.reuse?.cwd ?? join(root, "work");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	if (!o.reuse && o.apps !== false) {
		mkdirSync(join(cwd, ".straw-boss"), { recursive: true });
		writeFileSync(join(cwd, ".straw-boss", "apps.json"), o.apps ?? JSON.stringify({ apps: [{ name: "web", dir: ".", integration: { base: "develop", stages: ["merge"], ...(o.appAccept ? { accept: o.appAccept } : {}) } }] }));
	}
	let clock = o.reuse?.now() ?? o.now ?? Date.parse("2026-11-07T08:00:00Z");
	const iso = () => new Date(clock).toISOString();
	const entries: Entry[] = o.reuse?.entries ?? [];
	if (o.manifest !== undefined && !o.reuse) entries.push({ type: "custom_message", customType: "straw-tower", content: handoffOf(o.manifest), timestamp: iso() });
	const handlers = new Map<string, Handler[]>(), bus = new Map<string, ((data: unknown) => void)[]>(), told: string[] = [];
	const pi = {
		on: (name: string, fn: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: {
			on: (channel: string, fn: (data: unknown) => void) => (bus.set(channel, [...(bus.get(channel) ?? []), fn]), () => bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== fn))),
			emit: (channel: string, data: unknown) => (bus.get(channel) ?? []).forEach((fn) => fn(data)),
		},
		appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data, timestamp: iso() }),
	};
	const train = o.train === false ? undefined : { project: "acme", code: CODE };
	const env: GuardEnv = {
		stateDir, train: () => train, isMain: () => o.main === true, duty: () => o.duty ?? "integrator", session: () => ({ id: "sess-train-1", pane: "wA:p2" }), now: () => clock,
		node: o.node ?? "/usr/local/bin/node", cli: o.cli ?? "/pkg/src/server/cli.ts", home: root, tell: (text) => void told.push(text),
		...(o.contract ? { contract: () => (typeof o.contract === "function" ? o.contract() : o.contract!) } : {}),
		...(o.cars ? { cars: { read: async () => { if (o.cars!.error) throw new Error(o.cars!.error); return structuredClone(o.cars!.views); } } } : {}),
	};
	const path: TodoPath = o.todo ?? (process.env.SB_TEST_TODO_PATH === "ledger" ? "ledger" : "rpiv");
	const list = o.reuse?.list ?? { tasks: [] as Json[], nextId: 1 };
	// ---- pi-todo-ledger, by its contract: the guards it heard, and every change it put to them
	const guards = new Map<string, (change: Json) => unknown>(), changes: Json[] = [];
	const listen = () => pi.events.on("todo:guard", (p) => {
		const g = p as Json | null;
		if (g && g.v === 1 && typeof g.id === "string" && g.id.trim() && typeof g.check === "function") guards.set(g.id, g.check as (change: Json) => unknown);
	});
	if (path === "ledger" && o.ledgerFirst) (listen(), pi.events.emit("todo:ready", { v: 1 })); // nobody listens yet
	const guard = createTrainGuard(pi as never, env);
	const ctx = { cwd, sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => SESSION_ID } };
	let calls = 0;
	const fire = async (name: string, event: Record<string, unknown>, at: unknown = ctx) => {
		let last: unknown;
		for (const fn of handlers.get(name) ?? []) last = (await fn({ type: name, ...event }, at)) ?? last;
		return last as { block?: boolean; reason?: string } | undefined;
	};
	for (const fn of handlers.get("session_start") ?? []) void fn({ type: "session_start" }, ctx);
	if (path === "ledger") {
		if (!o.ledgerFirst) (listen(), pi.events.emit("todo:ready", { v: 1 }));
		if (!o.quiet) pi.events.emit("todo:changed", { v: 1, sessionId: SESSION_ID, tasks: structuredClone(list.tasks) }); // its restore at session_start
	}

	// ---- the todo list, as rpiv-todo (or pi-todo-ledger) keeps it
	const snapshot = () => ({ action: "list", params: {}, tasks: structuredClone(list.tasks), nextId: list.nextId });
	/** The list as an entry of the path's own: rpiv-todo's state entry, or the ledger's `todo/v1` snapshot. */
	const persist = () => void entries.push(path === "ledger" ? { type: "custom", customType: "todo/v1", data: { v: 1, tasks: structuredClone(list.tasks), nextId: list.nextId }, timestamp: iso() } : { type: "custom", customType: "rpiv-todo-state", data: snapshot(), timestamp: iso() });
	function applyTo(target: { tasks: Json[]; nextId: number }, input: Json) {
		const merge = (task: Json, patch: Json) => {
			const meta = { ...((task.metadata as Json | undefined) ?? {}) };
			for (const [k, v] of Object.entries(patch)) (v === null ? delete meta[k] : (meta[k] = v));
			if (Object.keys(meta).length) task.metadata = meta;
			else delete task.metadata;
		};
		if (input.action === "create") {
			for (const item of (input.tasks as Json[] | undefined) ?? [input]) target.tasks.push({ id: target.nextId++, subject: item.subject, status: "pending", ...(item.metadata ? { metadata: structuredClone(item.metadata) } : {}) });
		} else if (input.action === "update") {
			const task = target.tasks.find((t) => t.id === input.id)!;
			if (typeof input.status === "string") task.status = input.status;
			if (input.metadata) merge(task, input.metadata as Json);
		} else if (input.action === "delete") target.tasks.find((t) => t.id === input.id)!.status = "deleted";
		else if (input.action === "clear") [target.tasks, target.nextId] = [[], 1];
	}
	function apply(input: Json) {
		applyTo(list, input);
		persist();
		if (path === "ledger") pi.events.emit("todo:changed", { v: 1, sessionId: SESSION_ID, tasks: structuredClone(list.tasks) });
	}
	/** The ledger's call: its guards see the change before it commits, a refusal leaves the list as it was and comes back as the tool's error text. */
	async function ledgerTodo(input: Json, id: string): Promise<Reply> {
		const result = (isError: boolean) => fire("tool_result", { toolName: "todo", toolCallId: id, input, content: [], isError, details: snapshot() });
		if (!["create", "update", "delete", "clear"].includes(input.action as string)) return (await result(false), { ok: true });
		const draft = structuredClone(list), before = structuredClone(list.tasks);
		applyTo(draft, input);
		const noop = input.action === "update" && JSON.stringify(draft.tasks) === JSON.stringify(before);
		const change: Json = { op: input.action, params: structuredClone(input), before, after: structuredClone(draft.tasks), sessionId: SESSION_ID, cwd, ...(noop ? { noop: true } : {}) };
		changes.push(change);
		for (const [gid, check] of guards) {
			let reason: unknown;
			try { reason = await check(structuredClone(change)); } catch (error) { reason = `guard threw: ${(error as Error).message}`; }
			if (typeof reason !== "string" || !reason) continue;
			await result(true);
			const text = `Error: guard ${gid} refused: ${reason}`, prefix = `Error: guard ${LEDGER_GUARD} refused: `;
			return { ok: false, reason: text.startsWith(prefix) ? text.slice(prefix.length) : text };
		}
		if (!noop) apply(input);
		await result(false);
		return { ok: true };
	}
	/** A `todo` call; `at` is the context pi hands the extensions with it. */
	async function todo(input: Json, at: unknown = ctx): Promise<Reply> {
		const id = `c${++calls}`;
		const blocked = await fire("tool_call", { toolName: "todo", toolCallId: id, input }, at);
		if (path === "ledger") {
			if (blocked?.block && !o.quiet) throw new Error(`the tool_call path judged a todo call beside pi-todo-ledger: ${blocked.reason}`);
			if (blocked?.block) return { ok: false, reason: blocked.reason };
			return ledgerTodo(input, id);
		}
		if (blocked?.block) return { ok: false, reason: blocked.reason };
		apply(input);
		await fire("tool_result", { toolName: "todo", toolCallId: id, input, content: [], isError: false, details: snapshot() });
		return { ok: true };
	}
	const create = (metadata: Json, subject = "step") => todo({ action: "create", subject, metadata: { sb: metadata } });
	const update = (id: number, status: string, metadata?: Json) => todo({ action: "update", id, status, ...(metadata ? { metadata } : {}) });
	const taskOf = (id: number) => list.tasks.find((t) => t.id === id)!;
	const sbOf = (id: number) => (taskOf(id).metadata as Json).sb as Json;
	/** Completes a step: its sb as it stands, plus the result. */
	const complete = (id: number, result: Json, patch: Json = {}) => update(id, "completed", { sb: { ...sbOf(id), ...patch, result } });

	// ---- monitors
	async function monitor(input: Json): Promise<Reply & { input: Json }> {
		const blocked = await fire("tool_call", { toolName: "MonitorCreate", toolCallId: `c${++calls}`, input });
		return { ok: !blocked?.block, reason: blocked?.reason, input };
	}
	const emit = (channel: string, data: unknown) => pi.events.emit(channel, data);
	let counter = 0;
	/** What pi-loop-monitor does after a created monitor: it starts it, the command prints lines, it finishes. */
	function started(input: Json, id = `m${++counter}`) {
		emit("monitor:started", { monitorId: id, command: input.command, description: input.description, timeout: input.timeout, timestamp: clock });
		return id;
	}
	const output = (id: string, line: string | Json) => emit("monitor:output", { monitorId: id, line: typeof line === "string" ? line : JSON.stringify(line), outputLines: 1, droppedLines: 0, timestamp: clock });
	const finished = (id: string, ev: Json = {}) => emit("monitor:finished", { monitorId: id, status: "completed", exitCode: 0, outputLines: 2, reportedOutcome: { status: "passed", message: "exit 0 in 1s" }, ...ev });
	/** The frozen file's hash, as the wrapper computes it from what it reads. */
	const frozen = (step: number) => join(stateDir, "trainboard", "acme", CODE, `step-${step}.json`);
	const hashOf = (step: number) => sha(readFileSync(frozen(step)));
	const lines = (step: number, kind: string, state: string, spec = hashOf(step), run = `nonce-${step}`) => ({ progress: { message: state }, sb: { v: 1, train: CODE, step, kind, state, spec, run } });
	/** A run of the wrapper that went as `state`: its lines, then the end the monitor reports. */
	function wrapperRun(input: Json, step: number, kind: string, state: "passed" | "failed" | "stopped" | "refused", over: { spec?: string; monitor?: Json; id?: string; run?: string } = {}) {
		const id = started(input, over.id);
		output(id, lines(step, kind, "running", over.spec, over.run));
		output(id, { monitorOutcome: { status: state, message: state }, ...lines(step, kind, state, over.spec, over.run) });
		finished(id, state === "passed" ? { ...over.monitor } : { status: "error", exitCode: state === "failed" ? 1 : state === "stopped" ? 143 : 3, reportedOutcome: { status: state, message: state }, ...over.monitor });
		return id;
	}

	/** A step in progress with a run monitor, started: the usual first half of a run step. */
	async function begin(metadata: Json, subject = "step") {
		const made = await create(metadata, subject);
		if (!made.ok) throw new Error(made.reason);
		const id = list.nextId - 1;
		const going = await update(id, "in_progress");
		if (!going.ok) throw new Error(going.reason);
		return id;
	}
	const describe = (id: number) => `train 1106m #${id} ${String(sbOf(id).kind)}`;
	async function runStep(id: number, state: "passed" | "failed" | "stopped" | "refused" = "passed") {
		const input: Json = { description: describe(id), command: String((((sbOf(id).spec as Json).check) as Json).run), timeout: 300_000 };
		const reply = await monitor(input);
		if (!reply.ok) throw new Error(reply.reason);
		wrapperRun(input, id, String(sbOf(id).kind), state);
		return input;
	}
	return {
		cars: o.cars, root, stateDir, cwd, entries, guard, told, ctx, handlers, list, fire, todo, create, update, complete, taskOf, sbOf, apply, snapshot, persist, path, guards, changes, monitor, emit, started, output, finished, wrapperRun, begin, runStep, describe, frozen, hashOf, lines,
		tick: (ms: number) => void (clock += ms), now: () => clock, iso, boardFile: join(stateDir, "trainboard", "acme", CODE, "board.json"), yardFile: join(stateDir, "trainboard", "acme", "yard.json"),
	};
}


/** A run step whose command runs in the rig's work folder. */
export const run = (r: Rig, over: Json = {}, spec: Json = {}) => sb(over, { check: runCheck({ cwd: r.cwd, run: "true", log: join(r.cwd, "unit.log") }), ...spec });
export const slipBlock = (over: Record<string, string | undefined> = {}) => slip(over);
export { writeFileSync };

/** A message of the integrator's branch as pi-intercom stores it: a tower's forward of a car slip, its header naming `from` as the slip's sender (`fwd-from`). */
export const forwardEntry = (from: string, slipText = slipBlock(), over: { sender?: string; id?: string; role?: string; kind?: string } = {}): Entry => ({
	type: "custom_message", customType: "intercom_message",
	details: { from: { id: over.sender ?? "tower-1" }, message: { id: "m1", content: { text: `[straw net from=tower id=${over.id ?? "tower-1"} role=${over.role ?? "tower"} workspace=Base kind=${over.kind ?? "tower_reply"} scope=session to=integ reply=none fwd=${"e".repeat(16)} fwd-from=${from}] ${slipText}` } } },
} as Entry);
