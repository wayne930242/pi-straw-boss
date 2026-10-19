import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interceptUi } from "../src/intercept.ts";
import { selectDigest, UI_PREFIX } from "../src/owners.ts";
import { settle } from "./fakes.ts";

// The wrap of ctx.ui.select and ctx.ui.confirm (src/intercept.ts) over a fake pi: a bus that records, a ctx.ui whose dialogs the test settles
// (or that end when their signal aborts, as pi's do), and the tool-call events that say which call is in flight.

type Dlg = { kind: string; title: string; second: unknown; opts?: { signal?: AbortSignal }; settle(v: unknown): void };
const ANSWER = "a".repeat(16);

function rig({ hasUI = true, throwOn }: { hasUI?: boolean; throwOn?: string } = {}) {
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>(), listeners = new Map<string, ((d: unknown) => void)[]>(), seen: [string, Record<string, unknown>][] = [];
	const events = {
		on: (channel: string, h: (d: unknown) => void) => (listeners.set(channel, [...(listeners.get(channel) ?? []), h]), () => listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== h))),
		emit: (channel: string, data: unknown) => {
			seen.push([channel, data as Record<string, unknown>]);
			if (channel === throwOn) throw new Error("a listener failed");
			for (const h of [...(listeners.get(channel) ?? [])]) h(data);
		},
	};
	const pi = { events, on: (type: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(type, [...(handlers.get(type) ?? []), h]) } as unknown as ExtensionAPI;
	const dialogs: Dlg[] = [];
	const ask = (kind: string) => (title: string, second: unknown, opts?: { signal?: AbortSignal }) => new Promise((resolve) => {
		const d: Dlg = { kind, title, second, opts, settle: resolve };
		dialogs.push(d);
		const abort = () => resolve(kind === "confirm" ? false : undefined);
		opts?.signal?.aborted ? abort() : opts?.signal?.addEventListener("abort", abort, { once: true });
	});
	const make = () => ({ select: ask("select"), confirm: ask("confirm"), input: async () => "typed", editor: async () => "edited", custom: async () => "custom", notify() {} });
	let ui: ReturnType<typeof make> = make();
	const ctx = { get hasUI() { return hasUI; }, get ui() { return ui; } };
	const fire = async (type: string, event: Record<string, unknown> = {}) => { for (const h of handlers.get(type) ?? []) await h({ type, ...event }, ctx); };
	const on = (channel: string, h: (d: unknown) => void) => events.on(channel, h);
	interceptUi(pi);
	return {
		events, pi, dialogs, seen, fire, on, get ui() { return ui; }, original: ui,
		/** pi replaces its ui object (setUIContext), as on a mode change. */
		swap() { return (ui = make()); },
		start: (id = "c1", name = "bash") => fire("tool_execution_start", { toolCallId: id, toolName: name }),
		end: (id = "c1") => fire("tool_execution_end", { toolCallId: id }),
		sent: (suffix: string) => seen.filter(([c]) => c === `${UI_PREFIX}:${suffix}`).map(([, d]) => d),
		/** The GUI's answer, as the bridge emits it, and the owner's verdict. */
		answer(id: string, digest: string, selections: unknown, answerId = ANSWER) {
			const before = this.sent("answer-result").length;
			events.emit(`${UI_PREFIX}:answer`, { version: 1, id, answerId, digest, selections });
			return this.sent("answer-result").slice(before);
		},
	};
}
type Rig = ReturnType<typeof rig>;
const pending = (r: Rig) => r.sent("pending")[0] as { id: string; toolCallId: string; digest: string; select: { title: string; choices: { label: string }[]; confirm?: true } };
const confirm = (r: Rig, title = "mp-infra command review", message = "Reason\n\nssh box ls", opts?: { signal?: AbortSignal }) => (r.ui.confirm as (...a: unknown[]) => Promise<unknown>)(title, message, opts);
const select = (r: Rig, title = "Pick one", options = ["a", "b", "c"], opts?: { signal?: AbortSignal }) => (r.ui.select as (...a: unknown[]) => Promise<unknown>)(title, options, opts);

test("a confirm inside the one tool call in flight is relayed as Yes and No bound to that call; the terminal dialog opens as always", async () => {
	const r = rig();
	await r.start("c1", "bash");
	const asked = confirm(r);
	assert.equal(r.dialogs.length, 1, "pi's own dialog opened, once");
	assert.deepEqual([r.dialogs[0]!.kind, r.dialogs[0]!.title, r.dialogs[0]!.second], ["confirm", "mp-infra command review", "Reason\n\nssh box ls"], "with the caller's own arguments");
	const p = pending(r);
	assert.equal(p.toolCallId, "c1");
	assert.deepEqual(p.select, { title: "mp-infra command review\n\nReason\n\nssh box ls", choices: [{ label: "Yes" }, { label: "No" }], confirm: true });
	assert.equal(p.digest, selectDigest(p.select), "the digest the hub recomputes");
	r.dialogs[0]!.settle(true);
	assert.equal(await asked, true);
	assert.deepEqual(r.sent("closed"), [{ version: 1, id: p.id, by: "local" }]);
});

test("the GUI answers a confirm Allow or Deny: the terminal dialog goes through its signal and the call resolves with that answer, once", async () => {
	const r = rig();
	await r.start();
	for (const [choice, expected] of [[0, true], [1, false]] as const) {
		const asked = confirm(r), p = r.sent("pending").at(-1) as ReturnType<typeof pending>, dialog = r.dialogs.at(-1)!;
		assert.deepEqual(r.answer(p.id, p.digest, [choice], `${choice}`.repeat(16)), [{ version: 1, id: p.id, answerId: `${choice}`.repeat(16), accepted: true }]);
		assert.equal(dialog.opts?.signal?.aborted, true, "the terminal dialog was dismissed");
		assert.equal(await asked, expected);
		assert.deepEqual(r.sent("closed").at(-1), { version: 1, id: p.id, by: "remote", answerId: `${choice}`.repeat(16) });
		assert.deepEqual(r.answer(p.id, p.digest, [choice], "b".repeat(16)).map((x) => [x.accepted, x.reason]), [[false, "closed"]], "a second answer finds it closed");
	}
});

test("a select is relayed with its options and answered by index; the terminal answering first closes the relayed dialog", async () => {
	const r = rig();
	await r.start();
	const asked = select(r, "Which file?", ["a.ts", "b.ts", "c.ts"]), p = pending(r);
	assert.deepEqual(p.select, { title: "Which file?", choices: [{ label: "a.ts" }, { label: "b.ts" }, { label: "c.ts" }] });
	assert.equal(r.answer(p.id, p.digest, [2])[0]!.accepted, true);
	assert.equal(await asked, "c.ts");
	const second = select(r, "Again", ["x", "y"]), q = r.sent("pending")[1] as ReturnType<typeof pending>;
	r.dialogs[1]!.settle("y");
	assert.equal(await second, "y", "the terminal's answer is passed through untouched");
	assert.deepEqual(r.sent("closed").at(-1), { version: 1, id: q.id, by: "local" });
	assert.deepEqual(r.answer(q.id, q.digest, [0]).map((x) => x.reason), ["closed"], "the page's late answer is refused");
	const escaped = select(r, "Third", ["x"]);
	r.dialogs[2]!.settle(undefined);
	assert.equal(await escaped, undefined);
	assert.equal((r.sent("closed").at(-1) as { by: string }).by, "cancel", "Escape in the terminal");
});

test("an answer is checked: wrong digest, out of range, malformed, or without a usable answerId is refused and the dialog stays open", async () => {
	const r = rig();
	await r.start();
	const asked = select(r), p = pending(r);
	assert.equal(r.answer(p.id, "f".repeat(64), [0])[0]!.reason, "digest");
	assert.equal(r.answer(p.id, p.digest, [3])[0]!.reason, "malformed");
	assert.equal(r.answer(p.id, p.digest, [-1])[0]!.reason, "malformed");
	assert.equal(r.answer(p.id, p.digest, [0, 1])[0]!.reason, "malformed");
	assert.equal(r.answer(p.id, p.digest, "0")[0]!.reason, "malformed");
	assert.equal(r.answer(p.id, p.digest, [0], "short")[0]!.reason, "malformed");
	assert.deepEqual(r.sent("closed"), []);
	assert.equal(r.dialogs[0]!.opts?.signal?.aborted, false);
	assert.equal(r.answer("other-id", p.digest, [0]).length, 0, "an answer for another dialog is not ours to judge");
	assert.equal(r.answer(p.id, p.digest, [1])[0]!.accepted, true);
	assert.equal(await asked, "b");
});

test("the caller's own signal still dismisses the dialog, and is told apart from the terminal's answer", async () => {
	const r = rig(), caller = new AbortController();
	await r.start();
	const asked = confirm(r, "Sure?", "now", { signal: caller.signal });
	caller.abort();
	assert.equal(await asked, false);
	assert.equal((r.sent("closed").at(-1) as { by: string }).by, "abort");
	const again = confirm(r, "Sure?", "now", { signal: new AbortController().signal }), p = r.sent("pending")[1] as ReturnType<typeof pending>;
	r.answer(p.id, p.digest, [0]);
	assert.equal(await again, true, "the combined signal carries the GUI's answer as well");
});

test("it binds to the one tool call in flight: none, two, or a secret_drop leave the dialog in the terminal alone", async () => {
	const r = rig();
	const none = confirm(r);
	await r.start("c1", "bash");
	await r.start("c2", "edit");
	const two = confirm(r);
	await r.end("c2");
	await r.end("c1");
	await r.start("c3", "secret_drop");
	const secret = select(r);
	await r.end("c3");
	assert.deepEqual(r.sent("pending"), [], "nothing relayed");
	assert.equal(r.dialogs.length, 3, "every dialog opened in the terminal");
	r.dialogs.forEach((d) => d.settle(true));
	assert.deepEqual(await Promise.all([none, two, secret]), [true, true, true]);
	await r.start("c4", "bash");
	void confirm(r);
	assert.equal(r.sent("pending").length, 1, "and one call in flight again relays");
});

test("a dialog that cannot be shown is not relayed: no options, non-text options, a very long text, or too many options", async () => {
	const r = rig();
	await r.start();
	const ui = r.ui.select as (...a: unknown[]) => Promise<unknown>;
	void ui("empty", []);
	void ui("odd", [1, 2]);
	void ui("not an array", "abc");
	void select(r, "x".repeat(13_000), ["a"]);
	void select(r, "many", Array.from({ length: 101 }, (_, i) => `o${i}`));
	void (r.ui.confirm as (...a: unknown[]) => Promise<unknown>)("long", "y".repeat(13_000));
	assert.equal(r.dialogs.length, 6, "all opened in the terminal");
	assert.deepEqual(r.sent("pending"), []);
});

test("input, editor and custom are never relayed and their results pass untouched; neither is a session without a UI", async () => {
	const r = rig();
	const { notify } = r.ui;
	await r.start();
	assert.equal(r.ui.notify, notify);
	assert.notEqual(r.ui.select, undefined);
	assert.equal(await (r.ui.input as () => Promise<string>)(), "typed");
	assert.equal(await (r.ui.editor as () => Promise<string>)(), "edited");
	assert.equal(await (r.ui.custom as () => Promise<string>)(), "custom");
	assert.deepEqual(r.seen, [], "nothing on the bus for them");
	const bare = rig({ hasUI: false }), [select0, confirm0] = [bare.ui.select, bare.ui.confirm];
	await bare.start();
	assert.deepEqual([bare.ui.select === select0, bare.ui.confirm === confirm0], [true, true], "pi's shared no-op object is left alone");
});

test("a dialog opened over a relayed one withdraws it: only the outermost counts, and the next one relays again", async () => {
	const r = rig();
	await r.start();
	const outer = confirm(r, "outer", "m"), p = pending(r);
	const inner = select(r, "inner", ["a"]);
	assert.deepEqual(r.sent("closed"), [{ version: 1, id: p.id, by: "error" }], "the page can no longer tell which an answer would dismiss");
	assert.equal(r.sent("pending").length, 1, "and the inner one is not relayed");
	assert.deepEqual(r.answer(p.id, p.digest, [0]).map((x) => [x.accepted, x.reason]), [[false, "closed"]], "the withdrawn dialog takes no answer");
	r.dialogs[1]!.settle("a");
	r.dialogs[0]!.settle(true);
	assert.deepEqual([await inner, await outer], ["a", true]);
	void confirm(r, "next", "m");
	assert.equal(r.sent("pending").length, 2, "depth is back to zero");
});

test("an error inside the wrap falls back to the original call, with no relay left behind", async () => {
	const r = rig({ throwOn: `${UI_PREFIX}:pending` });
	await r.start();
	const asked = confirm(r);
	assert.equal(r.dialogs.length, 1, "pi's dialog opened once, as the extension asked");
	r.dialogs[0]!.settle(true);
	assert.equal(await asked, true);
	assert.deepEqual(r.sent("closed").map((c) => (c as { by: string }).by), ["error"], "the relay was closed again");
	const [{ id }] = r.sent("pending") as { id: string }[];
	assert.deepEqual(r.answer(id!, "f".repeat(64), [0]).map((x) => x.reason), ["closed"], "and it takes no answer");
});

test("a dialog whose original throws synchronously or rejects rethrows that same error", async () => {
	const boom = new Error("boom");
	const sync = rig();
	sync.original.select = () => { throw boom; };
	await sync.start();
	assert.throws(() => select(sync), (error) => error === boom);
	const rejecting = rig();
	rejecting.original.confirm = () => Promise.reject(boom);
	await rejecting.start();
	await assert.rejects(confirm(rejecting), (error) => error === boom);
	assert.equal((rejecting.sent("closed").at(-1) as { by: string }).by, "error");
	await rejecting.end();
	await rejecting.start();
	void select(rejecting);
	assert.equal(rejecting.sent("pending").length, 2, "the count came back to zero after the failure");
});

test("the wrap is put back on a ui object pi swaps in, before the next tool call, and taken off at shutdown", async () => {
	const r = rig();
	const plain0 = r.ui.select;
	await r.fire("session_start");
	assert.notEqual(r.ui.select, plain0, "wrapped at the session's start");
	const fresh = r.swap();
	const plain = fresh.select;
	await r.start();
	assert.notEqual(fresh.select, plain, "the new object is wrapped when the next call starts");
	void select(r);
	assert.equal(r.sent("pending").length, 1);
	await r.fire("session_shutdown");
	assert.deepEqual(r.sent("closed").map((c) => (c as { by: string }).by), ["error"], "an open relay is closed");
	assert.equal(fresh.select, plain, "the original is back");
	void select(r);
	assert.equal(r.sent("pending").length, 1, "and nothing is relayed after");
});

test("several copies of the package wrap one ui object once: a dialog is one dialog on the bus", async () => {
	const r = rig();
	interceptUi(r.pi);
	interceptUi(r.pi);
	await r.fire("session_start");
	await r.start();
	void confirm(r);
	assert.equal(r.sent("pending").length, 1);
	assert.equal(r.dialogs.length, 1);
	await r.fire("session_shutdown");
});

// pi's real ExtensionRunner: every extension's ctx.ui is the same object, so a confirm another extension makes in its tool_call handler (as mp-infra's does) goes through the wrap.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../src/intercept.ts");
test("with pi's real runner an extension's own ctx.ui.confirm in a tool_call handler is relayed, and setUIContext swapping the object is caught at the next tool call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-intercept-"));
	try {
		mkdirSync(join(dir, "agent"));
		const entry = join(dir, "straw.ts"), hook = join(dir, "hook.ts");
		writeFileSync(entry, `import { interceptUi } from ${JSON.stringify(SOURCE)}; export default (pi: any) => interceptUi(pi);`);
		writeFileSync(hook, 'export default (pi: any) => { pi.on("tool_call", async (e: any, ctx: any) => { (globalThis as any).__verdict = await ctx.ui.confirm("mp-infra command review", "ls"); }); };');
		const events = createEventBus(), loaded = await discoverAndLoadExtensions([entry, hook], dir, join(dir, "agent"), events);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, {} as never, {} as never);
		const open: ((v: unknown) => void)[] = [], signals: (AbortSignal | undefined)[] = [];
		const make = () => ({ select: async () => undefined, confirm: (_t: string, _m: string, opts?: { signal?: AbortSignal }) => new Promise((resolve) => (open.push(resolve), signals.push(opts?.signal), opts?.signal?.addEventListener("abort", () => resolve(false)))) });
		const pend: { id: string; digest: string; toolCallId: string }[] = [];
		events.on(`${UI_PREFIX}:pending`, (d) => pend.push(d as never));
		runner.setUIContext(make() as never, "tui");
		await runner.emit({ type: "session_start", reason: "startup" } as never);
		for (const swap of [false, true]) {
			if (swap) runner.setUIContext(make() as never, "tui"); // pi's mode change: a new ui object, unwrapped
			await runner.emit({ type: "tool_execution_start", toolCallId: `c${swap ? 2 : 1}`, toolName: "bash", args: {} } as never);
			const call = runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: `c${swap ? 2 : 1}`, input: {} } as never);
			await settle();
			const p = pend.at(-1)!;
			assert.equal(p.toolCallId, `c${swap ? 2 : 1}`, `relayed${swap ? " after the swap" : ""}`);
			events.emit(`${UI_PREFIX}:answer`, { version: 1, id: p.id, answerId: ANSWER, digest: p.digest, selections: [0] });
			await call;
			assert.equal((globalThis as { __verdict?: unknown }).__verdict, true, "the hook got the GUI's Allow");
			assert.equal(signals.at(-1)?.aborted, true, "pi's terminal dialog was dismissed");
			await runner.emit({ type: "tool_execution_end", toolCallId: `c${swap ? 2 : 1}`, toolName: "bash", result: {}, isError: false } as never);
		}
		assert.equal(pend.length, 2);
		assert.equal(open.length, 2);
	} finally {
		delete (globalThis as { __verdict?: unknown }).__verdict;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an input, editor or custom opened over a relayed confirm withdraws it, and the page's answer is stale", async () => {
	for (const kind of ["input", "editor", "custom"] as const) {
		const r = rig();
		let end!: (v: string) => void;
		(r.ui as Record<string, unknown>)[kind] = (...args: unknown[]) => new Promise<string>((resolve) => (end = resolve)).then((v) => `${v}:${args.join(",")}`);
		await r.start();
		const asked = confirm(r), p = pending(r), typed = (r.ui as unknown as Record<string, (...a: unknown[]) => Promise<string>>)[kind]!("a", "b");
		assert.deepEqual(r.sent("closed"), [{ version: 1, id: p.id, by: "error" }], `${kind} withdraws the relay`);
		assert.deepEqual(r.answer(p.id, p.digest, [0]).map((x) => [x.accepted, x.reason]), [[false, "closed"]], kind);
		end("x");
		assert.equal(await typed, "x:a,b", "arguments and result pass untouched");
		r.dialogs[0]!.settle(true);
		assert.equal(await asked, true);
		void confirm(r, "next", "m");
		assert.equal(r.sent("pending").length, 2, `${kind}: relaying again once both ended`);
	}
});

test("a dialog that never settles does not hold relaying off for good: agent_end and a new ui object reset the count", async () => {
	const r = rig();
	await r.start();
	void confirm(r, "stuck", "m");
	await r.end();
	await r.fire("agent_end");
	await r.start("c2");
	void confirm(r, "after agent_end", "m");
	assert.equal(r.sent("pending").length, 2, "agent_end forgot the stuck dialog");
	await r.end("c2");
	r.swap();
	await r.start("c3");
	void confirm(r, "after swap", "m");
	assert.equal(r.sent("pending").length, 3, "a new ui object starts with nothing open");
});
