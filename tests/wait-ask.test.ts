import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { underBoss } from "../src/autoscope.ts";
import { cancelledText, refusedText, tailOf } from "../src/autotext.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { Here } from "../src/heremark.ts";
import { HEAD_TOWER_TOOLS, RUN_TOWER_TOOLS } from "../src/runallow.ts";
import { UNATTENDED } from "../src/server/autoops.ts";
import { createAutoMode } from "../src/server/automode.ts";
import type { Slot } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { type Entry, iso, loadMemory, updateMemory } from "../src/server/towermemory.ts";
import { waitList } from "../src/server/waitlist.ts";
import { serverSource } from "../src/towerprompt/serversource.ts";
import { askRefused, lateNotice, pressRequest } from "../src/server/waitpress.ts";
import { PARENT_ONLY } from "../src/tools.ts";
import { createWaitAsk, type Scope, WAIT_ASK, type WaitAskDeps, waitAskParameters } from "../src/waitask.ts";
import { settle, World } from "./fakes.ts";
import { type Answer, rig as makeRig, type Request, scratchRoot } from "./run-rig.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `boss_wait_ask` (docs/specs/2026-11-16-wait-cards-flow.md, C): an agent names open wait cards and sb draws each one for the boss in the terminal, as `/boss wait` draws it. The model words nothing and chooses nothing: only the
// boss's keys press, through a session's request (`via: "ask"`), never a run's token. The server functions here are the real ones (the list, the press); the dialogs are a script.

const NOW = Date.parse("2026-11-16T10:00:00Z");
const NO_RELAY = Symbol.for("pi-straw-boss.no-relay");
const FROM = { id: "main-1", name: "mp3946-print", role: "main", workspace: "Alpha", tab: "MP-3946" };
const card = (over: Record<string, unknown> = {}) => ({ type: "action", lang: "en", happened: "The key expired.", do: "Re-authorize the machine.", after: "The tower asks the main to test.", from: FROM, ...over });
const CHOICE = { type: "choice", do: "Deploy the build now?", options: [{ label: "Deploy", then: "The main deploys." }, { label: "Hold", then: "The main waits." }] };
const STAYS = "it stays open for the GUI and /boss wait; do not ask it again for 10 minutes.";

type Dialog = { kind: "select" | "input" | "confirm"; title: string; options?: string[]; opts: { signal?: AbortSignal } | undefined; boss: boolean; here: boolean };
/** Holds a dialog open until its signal aborts (pi's dialogs then resolve undefined). */
const HOLD = Symbol("hold");
type Step = string | RegExp | typeof HOLD | ((d: Dialog) => unknown) | undefined | boolean;

function harness(over: { scope?: Scope; lang?: "en" | "zh-TW"; hasUI?: boolean; auto?: boolean; refusal?: string; unattended?: boolean; hereFails?: boolean; head?: boolean; onClear?: () => void } = {}) {
	const slot = { dir: mkdtempSync(join(tmpdir(), "psb-waitask-")) } as Slot, told: string[] = [], dialogs: Dialog[] = [], sent: Request[] = [], asked: Request[] = [], events: string[] = [], notices: string[] = [], ticks: (() => void)[] = [];
	let hereOpen = false, script: Step[] = [], auto = over.auto === true, clock = NOW, stops = 0;
	const here: Here = async (fn) => {
		if (over.hereFails) throw new Error("This asks on this computer only, and the pane could not be marked as local-only; nothing was asked.");
		hereOpen = true;
		try { return await fn(); } finally { hereOpen = false; }
	};
	const answer = (d: Dialog): unknown => {
		const step = script.shift();
		if (typeof step === "function") return step(d);
		if (step === HOLD) return new Promise((resolve) => d.opts!.signal!.addEventListener("abort", () => resolve(d.kind === "confirm" ? false : undefined), { once: true }));
		if (!d.options && typeof step === "string") return step;
		if (typeof step === "string" || step instanceof RegExp) {
			const found = d.options?.find((o) => (typeof step === "string" ? o.includes(step) : step.test(o)));
			assert.ok(found, `a dialog "${d.title.split("\n")[0]}" offers ${String(step)}: ${JSON.stringify(d.options)}`);
			return found;
		}
		return step;
	};
	const record = (kind: Dialog["kind"], title: string, options: string[] | undefined, opts: { signal?: AbortSignal } | undefined) => ({ kind, title, ...(options ? { options } : {}), opts, boss: underBoss(), here: hereOpen }) as Dialog;
	const ui = {
		select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => (dialogs.push(record("select", title, options, opts)), (await answer(dialogs.at(-1)!)) as string | undefined),
		input: async (title: string, _ph?: string, opts?: { signal?: AbortSignal }) => (dialogs.push(record("input", title, undefined, opts)), (await answer(dialogs.at(-1)!)) as string | undefined),
		confirm: async (title: string, _msg: string, opts?: { signal?: AbortSignal }) => (dialogs.push(record("confirm", title, undefined, opts)), (await answer(dialogs.at(-1)!)) === true),
	};
	const press = (workspace: string, json: Record<string, unknown>, via: "ask" | "gui" | "pi") => pressRequest({ slot, now: () => clock, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async (to, text) => (notices.push(`${to}: ${text}`), { status: "sent" }), boss: (text) => void events.push(text), autoOn: () => auto }, workspace, json, via);
	const deps: WaitAskDeps = {
		lang: over.lang ?? "en", scope: () => over.scope ?? { kind: "tower", workspace: "wA" }, refusal: () => over.refusal, auto: { on: () => auto, since: () => iso(NOW), kind: () => "main" }, here, now: () => clock,
		every: (fn) => (ticks.push(fn), () => void stops++), tell: (text) => void told.push(text),
		ask: async (request) => {
			asked.push(request);
			// The server's own rule for a device with no boss at it (main.ts asks it before the list is read or a card pressed).
			const no = askRefused(request, () => over.unattended === true);
			if (no) return { ok: false, error: no };
			if (request.cmd === "boss-waits") return { ok: true, ...waitList({ slot, now: () => clock, locale: "en", auto: () => ({ on: auto }) }, [{ workspace: "wA", label: "Alpha" }, { workspace: "wB", label: "Beta" }], over.head ? {} : undefined, typeof request.workspace === "string" ? request.workspace : undefined) };
			if (request.cmd === "tower-memory" && (request.json as { op?: string; clear?: boolean }).clear === true) over.onClear?.();
			if (request.cmd === "tower-memory" && (request.json as { op?: string }).op === "wait-notice") return { ok: true, ...(await lateNotice({ slot, now: () => clock, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async (to, text) => (notices.push(`${to}: ${text}`), { status: "sent" }), boss: () => {}, autoOn: () => auto }, String(request.workspace), request.json as Record<string, unknown>, "ask")) };
			if (request.cmd === "tower-memory") return (sent.push(request), { ok: true, ...(await press(String(request.workspace), request.json as Record<string, unknown>, request.via === "ask" ? "ask" : "pi")) });
			return { ok: true, answered: request.answers, queued: "e1" };
		},
	};
	const tool = createWaitAsk(deps);
	const plant = (key: string, e: Partial<Entry> & { id: string }) => updateMemory(slot, key, NOW, (m) => void m.entries.push({ kind: "wait", text: String(e.card?.do ?? "a wait"), by: "run", via: "run", at: iso(NOW - 12 * 60_000), run: "r1", for: "boss", state: "open", ...e } as Entry));
	return {
		slot, told, dialogs, sent, asked, events, notices, plant, press, stops: () => stops,
		setAuto: (on: boolean) => void (auto = on), advance: (ms: number) => void (clock += ms),
		/** The look of the dialog that is open now (the watch's timer, fired by the test). */
		look: async () => { ticks.at(-1)!(); await settle(); },
		/** A call whose turn can be stopped: `signal` is the tool's own. */
		callWith: (signal: AbortSignal, params: Record<string, unknown>, ...steps: Step[]) => ((script = steps), tool(params as never, signal, { hasUI: over.hasUI ?? true, ui })),
		call: (params: Record<string, unknown>, ...steps: Step[]) => ((script = steps), tool(params as never, undefined, { hasUI: over.hasUI ?? true, ui })),
		text: async (params: Record<string, unknown>, ...steps: Step[]) => ((script = steps), (await tool(params as never, undefined, { hasUI: over.hasUI ?? true, ui })).text),
		wait: (ws: string, id: string) => loadMemory(slot, ws).memory.entries.find((e) => e.id === id)!,
	};
}

test("the model names cards and nothing else: the schema takes only ids, and an act, an option, or a reason in the arguments chooses nothing; the press is the row the boss picked", async () => {
	const schema = waitAskParameters() as unknown as { properties: Record<string, { maxItems?: number; minItems?: number; items?: { pattern?: string } }>; required?: string[] };
	assert.deepEqual(Object.keys(schema.properties), ["ids"], "ids is the only parameter");
	assert.deepEqual([schema.properties.ids!.minItems, schema.properties.ids!.maxItems, schema.properties.ids!.items?.pattern, schema.required ?? []], [1, 4, "^W[0-9]+$", []]);
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const out = await h.text({ ids: ["W1"], act: "choose", option: 0, choose: "Deploy", reason: "the model says so", answer: "Deploy" }, /2\) Hold/);
	assert.equal(h.dialogs.length, 1, "the card is drawn whatever else the arguments say");
	assert.deepEqual(h.dialogs[0]!.options, ["1) Deploy — The main deploys.", "2) Hold — The main waits.", "Skip", "Reply to the tower"], "the card's own acts and the reply: no row is the model's");
	assert.match(h.dialogs[0]!.title, /^\[Alpha\] W1\nWhat happened: The key expired\.\nWhat you do: Deploy the build now\?/, "the title is the card as recorded");
	assert.deepEqual(h.sent.map((r) => r.json), [{ op: "press", id: "W1", act: "choose", option: 1 }]);
	assert.equal(h.wait("wA", "W1").press!.option, 1, "what the boss picked, not what the arguments named");
	assert.equal(out, 'W1: the boss chose "Hold" (then: The main waits.); the tower was told.');
	// ids that are no wait ids are refused before anything is read
	for (const bad of [["W1", "W2", "W3", "W4", "W5"], [], ["done"], ["W1; act=done"]]) await assert.rejects(h.call({ ids: bad }), /ids names 1 to 4 wait cards/, JSON.stringify(bad));
});

test("every dialog is terminal-only, under the boss's mark, inside the here mark; the press is a session's request with via ask and no run token; a pane that cannot be marked draws nothing", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	// W2 (the newer) first: skipped with a reason; then W1: a reply
	await h.call({}, "Skip", "not this week", true, /^Reply to the tower/, "on Monday");
	assert.deepEqual(h.dialogs.map((d) => d.kind), ["select", "input", "confirm", "select", "input"]);
	for (const d of h.dialogs) {
		assert.ok(d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY), `${d.kind} "${d.title.split("\n")[0]}" is terminal-only`);
		assert.ok(d.opts!.signal instanceof AbortSignal, `${d.kind} can be aborted`);
		assert.equal(d.boss, true, `${d.kind} runs under the boss's mark`);
		assert.equal(d.here, true, `${d.kind} opens inside the here mark`);
	}
	assert.deepEqual(h.sent, [{ cmd: "tower-memory", workspace: "wA", json: { op: "press", id: "W2", act: "decline", reason: "not this week" }, via: "ask" }]);
	assert.equal(h.asked.some((r) => "token" in r), false, "no request carries a run token");
	const refused = harness({ hereFails: true });
	refused.plant("wA", { id: "W1", card: card() as never });
	await assert.rejects(refused.call({}, "I'm done"), /could not be marked as local-only/);
	assert.equal(refused.dialogs.length, 0);
	assert.equal(refused.sent.length, 0);
});

test("the result says per card what the boss did: an option, done, a skip with its reason, a reply, or no answer; with no ids every open card of the scope is asked, one after another, and Escape ends the round", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card(CHOICE) as never });
	h.plant("wA", { id: "W3", card: card({ do: "third" }) as never });
	h.plant("wA", { id: "W4", card: card({ do: "fourth" }) as never });
	h.plant("wA", { id: "W5", card: card({ do: "fifth" }) as never });
	h.plant("wA", { id: "W6", card: card({ do: "pressed before" }) as never, state: "answered", press: { act: "done", at: iso(NOW) } as never });
	// newest first: W6 is pressed (not asked), W5 next card, W4 reply, W3 skip, W2 choose, W1 done
	const out = await h.text({}, "Next card", /^Reply to the tower/, "wait for Monday", "Skip", "no budget", true, /1\) Deploy/, "I'm done");
	assert.deepEqual(out.split("\n"), [
		`W5: no answer (the boss moved to the next card); ${STAYS}`,
		'W4: the boss replied to the tower: "wait for Monday"',
		'W3: skipped by the boss: "no budget"; the tower was told. Do not ask again unless something changed.',
		'W2: the boss chose "Deploy" (then: The main deploys.); the tower was told.',
		"W1: the boss did it (Re-authorize the machine.); the tower was told.",
	]);
	assert.deepEqual(h.dialogs.filter((d) => d.kind === "select").map((d) => /W\d/.exec(d.title)![0]), ["W5", "W4", "W3", "W2", "W1"], "one dialog per card, no list between");
	assert.deepEqual(h.dialogs[0]!.options!.slice(-2), ["Reply to the tower", "Next card"], "a card with more behind it offers the way on; there is no list and no tab switch");
	assert.equal(h.dialogs.filter((d) => d.kind === "select").at(-1)!.options!.includes("Next card"), false, "the last one has none");
	// Escape ends the round: the cards behind it are not shown
	const esc = harness();
	esc.plant("wA", { id: "W1", card: card() as never });
	esc.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	assert.deepEqual((await esc.text({}, undefined)).split("\n"), [`W2: no answer (Esc); ${STAYS}`, `W1: not shown (the boss left the dialog); ${STAYS}`]);
	assert.equal(esc.dialogs.length, 1);
	assert.equal(esc.sent.length, 0);
	const none = harness();
	assert.equal(await none.text({}), "No open wait card in your scope.");
	assert.equal(none.dialogs.length, 0);
});

test("the scope: a main is shown only the cards it raised, a tower run its tower's, the head's run any; an id outside the scope or pressed already is said and not drawn", async () => {
	const plantAll = (h: ReturnType<typeof harness>) => {
		h.plant("wA", { id: "W1", card: card() as never });
		h.plant("wA", { id: "W2", card: card({ do: "another main's", from: { ...FROM, id: "main-2", name: "other" } }) as never });
		h.plant("wB", { id: "W1", card: card({ do: "beta's" }) as never });
		h.plant(HEAD_KEY, { id: "W1", card: card({ do: "the head's", from: { ...FROM, id: "main-3" } }) as never });
		h.plant("wA", { id: "W3", card: card({ do: "pressed" }) as never, state: "answered", press: { act: "done", at: iso(NOW) } as never });
	};
	const shown = (h: ReturnType<typeof harness>) => h.dialogs.filter((d) => d.kind === "select").map((d) => d.title.split("\n")[0]);
	const main = harness({ scope: { kind: "raised", by: "main-1" }, head: true });
	plantAll(main);
	await main.call({}, undefined);
	assert.deepEqual(shown(main), ["[Alpha] W1"], "the first of its own (the head's and another main's are not); Escape ended the round");
	const mainIds = harness({ scope: { kind: "raised", by: "main-1" }, head: true });
	plantAll(mainIds);
	assert.deepEqual((await mainIds.text({ ids: ["W2", "W3", "W9"] })).split("\n"), ["W2: not an open wait card you raised.", "W3: answered already (done); nothing to ask.", "W9: not an open wait card you raised."]);
	assert.equal(mainIds.dialogs.length, 0);
	const run = harness({ scope: { kind: "tower", workspace: "wA" }, head: true });
	plantAll(run);
	await run.call({}, "Next card", undefined);
	assert.deepEqual(shown(run), ["[Alpha] W2", "[Alpha] W1"], "its tower's cards only");
	assert.deepEqual(run.asked.filter((r) => r.cmd === "boss-waits")[0], { cmd: "boss-waits", workspace: "wA", ask: true });
	const head = harness({ scope: { kind: "all" }, head: true });
	plantAll(head);
	const out = await head.text({ ids: ["W1"] }, "Next card", "Next card", "I'm done");
	assert.deepEqual(shown(head), ["[head tower] W1", "[Alpha] W1", "[Beta] W1"], "an id names the card of every tower that has it, each under its tower");
	assert.deepEqual(out.split("\n").map((l) => l.split(":")[0]), ["W1 (head tower)", "W1 (Alpha)", "W1 (Beta)"]);
});

test("first answer wins: a press in the GUI while the dialog is open aborts it at the next look, and the result names what was pressed; nothing more is pressed", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const pending = h.text({ ids: ["W1"] }, HOLD);
	await until(() => h.dialogs.length === 1, "the dialog");
	await h.look();
	assert.equal(h.dialogs[0]!.opts!.signal!.aborted, false, "a look that finds the card still open changes nothing");
	assert.equal((await h.press("wA", { op: "press", id: "W1", act: "choose", option: 0 }, "gui")).status, 200);
	await h.look();
	assert.equal(h.dialogs[0]!.opts!.signal!.aborted, true, "the dialog is aborted through its signal");
	assert.equal(await pending, 'W1: answered elsewhere first: chose "Deploy".');
	assert.equal(h.sent.length, 0, "this session pressed nothing");
	assert.equal(h.stops(), 1, "the watch ended with the dialog");
	// a card resolved elsewhere (a skip in the GUI) is gone from the list
	const gone = harness();
	gone.plant("wA", { id: "W1", card: card() as never });
	const left = gone.text({}, HOLD);
	await until(() => gone.dialogs.length === 1, "the dialog");
	await gone.press("wA", { op: "press", id: "W1", act: "decline" }, "gui");
	await gone.look();
	assert.equal(await left, "W1: answered elsewhere first: it is no longer open.");
});

test("the race: the boss presses here after the GUI did and before a look: the server refuses the second press with the first one named, which is the result, and one press stays", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	h.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	// the dialog is open with W1 unpressed; the GUI presses it, and the boss's key here comes before any look
	const out = await h.text({ ids: ["W1", "W2"] }, async (d) => {
		assert.equal((await h.press("wA", { op: "press", id: "W1", act: "choose", option: 0 }, "gui")).status, 200);
		return d.options!.find((o) => /2\) Hold/.test(o));
	}, "I'm done");
	assert.equal(h.sent.length, 2, "both presses were asked of the server");
	assert.match(out.split("\n")[0]!, /^W1: answered elsewhere first: W1 was pressed already: Deploy at \d\d:\d\d$/);
	assert.equal(out.split("\n")[1], "W2: the boss did it (second); the tower was told.", "the round goes on to the next card");
	assert.equal(h.wait("wA", "W1").press!.option, 0, "the first press stands");
});

test("the asker is the raiser: its own result is its notice, so no wait_card is sent, the delivery is recorded as asked, and the tower's event still goes; a tower run's ask still tells the raiser", async () => {
	const main = harness({ scope: { kind: "raised", by: "main-1" } });
	main.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const out = await main.text({ ids: ["W1"] }, /1\) Deploy/);
	assert.deepEqual(main.sent, [{ cmd: "tower-memory", workspace: "wA", json: { op: "press", id: "W1", act: "choose", option: 0, asker: "main-1" }, via: "ask" }]);
	assert.deepEqual(main.notices, [], "no wait_card intercom to the session that asked");
	assert.equal(main.wait("wA", "W1").press!.main!.status, "asked");
	assert.deepEqual(main.events, ['The boss chose "Deploy" on wait W1 (Deploy the build now?): The main deploys. Act on it, then resolve W1. mp3946-print got it.'], "the tower is told as for every press");
	assert.equal(out, 'W1: the boss chose "Deploy" (then: The main deploys.); the tower was told.\nThis is the boss\'s answer: no wait_card message follows.');
	assert.match(main.told.at(-1)!, /^W1 chose "Deploy": mp3946-print was told\.$/);
	// an asker that is not the raiser (another session's id, or a tower run, which names none) is told nothing less
	const other = harness({ scope: { kind: "raised", by: "main-9" } });
	other.plant("wA", { id: "W1", card: card({ from: { ...FROM, id: "main-9" } }) as never });
	assert.equal((await other.press("wA", { op: "press", id: "W1", act: "done", asker: "main-1" }, "ask")).status, 200);
	assert.equal(other.notices.length, 1, "an asker that did not raise the card does not silence its raiser");
	const forged = harness();
	forged.plant("wA", { id: "W1", card: card() as never });
	assert.equal((await forged.press("wA", { op: "press", id: "W1", act: "done", asker: "main-1" }, "pi")).status, 200);
	assert.equal(forged.notices.length, 1, "asker counts only at the ask door");
	const run = harness({ scope: { kind: "tower", workspace: "wA" } });
	run.plant("wA", { id: "W1", card: card() as never });
	assert.equal(await run.text({}, "I'm done"), "W1: the boss did it (Re-authorize the machine.); the tower was told.");
	assert.deepEqual(run.sent.map((r) => r.json), [{ op: "press", id: "W1", act: "done" }], "a run names no asker");
	assert.deepEqual(run.notices, ["main-1: The boss did what wait W1 asked: Re-authorize the machine. This is the boss's answer to your wait: act on it."]);
	assert.equal(run.wait("wA", "W1").press!.main!.status, "delivered");
});

test("a card the boss left unanswered is not drawn again for 10 minutes, named or not; after that it is", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	assert.equal(await h.text({ ids: ["W1"] }, undefined), `W1: no answer (Esc); ${STAYS}`);
	assert.equal(h.dialogs.length, 1);
	h.advance(9 * 60_000);
	for (const params of [{ ids: ["W1"] }, {}]) assert.equal(await h.text(params, "I'm done"), `W1: the boss left it unanswered 9 min ago; ${STAYS}`);
	assert.equal(h.dialogs.length, 1, "nothing was drawn");
	assert.equal(h.sent.length, 0);
	h.advance(61_000);
	assert.match(await h.text({ ids: ["W1"] }, "I'm done"), /^W1: the boss did it/);
	assert.equal(h.dialogs.length, 2);
});

test("refused with nothing read or drawn: the session's own reason, auto mode, and a session without a screen; on an unattended device the server refuses the read and nothing is drawn", async () => {
	const cases: [Parameters<typeof harness>[0], RegExp | string][] = [
		[{ refusal: "The boss is not at this pane." }, "The boss is not at this pane."],
		[{ auto: true }, refusedText(iso(NOW), WAIT_ASK, "main")],
		[{ hasUI: false }, /has no screen/],
	];
	for (const [over, why] of cases) {
		const h = harness(over);
		h.plant("wA", { id: "W1", card: card() as never });
		await assert.rejects(h.call({}, "I'm done"), (e: Error) => (typeof why === "string" ? e.message === why : why.test(e.message)), JSON.stringify(over));
		assert.equal(h.asked.length, 0, `${JSON.stringify(over)}: nothing is asked of the server`);
		assert.equal(h.dialogs.length, 0);
	}
	const box = harness({ unattended: true });
	box.plant("wA", { id: "W1", card: card() as never });
	await assert.rejects(box.call({}, "I'm done"), (e: Error) => e.message === UNATTENDED);
	assert.equal(box.dialogs.length, 0);
	assert.equal(box.sent.length, 0);
	assert.equal(box.wait("wA", "W1").state, "open");
});

test("auto mode starting while the dialog is open aborts it at the next look: the result is sb's cancel text, the rest is not shown, and nothing is pressed", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	const pending = h.text({}, HOLD);
	await until(() => h.dialogs.length === 1, "the dialog");
	h.setAuto(true);
	await h.look();
	assert.deepEqual((await pending).split("\n"), [`W2: ${cancelledText(iso(NOW), WAIT_ASK, "main")}`, "W1: not shown (auto mode started); it stays parked for the boss."]);
	assert.equal(h.dialogs.length, 1);
	assert.equal(h.sent.length, 0);
});

// --- the server's part ------------------------------------------------------------------------------------------------------------------------------------------------------

test("a device with no boss at it refuses the ask's read and its press, and nothing else of the list or the memory", () => {
	const yes = () => true;
	assert.equal(askRefused({ cmd: "boss-waits", ask: true }, yes), UNATTENDED);
	assert.equal(askRefused({ cmd: "tower-memory", via: "ask", json: { op: "press" } }, yes), UNATTENDED);
	for (const request of [{ cmd: "boss-waits" }, { cmd: "boss-waits", ask: "true" }, { cmd: "tower-memory", via: "pi" }, { cmd: "tower-memory" }, { cmd: "tower-event", ask: true }]) assert.equal(askRefused(request, yes), undefined, JSON.stringify(request));
	for (const request of [{ cmd: "boss-waits", ask: true }, { cmd: "tower-memory", via: "ask" }]) assert.equal(askRefused(request, () => false), undefined, "an attended device refuses neither");
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
test("on a running server: the ask's press is logged by its door, the memory and the list stay refused to a run's token, and the words the boss wrote at the standing pane reach the run marked with that door", async () => {
	const tw = new TowerWorld();
	tw.setFlag(true);
	tw.env.LANG = "en_US.UTF-8";
	try {
		const s: Running = await tw.start();
		await s.handle.ready;
		const ask = (cmd: Record<string, unknown>) => callControl(s.handle.endpoint, tw.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
		await ask({ cmd: "ensure-tower", workspace: "wA" });
		const now = Date.now();
		for (const id of ["W1", "W2"]) updateMemory(tw.slot, "wA", now, (m) => void m.entries.push({ id, kind: "wait", text: "t", by: "run", via: "run", at: iso(now), run: "r1", for: "boss", state: "open", card: card({ do: `TEXT ${id}` }) } as Entry));
		assert.equal((await ask({ cmd: "boss-waits", ask: true, workspace: "wA" })).ok, true, "an attended server reads the list for the ask");
		const pressed = await ask({ cmd: "tower-memory", workspace: "wA", json: { op: "press", id: "W1", act: "done", asker: "main-1" }, via: "ask" });
		assert.equal(pressed.status, 200, JSON.stringify(pressed));
		assert.equal((pressed.body as { press: { main: { status: string } } }).press.main.status, "asked");
		const log = readFileSync(tw.record()!.log, "utf8");
		assert.match(log, /op=press.* id=W1\b.* via=ask\b.* delivery=asked/);
		const token = tw.expose!.runs.mint("wA", { kind: "local" });
		for (const request of [{ cmd: "boss-waits", ask: true }, { cmd: "tower-memory", workspace: "wA", json: { op: "press", id: "W2", act: "done" }, via: "ask" }]) {
			const refused = await ask({ ...request, token });
			assert.deepEqual([refused.ok, refused.error], [false, `a run token may not ask for ${request.cmd}`]);
		}
		assert.equal(loadMemory(tw.slot, "wA").memory.entries.find((e) => e.id === "W2")!.state, "open");
		// the boss's words by their door: the standing pane's prompt says `door: "pane"`; the GUI's composer and another pi say none; a press is no word and names none
		const taken = async () => {
			let got: { id: string; kind: string; door?: string; press?: boolean } | undefined;
			await until(async () => ((got = (await ask({ cmd: "run-poll", token, idle: true })).event as typeof got), got !== undefined), "an event");
			await ask({ cmd: "run-taken", token, id: got!.id });
			return [got!.kind, got!.door, got!.press];
		};
		assert.deepEqual(await taken(), ["boss", undefined, true], "the press of W1 above: his button, marked as one, with no door");
		assert.equal((await ask({ cmd: "tower-event", workspace: "wA", text: "from the pane", present: true, door: "pane" })).ok, true);
		assert.deepEqual(await taken(), ["boss", "pane", undefined]);
		assert.equal((await ask({ cmd: "tower-event", workspace: "wA", text: "from another pi", present: true, door: "gui" })).ok, true);
		assert.deepEqual(await taken(), ["boss", undefined, undefined], "any other word names no door, whatever it says");
		// the standing pane's own prompt (towerprompt/serversource.ts) says it of every line the boss writes there
		await serverSource(tw.ctx(), "wA", 4100).post("typed at the tower prompt");
		assert.deepEqual(await taken(), ["boss", "pane", undefined]);
	} finally {
		await tw.close();
	}
});

// --- who has the tool, and when a run may draw it ----------------------------------------------------------------------------------------------------------------------------

test("the lists: a local and a head run's --tools name it, sb's parent-only tools include it, and the head's refusal names it", () => {
	assert.ok((RUN_TOWER_TOOLS as readonly string[]).includes(WAIT_ASK));
	assert.ok((HEAD_TOWER_TOOLS as readonly string[]).includes(WAIT_ASK));
	assert.ok(PARENT_ONLY.includes(WAIT_ASK));
});

const CARD = { type: "action", lang: "en", happened: "The key expired.", do: "Re-authorize the machine.", from: { id: "main-1", name: "mp3946-print", role: "main" } };
type Event = { id: string; kind: string; text: string; door?: string; press?: true };
/** The server a session or a run talks to: scripted, every request kept. */
function fakeServer(over: { kind?: "local" | "head"; hand?: boolean } = {}) {
	const requests: Request[] = [], queue: Event[] = [], taken: string[] = [];
	const waits = [{ workspace: "wA", label: "Alpha", own: true, waits: [{ id: "W1", text: CARD.do, at: new Date(Date.now() - 5 * 60_000).toISOString(), state: "open", card: CARD }] }];
	return {
		requests, queue, taken,
		ask: async (request: Request): Promise<Answer> => {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return { ok: true, token: "TOKEN", kind: over.kind ?? "local", ...(over.hand ? { hand: true } : {}), run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: "You are a run of the tower of workspace Alpha (wA); head tower: Alpha." };
				case "run-poll": {
					const next = request.idle === true ? queue.find((e) => !taken.includes(e.id)) : undefined;
					return { ok: true, waits: [], auto: false, ...(next ? { event: next } : {}) };
				}
				case "run-taken": return (taken.push(String(request.id)), { ok: true });
				case "boss-waits": return { ok: true, auto: { on: false }, towers: waits };
				case "tower-memory": return { ok: true, status: 200, body: { id: "W1", press: { act: "done", at: "x", main: { status: "delivered", at: "x" } } } };
				case "gui-lan-face": return { ok: true, face: "F1" };
				default: return { ok: true };
			}
		},
	};
}

let world: World;
beforeEach(() => void (world = new World()));
afterEach(() => world.stopAll());
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

test("a main has it and asks the cards it raised through a session's request; a member is refused, a child and the resident tower do not have it, and auto mode refuses the call before it runs", async () => {
	const srv = fakeServer();
	const main = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { ask: async (request) => srv.ask(request) } });
	await main.start();
	assert.ok(main.tools.has(WAIT_ASK), "a joined session registers it");
	await assert.rejects(main.tool(WAIT_ASK, {}), /only a tab's main agent/i, "a member is refused");
	assert.equal(main.dialogs.length, 0);
	await main.promote();
	const asked = main.tool(WAIT_ASK, { ids: ["W1"] });
	await until(() => main.dialogs.length === 1, "the card's dialog");
	const d = main.dialogs[0]!;
	assert.ok(d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY), "terminal-only");
	d.settle((d.second as string[]).find((o) => o === "I'm done"));
	assert.equal(textOf(await asked), "W1: the boss did it (Re-authorize the machine.); the tower was told.\nThis is the boss's answer: no wait_card message follows.");
	const press = srv.requests.find((r) => r.cmd === "tower-memory")!;
	assert.deepEqual([press.via, press.json, "token" in press], ["ask", { op: "press", id: "W1", act: "done", asker: "main-1" }, false]);
	assert.deepEqual(srv.requests.filter((r) => r.cmd === "gui-lan-face").map((r) => r.open), [true, false], "the here mark opened for the dialog and dropped after it");
	// a card another session raised is not this main's to ask
	const other = world.agent({ id: "main-2", pane: "wA:p2", tab: "wA:t2", ui: true, deps: { ask: async (request) => srv.ask(request) } });
	await other.start();
	await other.promote();
	assert.equal(textOf(await other.tool(WAIT_ASK, { ids: ["W1"] })), "W1: not an open wait card you raised.");
	assert.equal(other.dialogs.length, 0);
	const child = world.agent({ id: "c", pane: "wA:p9", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	await child.start();
	assert.equal(child.tools.has(WAIT_ASK), false, "a subagent has no such tool");
	world.herdr.addTab("wA:t7", "🗼 tower", "wA:p7");
	const tower = world.agent({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } });
	await tower.start();
	assert.equal(tower.tools.has(WAIT_ASK), false, "the resident tower has no such tool");
	// auto mode: refused at the tool_call hook, with the main's own tail, as every call that waits for the boss
	const auto = createAutoMode({ dir: world.stateDir, now: () => NOW, log: () => {} });
	auto.start();
	auto.switchOn({ via: "pi", name: "test" });
	const blocked = (await main.fireResult("tool_call", { toolName: WAIT_ASK, toolCallId: "tc", input: {} })) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true);
	assert.ok(blocked!.reason!.includes(`${WAIT_ASK} waits for the boss and is refused. ${tailOf("main", WAIT_ASK)}`), String(blocked!.reason));
});

const runAgent = async (srv: ReturnType<typeof fakeServer>) => {
	const agent = world.agent({ id: "run1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { stateDir: world.stateDir, runSide: { ask: srv.ask, pollMs: 20, claimWaitMs: 300 } } });
	agent.flags.set("sb-run", "RUN");
	await agent.start();
	await until(() => srv.requests.some((r) => r.cmd === "run-poll"), "the run to poll");
	return agent;
};
/** An event of the server reaches the run's session and its turn runs and settles. */
const deliver = async (agent: Awaited<ReturnType<typeof runAgent>>, srv: ReturnType<typeof fakeServer>, event: Event) => {
	srv.queue.push(event);
	await until(() => srv.taken.includes(event.id), `the event ${event.id}`);
	await agent.fire("agent_start");
	await agent.fire("agent_settled");
};
const AWAY = /^Error: The boss is not at this pane: /;
/** One call in a run: the card's dialog is answered with done when it opens. Resolves with the result text; a refusal rejects. */
const askInRun = async (agent: Awaited<ReturnType<typeof runAgent>>) => {
	const before = agent.dialogs.length, asked = agent.tool(WAIT_ASK, {});
	asked.catch(() => {});
	await Promise.race([until(() => agent.dialogs.length > before, "the dialog"), asked.then(() => undefined, () => undefined)]);
	if (agent.dialogs.length > before) agent.dialogs.at(-1)!.settle("I'm done");
	return textOf(await asked);
};

test("a local run draws it only while the boss's last words in the run came from this pane: typed in its pi, or written at the standing pane's prompt; words from the GUI or another pi move him away, and a press is no word", async () => {
	const srv = fakeServer(), agent = await runAgent(srv);
	assert.ok(agent.tools.has(WAIT_ASK), "a local run registers it");
	await assert.rejects(askInRun(agent), AWAY, "no word of the boss yet");
	await deliver(agent, srv, { id: "e1", kind: "intercom", text: "a main reports" });
	await assert.rejects(askInRun(agent), AWAY, "an agent's event is no word of the boss");
	await deliver(agent, srv, { id: "e2", kind: "boss", text: "from the prompt", door: "pane" });
	assert.equal(await askInRun(agent), "W1: the boss did it (Re-authorize the machine.); the tower was told.");
	const press = srv.requests.find((r) => r.cmd === "tower-memory")!;
	assert.deepEqual([press.via, press.json, press.workspace, "token" in press], ["ask", { op: "press", id: "W1", act: "done" }, "wA", false], "a session's request: no run token, and no asker");
	assert.equal(srv.requests.find((r) => r.cmd === "boss-waits")!.workspace, "wA", "the list of its own tower");
	for (const cmd of ["boss-waits", "tower-memory", "gui-lan-face"]) for (const r of srv.requests.filter((x) => x.cmd === cmd)) assert.equal("token" in r, false, `${cmd} carries no token`);
	await deliver(agent, srv, { id: "e3", kind: "boss", text: "The boss pressed done on wait W1", press: true });
	assert.match(await askInRun(agent), /^W1: /, "a press is no word: he is still at the pane");
	await deliver(agent, srv, { id: "e4", kind: "boss", text: "from the GUI's composer" });
	await assert.rejects(askInRun(agent), AWAY, "his last words came from elsewhere");
	await agent.fire("input", { source: "extension", text: "/boss wait" });
	await assert.rejects(askInRun(agent), AWAY, "an extension's message is not the keyboard");
	await agent.fire("input", { source: "interactive", text: "I am here" });
	assert.match(await askInRun(agent), /^W1: /, "typed in the run's own pi");
	assert.equal(agent.dialogs.every((d) => d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY)), true);
});

test("the head's run has it with every tower's cards in scope; a hand run draws it only in a turn the boss started; an ally run has no such tool", async () => {
	const srv = fakeServer({ kind: "head" }), head = await runAgent(srv);
	assert.ok(head.tools.has(WAIT_ASK));
	await head.fire("input", { source: "interactive", text: "what waits for me?" });
	assert.match(await askInRun(head), /^W1 \(Alpha\): the boss did it/);
	assert.equal("workspace" in srv.requests.find((r) => r.cmd === "boss-waits")!, false, "every tower's list");
	await head.stop("reload");
	world = new World();
	const hsrv = fakeServer({ hand: true }), hand = await runAgent(hsrv);
	await hand.fire("input", { source: "interactive", text: "show me the cards" });
	await hand.fire("agent_start");
	assert.match(await askInRun(hand), /^W1: /, "in the turn the boss started");
	await hand.fire("agent_settled");
	await deliver(hand, hsrv, { id: "e1", kind: "intercom", text: "a main reports" });
	await hand.fire("agent_start");
	await assert.rejects(askInRun(hand), /only in a turn the boss started/);
	await hand.fire("agent_settled");
	// an ally run: a real pi session, its tools as the run registers them
	const root = scratchRoot(), sessions: AgentSession[] = [];
	try {
		const DEV = "a".repeat(26), requests: Request[] = [];
		const ask = async (request: Request): Promise<Answer> => {
			requests.push(request);
			return request.cmd === "claim" ? { ok: true, token: "TOKEN", kind: "ally", level: "reply", peer: { device: DEV, label: "Carol Mac", short: DEV.slice(0, 6), team: "1".repeat(32), teamName: "Team One" }, run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: "BRIEF" } : { ok: true };
		};
		const r = await makeRig(root, ask, sessions);
		await until(() => requests.some((q) => q.cmd === "run-poll"), "the ally run to poll");
		assert.equal(r.session.getAllTools().some((t) => t.name === WAIT_ASK), false);
	} finally {
		for (const s of sessions) s.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("R-F001: the boss's last words at this pane age: past the run's away span (10 min) with no new word a run is refused again, and a new word at the pane renews it", async () => {
	const srv = fakeServer();
	let clock = Date.now();
	const agent = world.agent({ id: "run1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { now: () => clock, stateDir: world.stateDir, runSide: { ask: srv.ask, pollMs: 20, claimWaitMs: 300 } } });
	agent.flags.set("sb-run", "RUN");
	await agent.start();
	await until(() => srv.requests.some((r) => r.cmd === "run-poll"), "the run to poll");
	await deliver(agent, srv, { id: "e1", kind: "boss", text: "from the prompt", door: "pane" });
	clock += 9 * 60_000;
	assert.match(await askInRun(agent), /^W1: /, "9 minutes on he is still taken to be at the pane");
	clock += 2 * 60_000;
	await assert.rejects(askInRun(agent), AWAY, "11 minutes with no word: a dialog would wait where nobody looks");
	await agent.fire("input", { source: "interactive", text: "back" });
	assert.match(await askInRun(agent), /^W1: /, "a word at the pane renews it");
});

test("R-F001: a dialog nobody touches for 60 s ends at the next look: no answer, the card stays open, the rest is not shown, and it is not drawn again for 10 minutes", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	h.plant("wA", { id: "W2", card: card() as never });
	const pending = h.text({}, HOLD);
	await until(() => h.dialogs.length === 1, "the dialog");
	h.advance(59_000);
	await h.look();
	assert.equal(h.dialogs[0]!.opts!.signal!.aborted, false, "59 s is not yet quiet");
	h.advance(2000);
	await h.look();
	assert.equal(h.dialogs[0]!.opts!.signal!.aborted, true);
	const out = await pending;
	assert.match(out, /^W2: no answer \(the dialog stood 61 s with no key\); it stays open/);
	assert.match(out, /W1: not shown \(the dialog stood quiet\)/);
	assert.equal(h.sent.length, 0);
	assert.equal(h.dialogs.length, 1);
});

test("R-F006: the asker is the raiser and its turn was stopped after the press: the result never reaches it, so sb sends it the wait_card after all", async () => {
	const main = harness({ scope: { kind: "raised", by: "main-1" } });
	main.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const ac = new AbortController();
	await main.callWith(ac.signal, { ids: ["W1"] }, (d) => (ac.abort(), d.options!.find((o) => o.includes("Deploy"))));
	assert.deepEqual(main.notices, ['main-1: The boss chose "Deploy" on wait W1: The main deploys.'], "the raiser is told once, as for any press");
	assert.equal(main.wait("wA", "W1").press!.main!.status, "delivered");
	// a press whose result came back is not sent twice
	const ok = harness({ scope: { kind: "raised", by: "main-1" } });
	ok.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await ok.callWith(new AbortController().signal, { ids: ["W1"] }, /1\) Deploy/);
	assert.deepEqual(ok.notices, []);
});

test("R2-F001: the 60 s quiet end is the option select's own, reset when a select reopens; a text field and the confirm wait up to 5 min per card", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	// a boss who has gone into the skip reason and types for 2 minutes is not cut off
	const pending = h.text({}, "Skip", HOLD);
	await until(() => h.dialogs.length === 2, "the reason field");
	h.advance(120_000);
	await h.look();
	assert.equal(h.dialogs[1]!.opts!.signal!.aborted, false, "a reason being typed is not quiet");
	h.advance(181_000);
	await h.look();
	assert.equal(h.dialogs[1]!.opts!.signal!.aborted, true, "5 minutes on a card is the cap");
	assert.match(await pending, /^W1: no answer/);
	// the select's age restarts when it reopens after a field the boss left (a skip not gone through with)
	const again = harness();
	again.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const p2 = again.text({}, "Skip", () => (again.advance(50_000), undefined), HOLD);
	await until(() => again.dialogs.length >= 3, "the select again");
	again.advance(50_000);
	await again.look();
	assert.equal(again.dialogs.at(-1)!.opts!.signal!.aborted, false, "50 s after the select reopened is not quiet");
	again.advance(11_000);
	await again.look();
	assert.equal(again.dialogs.at(-1)!.opts!.signal!.aborted, true);
	await p2;
});

test("R2-F002: a held notice expires after 25 min, goes once when the tool's result came back (cleared), and a stopped turn's notice is not worded as 'no wait_card follows'", async () => {
	const main = harness({ scope: { kind: "raised", by: "main-1" } });
	main.plant("wA", { id: "W1", card: card(CHOICE) as never });
	const ac = new AbortController();
	const out = await main.callWith(ac.signal, { ids: ["W1"] }, (d) => (ac.abort(), d.options!.find((o) => o.includes("Deploy"))));
	assert.doesNotMatch(String((out as { text?: string }).text ?? out), /no wait_card message follows/);
	// expiry: a notice held for more than 5 minutes is not sent
	const old = harness({ scope: { kind: "raised", by: "main-1" } });
	old.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await old.press("wA", { id: "W1", act: "choose", option: 0, asker: "main-1" }, "ask");
	old.advance(26 * 60_000);
	const gone = await lateNotice({ slot: old.slot, now: () => NOW + 26 * 60_000, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async (to, text) => (old.notices.push(`${to}: ${text}`), { status: "sent" }), boss: () => {}, autoOn: () => false }, "wA", { op: "wait-notice", id: "W1", asker: "main-1" }, "ask");
	assert.equal(gone.status, 409, "a notice older than 25 minutes is dropped");
	assert.deepEqual(old.notices, []);
	// a normal result clears the held notice, so a later wait-notice sends nothing
	const ok = harness({ scope: { kind: "raised", by: "main-1" } });
	ok.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await ok.callWith(new AbortController().signal, { ids: ["W1"] }, /1\) Deploy/);
	const late = await lateNotice({ slot: ok.slot, now: () => NOW, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async (to, text) => (ok.notices.push(`${to}: ${text}`), { status: "sent" }), boss: () => {}, autoOn: () => false }, "wA", { op: "wait-notice", id: "W1", asker: "main-1" }, "ask");
	assert.equal(late.status, 409);
	assert.deepEqual(ok.notices, []);
});

test("R3-F001: a wait-notice from another asker (clear or not) leaves the hold; the raiser's own call still sends the wait_card", async () => {
	const h = harness({ scope: { kind: "raised", by: "main-1" } });
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await h.press("wA", { id: "W1", act: "choose", option: 0, asker: "main-1" }, "ask");
	const deps = { slot: h.slot, now: () => NOW, log: { line() {}, hide() {} }, locale: "en" as const, live: async () => true, send: async (to: string, text: string) => (h.notices.push(`${to}: ${text}`), { status: "sent" }), boss: () => {}, autoOn: () => false };
	assert.equal((await lateNotice(deps, "wA", { op: "wait-notice", id: "W1", asker: "other", clear: true }, "ask")).status, 200);
	assert.equal((await lateNotice(deps, "wA", { op: "wait-notice", id: "W1", asker: "other" }, "ask")).status, 409);
	assert.deepEqual(h.notices, []);
	assert.equal((await lateNotice(deps, "wA", { op: "wait-notice", id: "W1", asker: "main-1" }, "ask")).status, 200);
	assert.equal(h.notices.length, 1);
});

test("R3-F002: a press on card 1, more than 5 min on later cards, then a stop: the raiser still gets the wait_card once; a stop during the clear is recovered", async () => {
	const main = harness({ scope: { kind: "raised", by: "main-1" } });
	main.plant("wA", { id: "W1", card: card(CHOICE) as never });
	main.plant("wA", { id: "W2", card: card(CHOICE) as never });
	const ac = new AbortController();
	await main.callWith(ac.signal, { ids: ["W1", "W2"] }, (d) => d.options!.find((o) => o.includes("Deploy")), (d) => (main.advance(7 * 60_000), ac.abort(), undefined));
	assert.equal(main.notices.filter((n) => n.includes("W1") || n.includes("wait W1")).length, 1);
	// the stop lands while the clear request is in flight
	const ac2 = new AbortController();
	const m2 = harness({ scope: { kind: "raised", by: "main-1" }, onClear: () => ac2.abort() });
	m2.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await m2.callWith(ac2.signal, { ids: ["W1"] }, (d) => d.options!.find((o) => o.includes("Deploy")));
	assert.equal(m2.notices.length, 1, "the held notice is recovered and sent");
});

test("RV-F001: two pressed cards, the stop lands during card 2's clear: the raiser gets both wait_cards once each; no stop, none", async () => {
	const ac = new AbortController();
	let clears = 0;
	const m = harness({ scope: { kind: "raised", by: "main-1" }, onClear: () => void (++clears === 2 && ac.abort()) });
	m.plant("wA", { id: "W1", card: card(CHOICE) as never });
	m.plant("wA", { id: "W2", card: card(CHOICE) as never });
	await m.callWith(ac.signal, { ids: ["W1", "W2"] }, (d) => d.options!.find((o) => o.includes("Deploy")), (d) => d.options!.find((o) => o.includes("Deploy")));
	assert.equal(m.notices.filter((n) => n.includes("W1")).length, 1, "card 1 recovered once");
	assert.equal(m.notices.filter((n) => n.includes("W2")).length, 1, "card 2 recovered once");
	const n = harness({ scope: { kind: "raised", by: "main-1" } });
	n.plant("wA", { id: "W1", card: card(CHOICE) as never });
	n.plant("wA", { id: "W2", card: card(CHOICE) as never });
	await n.callWith(new AbortController().signal, { ids: ["W1", "W2"] }, (d) => d.options!.find((o) => o.includes("Deploy")), (d) => d.options!.find((o) => o.includes("Deploy")));
	assert.deepEqual(n.notices, []);
});
