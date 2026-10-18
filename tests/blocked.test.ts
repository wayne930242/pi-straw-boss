import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import blockedRelay, { RPIV_BLOCKED } from "../src/blocked.ts";
import { settle } from "./fakes.ts";

type Handler = (event: unknown) => void;
type Sent = { active: boolean; label?: string };

function bus() {
	const handlers = new Map<string, Handler[]>();
	const sent: Sent[] = [];
	const events = {
		on: (name: string, fn: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		emit: (name: string, data: unknown) => (name === "herdr:blocked" ? sent.push(data as Sent) : handlers.get(name)?.forEach((fn) => fn(data))),
	};
	const prompts = new Map<string, Handler>();
	blockedRelay({ events, on: (name: string, fn: Handler) => void prompts.set(name, fn) } as never);
	return {
		emit: (data: unknown) => events.emit(RPIV_BLOCKED, data),
		start: (kind: string, title?: string) => prompts.get("ui_prompt_start")?.({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) }),
		end: (kind: string, title?: string) => prompts.get("ui_prompt_end")?.({ type: "ui_prompt_end", reason: "ui_prompt", kind, ...(title ? { title } : {}) }),
		sent,
	};
}
const states = (sent: Sent[]) => sent.map((d) => d.active);

test("each open questionnaire is relayed as one balanced herdr:blocked pair", () => {
	const { emit, sent } = bus();
	emit({ active: true, toolCallId: "a" });
	emit({ active: true, toolCallId: "a" });
	emit({ active: true, toolCallId: "b" });
	emit({ active: false, toolCallId: "a" });
	emit({ active: false, toolCallId: "a" });
	emit({ active: false, toolCallId: "b" });
	assert.deepEqual(states(sent), [true, true, false, false]);
	assert.match(sent[0]?.label ?? "", /ask_user_question/);
});

test("an end without a start, or a payload without an id, is ignored", () => {
	const { emit, sent } = bus();
	emit({ active: false, toolCallId: "x" });
	emit({ active: true });
	emit(undefined);
	emit({ active: "yes", toolCallId: "y" });
	assert.equal(sent.length, 0);
});

test("a select, confirm, input or editor dialog is one balanced pair that names its title; a custom one is left to its own signal", () => {
	const { start, end, sent } = bus();
	for (const kind of ["select", "confirm", "input", "editor"]) {
		start(kind, `title of ${kind}`);
		end(kind, `title of ${kind}`);
	}
	start("custom", "overlay");
	end("custom", "overlay");
	assert.deepEqual(states(sent), [true, false, true, false, true, false, true, false]);
	assert.deepEqual(sent.filter((d) => d.active).map((d) => d.label), ["select", "confirm", "input", "editor"].map((kind) => `Waiting for your answer: title of ${kind}`));
});

test("the label is one clean line: control, escape and direction-override characters go, and a long title is cut", () => {
	const { start, sent } = bus();
	start("confirm", "mp-infra\ncommand\x1b[31m review\u202e\u0007  now");
	start("confirm");
	assert.equal(sent.length, 1, "a second dialog while one is open adds no second pair");
	assert.equal(sent[0]?.label, "Waiting for your answer: mp-infra command [31m review now");
	const other = bus();
	other.start("select", "x".repeat(200));
	assert.equal(other.sent[0]?.label, `Waiting for your answer: ${"x".repeat(80)}…`);
	const untitled = bus();
	untitled.start("input");
	assert.equal(untitled.sent[0]?.label, "Waiting for your answer: input dialog");
});

test("overlapping dialogs report one pair, from the first start to the last end", () => {
	const { start, end, sent } = bus();
	start("select", "first");
	start("confirm", "second");
	end("confirm");
	assert.deepEqual(states(sent), [true]);
	end("select");
	assert.deepEqual(states(sent), [true, false]);
});

test("pi hands out the start and end unawaited, so any arrival order leaves the pairs balanced and the count at zero", () => {
	const { start, end, sent } = bus();
	end("confirm", "slow");
	assert.equal(sent.length, 0, "an end ahead of its start reports nothing");
	start("confirm", "slow");
	assert.equal(sent.length, 0, "and its start arriving late cancels it out");
	// Three dialogs in a row whose events arrive as end1, end2, start2, start1, end3, start3.
	for (const step of [() => end("input"), () => end("input"), () => start("input", "two"), () => start("input", "one"), () => end("input"), () => start("input", "three")]) step();
	assert.equal(states(sent).filter(Boolean).length, states(sent).filter((on) => !on).length, "every active has its inactive");
	assert.ok(states(sent).every((on, i) => on === (i % 2 === 0)), "they alternate, active first");
	// Every arrival order of four dialogs ends in the same place, balanced.
	let seed = 7;
	const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let round = 0; round < 200; round++) {
		const run = bus();
		const events = Array.from({ length: 4 }, (_, i) => [() => run.start("select", `d${i}`), () => run.end("select")]).flat();
		for (let i = events.length - 1; i > 0; i--) {
			const j = Math.floor(next() * (i + 1));
			[events[i], events[j]] = [events[j]!, events[i]!];
		}
		for (const step of events) step();
		assert.ok(run.sent.every((d, i) => d.active === (i % 2 === 0)), `round ${round} alternates`);
		assert.equal(run.sent.length % 2, 0, `round ${round} ends balanced`);
	}
});

// What Herdr's pi integration (herdr-agent-state.ts) does with herdr:blocked: a count that goes up on active and down, never below zero, on anything else.
// `raw` is the same count without the floor, so a dialog that closes twice shows up as a dip below zero.
function herdr(events: { on: (channel: string, handler: (data: unknown) => void) => unknown }) {
	const mark = { count: 0, raw: 0, lowest: 0, highest: 0, labels: [] as string[] };
	events.on("herdr:blocked", (data) => {
		const { active, label } = (data ?? {}) as { active?: boolean; label?: string };
		mark.raw += active ? 1 : -1;
		mark.count = active ? mark.count + 1 : Math.max(0, mark.count - 1);
		if (active) mark.labels.push(label ?? "");
		mark.lowest = Math.min(mark.lowest, mark.raw);
		mark.highest = Math.max(mark.highest, mark.count);
	});
	return mark;
}

// pi's real ExtensionRunner with this extension loaded the way pi loads it, over a stand-in `ctx.ui` whose dialogs the test settles.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../src/blocked.ts");
type Ui = Record<"select" | "confirm" | "input" | "editor" | "custom", (...args: unknown[]) => Promise<unknown>>;
async function world(extra: Record<string, string> = {}, ui?: Partial<Ui>) {
	const dir = mkdtempSync(join(tmpdir(), "psb-blocked-"));
	mkdirSync(join(dir, "agent"));
	const paths = [...Object.entries(extra).map(([name, text]) => (writeFileSync(join(dir, name), text), join(dir, name))), SOURCE];
	const events = createEventBus();
	const mark = herdr(events);
	const load = async () => {
		const loaded = await discoverAndLoadExtensions(paths, dir, join(dir, "agent"), events);
		assert.deepEqual(loaded.errors, []);
		return new ExtensionRunner(loaded.extensions, loaded.runtime, dir, {} as never, {} as never);
	};
	const open = { select: [] as ((value: unknown) => void)[], custom: [] as ((value: unknown) => void)[] };
	const fake: Ui = {
		select: () => new Promise((resolve) => open.select.push(resolve)),
		confirm: async () => true,
		input: async () => "typed",
		editor: async () => "edited",
		custom: () => new Promise((resolve) => open.custom.push(resolve)),
		...ui,
	};
	const runner = await load();
	runner.setUIContext(fake as never, "tui");
	return { runner, mark, open, events, load, fake, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("with pi's real runner a dialog from any extension is one active while it waits and one inactive after, and its result is untouched", async () => {
	const w = await world();
	try {
		const ui = w.runner.createContext().ui;
		const asked = ui.select("Pick one", ["a", "b"]);
		await settle();
		assert.equal(w.mark.count, 1);
		assert.deepEqual(w.mark.labels, ["Waiting for your answer: Pick one"]);
		w.open.select[0]?.("b");
		assert.equal(await asked, "b");
		await settle();
		assert.equal(w.mark.count, 0);
		assert.equal(await ui.confirm("mp-infra command review", "run it?"), true);
		assert.equal(await ui.input("Name", "x"), "typed");
		assert.equal(await ui.editor("Edit", "x"), "edited");
		await settle();
		assert.equal(w.mark.count, 0);
		assert.equal(w.mark.raw, 0, "balanced");
		assert.equal(w.mark.labels.length, 4);
	} finally {
		w.done();
	}
});

test("a dialog that throws or rejects leaves blocked behind it and passes its error on unchanged", async () => {
	const boom = new Error("boom");
	const w = await world({}, { confirm: () => Promise.reject(boom), input: () => { throw boom; }, editor: async () => undefined });
	try {
		const ui = w.runner.createContext().ui;
		await assert.rejects(ui.confirm("a", "b"), (error) => error === boom);
		assert.throws(() => ui.input("a"), (error) => error === boom);
		assert.equal(await ui.editor("a"), undefined);
		await settle();
		assert.equal(w.mark.count, 0);
		assert.equal(w.mark.raw, 0);
		assert.equal(w.mark.labels.length, 3);
	} finally {
		w.done();
	}
});

test("a custom dialog adds nothing, and one that reports itself with herdr:blocked keeps its own pair", async () => {
	const w = await world();
	try {
		const ui = w.runner.createContext().ui;
		const overlay = ui.custom(() => ({}) as never);
		await settle();
		assert.equal(w.mark.highest, 0);
		w.open.custom[0]?.("x");
		await overlay;
		// robot_hand reports its own select with herdr:blocked too: the two pairs add up while it is open and both close.
		w.events.emit("herdr:blocked", { active: true, label: "Waiting for the user to take a command" });
		const asked = ui.select("robot_hand", ["run"]);
		await settle();
		assert.equal(w.mark.count, 2);
		w.open.select[0]?.("run");
		await asked;
		w.events.emit("herdr:blocked", { active: false });
		await settle();
		assert.equal(w.mark.count, 0);
		assert.equal(w.mark.raw, 0);
		assert.equal(w.mark.lowest, 0);
	} finally {
		w.done();
	}
});

test("dialogs that overlap, or that belong to one tool call each, stay blocked until the last one settles", async () => {
	const w = await world();
	try {
		const ui = w.runner.createContext().ui;
		const first = ui.select("first", []);
		const second = ui.select("second", []);
		await settle();
		assert.equal(w.mark.count, 1);
		w.open.select[0]?.("1");
		await first;
		await settle();
		assert.equal(w.mark.count, 1, "the second is still open");
		w.open.select[1]?.("2");
		await second;
		await settle();
		assert.equal(w.mark.count, 0);
		assert.equal(w.mark.raw, 0);
		assert.equal(w.mark.labels.length, 1);
	} finally {
		w.done();
	}
});

test("behind a slow extension that starts first, an instant dialog still ends balanced instead of sticking on blocked", async () => {
	const w = await world({ "slow.ts": 'export default (pi: any) => { pi.on("ui_prompt_start", () => new Promise((resolve) => setTimeout(resolve, 60))); };' });
	try {
		assert.equal(await w.runner.createContext().ui.confirm("quick", "now"), true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(w.mark.count, 0);
		assert.equal(w.mark.raw, 0);
		assert.equal(w.mark.lowest, 0, "the count never goes below zero");
		// A second dialog afterwards is still seen.
		const asked = w.runner.createContext().ui.select("later", []);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(w.mark.count, 1);
		w.open.select[0]?.("x");
		await asked;
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(w.mark.count, 0);
	} finally {
		w.done();
	}
});

test("a session without a UI wraps nothing and reports nothing, and a reload leaves one relay: one dialog is one pair", async () => {
	const w = await world();
	try {
		const bare = await w.load();
		assert.equal(bare.hasUI(), false);
		assert.equal(await bare.createContext().ui.confirm("a", "b"), false, "pi's own no-op answers");
		await settle();
		assert.equal(w.mark.highest, 0);
		// What pi's reload does: the old runner is invalidated (its bus subscriptions go) and a new one loads the extension again on the same bus.
		w.runner.invalidate();
		const again = await w.load();
		again.setUIContext(w.fake as never, "tui");
		assert.equal(await again.createContext().ui.confirm("after reload", "?"), true);
		await settle();
		assert.equal(w.mark.highest, 1);
		assert.equal(w.mark.raw, 0);
		assert.equal(w.mark.labels.length, 1, "one active for one dialog");
	} finally {
		w.done();
	}
});
