import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { underBoss } from "../src/autoscope.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { Here } from "../src/heremark.ts";
import type { Slot } from "../src/server/record.ts";
import { type Entry, iso, loadMemory, memoryRequest, updateMemory } from "../src/server/towermemory.ts";
import { pressRequest } from "../src/server/waitpress.ts";
import { waitList } from "../src/server/waitlist.ts";
import { World } from "./fakes.ts";
import { parseWaitArgs, runWaitCommand, type WaitCmdDeps } from "../src/waitcmd.ts";

// `/boss wait` (docs/specs/2026-11-10-wait-cards-tui.md, §2; todo #144 task 2): the boss picks a card and an act in terminal-only dialogs and the press is the one op `/boss memory` makes. The server functions are the real ones
// (the list, the press); the dialogs are a script.

const NOW = Date.parse("2026-11-10T10:00:00Z");
const NO_RELAY = Symbol.for("pi-straw-boss.no-relay");
const FROM = { id: "main-1", name: "mp3946-print", role: "main", workspace: "Alpha", tab: "MP-3946" };
const card = (over: Record<string, unknown> = {}) => ({ type: "action", lang: "en", happened: "The key expired.", do: "Re-authorize the machine.", url: "https://login.example/admin", after: "The tower asks the main to test.", from: FROM, ...over });
const CHOICE = { type: "choice", do: "Deploy the build now?", options: [{ label: "Deploy", then: "The main deploys." }, { label: "Hold", then: "The main waits." }] };
const SECRET = { type: "secret", do: "Create a key and enter it.", secret: { name: "the auth key" } };

type Dialog = { kind: "select" | "input" | "confirm"; title: string; options?: string[]; opts: { signal?: AbortSignal } | undefined; boss: boolean; here: boolean };
/** A script for the dialogs: each entry answers the next dialog (a function sees its options and picks one by text). */
type Step = string | RegExp | ((d: Dialog) => string | boolean | undefined) | undefined | boolean;

function harness(over: { lang?: "en" | "zh-TW"; interactive?: boolean; auto?: boolean; own?: string; hereFails?: boolean; head?: boolean } = {}) {
	const slot = { dir: mkdtempSync(join(tmpdir(), "psb-waitcmd-")) } as Slot, told: { text: string; level: string }[] = [], dialogs: Dialog[] = [], sent: Record<string, unknown>[] = [], asked: Record<string, unknown>[] = [], focused: string[] = [];
	const events: string[] = [], notices: string[] = [];
	let hereOpen = false, script: Step[] = [], reads = 0, auto = over.auto === true;
	const here: Here = async (fn) => {
		if (over.hereFails) throw new Error("This asks on this computer only, and the pane could not be marked as local-only; nothing was asked.");
		hereOpen = true;
		try { return await fn(); } finally { hereOpen = false; }
	};
	const answer = (d: Dialog): string | boolean | undefined => {
		const step = script.shift();
		if (typeof step === "function") return step(d);
		if (!d.options && typeof step === "string") return step; // an input's text
		if (typeof step === "string" || step instanceof RegExp) {
			const found = d.options?.find((o) => (typeof step === "string" ? o.includes(step) : step.test(o)));
			assert.ok(found, `a dialog "${d.title.split("\n")[0]}" offers ${String(step)}: ${JSON.stringify(d.options)}`);
			return found;
		}
		return step;
	};
	const record = (kind: Dialog["kind"], title: string, options: string[] | undefined, opts: { signal?: AbortSignal } | undefined) => ({ kind, title, ...(options ? { options } : {}), opts, boss: underBoss(), here: hereOpen }) as Dialog;
	const deps: WaitCmdDeps = {
		lang: over.lang ?? "en", interactive: over.interactive ?? true, own: over.own, now: () => NOW, here, tell: (text, level = "info") => void told.push({ text, level }),
		ui: {
			select: async (title, options, opts) => (dialogs.push(record("select", title, options, opts)), answer(dialogs.at(-1)!) as string | undefined),
			input: async (title, _ph, opts) => (dialogs.push(record("input", title, undefined, opts)), answer(dialogs.at(-1)!) as string | undefined),
			confirm: async (title, _msg, opts) => (dialogs.push(record("confirm", title, undefined, opts)), answer(dialogs.at(-1)!) === true),
		},
		ask: async (request) => {
			asked.push(request);
			if (request.cmd === "boss-waits") {
				reads++;
				try {
					return { ok: true, ...waitList({ slot, now: () => NOW, locale: over.lang ?? "en", auto: () => ({ on: auto }) }, [{ workspace: "wA", label: "Alpha" }, { workspace: "wB", label: "Beta" }], over.head ? { at: "wH" } : undefined, typeof request.workspace === "string" ? request.workspace : undefined, typeof request.own === "string" ? request.own : undefined) };
				} catch (error) {
					return { ok: false, error: (error as Error).message };
				}
			}
			return { ok: true, answered: request.answers, queued: "e1" };
		},
		memory: async (workspace, json) => (sent.push({ workspace, ...json }), json.op === "press"
			? { ok: true, ...(await pressRequest({ slot, now: () => NOW, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async (to, text) => (notices.push(`${to}: ${text}`), { status: "sent" }), boss: (text) => void events.push(text), autoOn: () => auto }, workspace, json)) }
			: { ok: true, ...memoryRequest(slot, workspace, NOW, json) }),
		workspaces: async () => [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wB", label: "Beta" }, { workspace_id: "wH", label: "Head ws", tokens: { sb_head: "sb-head" } }],
		tabs: async (ws) => (ws === "wA" ? [{ tab_id: "wA:t1", label: "MP-3946" }, { tab_id: "wA:t2", label: "other" }] : ws === "wB" ? [{ tab_id: "wB:t1", label: "MP-3946" }] : []),
		focus: async (tab) => void focused.push(tab),
	};
	const plant = (key: string, e: Partial<Entry> & { id: string }) => updateMemory(slot, key, NOW, (m) => void m.entries.push({ kind: "wait", text: String(e.card?.do ?? "a wait"), by: "run", via: "run", at: iso(NOW - 12 * 60_000), run: "r1", for: "boss", state: "open", ...e } as Entry));
	return {
		slot, told, dialogs, sent, asked, focused, events, notices, deps, plant, reads: () => reads, setAuto: (on: boolean) => void (auto = on),
		run: (args: string, ...steps: Step[]) => ((script = steps), runWaitCommand(args, deps)),
		last: () => told.at(-1)!,
		wait: (ws: string, id: string) => loadMemory(slot, ws).memory.entries.find((e) => e.id === id)!,
	};
}
const cardSelects = (h: ReturnType<typeof harness>) => h.dialogs.filter((d) => d.kind === "select");

test("the arguments: nothing, or -w with one workspace; anything else is the usage", () => {
	assert.deepEqual(parseWaitArgs(""), {});
	assert.deepEqual(parseWaitArgs("  "), {});
	assert.deepEqual(parseWaitArgs("-w Alpha"), { workspace: "Alpha" });
	assert.deepEqual(parseWaitArgs("-w head"), { workspace: "head" });
	for (const bad of ["-w", "W3", "list", "-w a b", "done W1"]) assert.equal("usage" in parseWaitArgs(bad), true, bad);
});

test("no card is open: it says so and opens no dialog; a bad argument is the usage", async () => {
	const h = harness();
	await h.run("");
	assert.deepEqual(h.told, [{ text: "No wait card is open for you.", level: "info" }]);
	assert.equal(h.dialogs.length, 0);
	await h.run("frob");
	assert.match(h.last().text, /^Usage: \/boss wait/);
	const zh = harness({ lang: "zh-TW" });
	await zh.run("");
	assert.equal(zh.last().text, "沒有等你處理的卡片。");
});

test("the list: one row per card across the towers and the head, the pane's own tower first, with the tower, what you do, the raiser, the age, parked, and answered; a single card skips the list", async () => {
	const h = harness({ own: "wB", head: true });
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card({ do: "Second thing" }) as never, parked: true });
	h.plant("wB", { id: "W1", card: card({ do: "Beta thing" }) as never, state: "answered", answered: iso(NOW) });
	h.plant(HEAD_KEY, { id: "W1", card: card({ do: "Head thing" }) as never });
	await h.run("", undefined);
	const list = h.dialogs[0]!;
	assert.equal(list.title, "Waits for you (4)");
	assert.deepEqual(list.options, [
		"1. [Beta] Needs you: Beta thing · from mp3946-print · 12 min ago (you replied)",
		"2. [head tower] Needs you: Head thing · from mp3946-print · 12 min ago",
		"3. [Alpha] [parked] Needs you: Second thing · from mp3946-print · 12 min ago",
		"4. [Alpha] Needs you: Re-authorize the machine. · from mp3946-print · 12 min ago",
	]);
	assert.equal(h.told.length, 0, "Escape on the list leaves with nothing said or sent");
	assert.equal(h.sent.length, 0);
	// a single card goes straight to its acts
	const one = harness();
	one.plant("wA", { id: "W1", card: card() as never });
	await one.run("", undefined);
	assert.equal(one.dialogs.length, 1);
	assert.match(one.dialogs[0]!.title, /^\[Alpha\] W1\nWhat happened: The key expired\./);
	// -w names one tower, by id, by label, or head (also by the head's own Herdr workspace)
	for (const [q, only] of [["Beta", "wB"], ["wB", "wB"], ["head", "head"], ["wH", "head"]] as const) {
		const w = harness({ head: true });
		w.plant("wB", { id: "W1", card: card({ do: "b" }) as never });
		w.plant(HEAD_KEY, { id: "W1", card: card({ do: "h" }) as never });
		await w.run(`-w ${q}`, undefined);
		assert.deepEqual(w.asked[0], { cmd: "boss-waits", workspace: only }, q);
	}
	await one.run("-w Nowhere");
	assert.match(one.last().text, /No workspace matches "Nowhere"/);
	assert.equal(one.last().level, "error");
});

test("the card is the title of the second dialog: what happened, what you do, where, after that, who raised it; a command keeps its lines", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card({ command: "cd /srv\nmake deploy" }) as never });
	await h.run("", undefined);
	assert.equal(h.dialogs[0]!.title, ["[Alpha] W1", "What happened: The key expired.", "What you do: Re-authorize the machine.", "Where: https://login.example/admin", "Run:", "  cd /srv", "  make deploy", "After that: The tower asks the main to test.", "Raised by: mp3946-print"].join("\n"));
});

test("the acts follow the card's kind and state; a card already pressed keeps only the reply, the switch, and the way back", async () => {
	const acts = async (e: Partial<Entry> & { id: string }, over: Parameters<typeof harness>[0] = {}) => {
		const h = harness(over);
		h.plant("wA", e);
		await h.run("", undefined);
		return h.dialogs[0]!.options!;
	};
	const tail = ["Skip", "Reply to the tower", "Switch to mp3946-print's tab", "Back"];
	assert.deepEqual(await acts({ id: "W1", card: card() as never }), ["I'm done", ...tail]);
	assert.deepEqual(await acts({ id: "W1", card: card(CHOICE) as never }), ["1) Deploy — The main deploys.", "2) Hold — The main waits.", ...tail]);
	assert.deepEqual(await acts({ id: "W1", card: card(SECRET) as never }), ["Start entering (asks mp3946-print to open the entry box)", ...tail]);
	assert.deepEqual(await acts({ id: "W1", card: card(SECRET) as never, press: { act: "secret", at: iso(NOW), secretAsked: iso(NOW) } as never }), ["I entered it", ...tail]);
	assert.deepEqual(await acts({ id: "W1", text: "old words" }), ["Ask the tower to rewrite it as a card", "Skip", "Reply to the tower", "Back"], "a legacy wait has no raiser to switch to");
	assert.deepEqual(await acts({ id: "W1", card: card() as never, state: "answered", press: { act: "done", at: iso(NOW) } as never }), tail.slice(1), "pressed: reply, switch, back");
	assert.deepEqual(await acts({ id: "W1", card: card({ from: { ...FROM, gone: true } }) as never }), ["I'm done", "Skip", "Reply to the tower", "Back"], "a raiser that is gone has no tab");
	assert.deepEqual((await acts({ id: "W1", card: card() as never }, { lang: "zh-TW" })), ["我做完了", "略過", "回覆塔台", "切到 mp3946-print 的分頁", "返回"]);
});

test("done presses the card with one request as /boss memory does, says who was told, and ends there for a single card", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	await h.run("", "I'm done");
	assert.deepEqual(h.sent, [{ workspace: "wA", op: "press", id: "W1", act: "done" }]);
	assert.equal(h.last().text, "W1 done: mp3946-print was told.");
	assert.equal(h.wait("wA", "W1").state, "answered");
	assert.equal(h.dialogs.length, 1);
});

test("choose sends the option's index (from 0, as the server takes it), and the result line names the option", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(CHOICE) as never });
	await h.run("", /2\) Hold/);
	assert.deepEqual(h.sent, [{ workspace: "wA", op: "press", id: "W1", act: "choose", option: 1 }]);
	assert.match(h.last().text, /^W1 chose "Hold": /);
});

test("the secret's first step and its end: start entering presses `secret`, I entered it presses `done`", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card(SECRET) as never });
	await h.run("", /^Start entering/);
	assert.deepEqual(h.sent, [{ workspace: "wA", op: "press", id: "W1", act: "secret" }]);
	assert.match(h.last().text, /^W1 asked mp3946-print to open the entry box/);
	await h.run("", "I entered it");
	assert.deepEqual(h.sent.at(-1), { workspace: "wA", op: "press", id: "W1", act: "done" });
});

test("a legacy wait is restated; the press is the same op", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", text: "old free text" });
	await h.run("", /^Ask the tower to rewrite/);
	assert.deepEqual(h.sent, [{ workspace: "wA", op: "press", id: "W1", act: "restate" }]);
	assert.match(h.last().text, /^W1 asked the tower to record it again/);
});

test("skip asks a reason, then confirms; only a Yes sends the press; the reason rides on it; a No, or Escape at the reason, sends nothing", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	await h.run("", "Skip", "no time this week", true);
	assert.deepEqual(h.dialogs.map((d) => d.kind), ["select", "input", "confirm"]);
	assert.equal(h.dialogs[1]!.title, "Reason (optional)");
	assert.equal(h.dialogs[2]!.title, "Skip this?");
	assert.deepEqual(h.sent, [{ workspace: "wA", op: "press", id: "W1", act: "decline", reason: "no time this week" }]);
	assert.equal(h.wait("wA", "W1").state, "resolved");
	const no = harness();
	no.plant("wA", { id: "W1", card: card() as never });
	// No at the confirm: the picker comes back to the card, which the boss leaves with Escape
	await no.run("", "Skip", "", false, undefined);
	assert.equal(no.sent.length, 0, "a No sends nothing");
	assert.equal(no.wait("wA", "W1").state, "open");
	const esc = harness();
	esc.plant("wA", { id: "W1", card: card() as never });
	await esc.run("", "Skip", undefined, undefined);
	assert.equal(esc.sent.length, 0, "Escape at the reason sends nothing");
	assert.equal(esc.dialogs.filter((d) => d.kind === "confirm").length, 0, "no confirm after an Escape at the reason");
	// an empty reason is no reason
	const blank = harness();
	blank.plant("wA", { id: "W1", card: card() as never });
	await blank.run("", "Skip", "   ", true);
	assert.deepEqual(blank.sent, [{ workspace: "wA", op: "press", id: "W1", act: "decline" }]);
});

test("reply goes to the tower as the boss's words with `answers`; the head's goes as a head event; a refusal is shown", async () => {
	const h = harness({ head: true });
	h.plant("wA", { id: "W1", card: card() as never });
	await h.run("", /^Reply to the tower/, "  do it on Monday  ");
	assert.deepEqual(h.asked.at(-1), { cmd: "tower-event", workspace: "wA", text: "do it on Monday", present: true, answers: "W1" });
	assert.equal(h.last().text, "Handed to the tower. W1 is marked answered.");
	assert.equal(h.sent.length, 0, "a reply is no press");
	const head = harness({ head: true });
	head.plant(HEAD_KEY, { id: "W1", card: card() as never });
	await head.run("", /^Reply to the head tower/, "go");
	assert.deepEqual(head.asked.at(-1), { cmd: "head-event", text: "go", answers: "W1" });
	// an empty reply sends nothing
	const empty = harness();
	empty.plant("wA", { id: "W1", card: card() as never });
	await empty.run("", /^Reply to the tower/, "  ", undefined);
	assert.equal(empty.asked.filter((r) => r.cmd === "tower-event").length, 0);
});

test("switch focuses the raiser's tab and writes nothing", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	await h.run("", /^Switch to mp3946-print/);
	assert.deepEqual(h.focused, ["wA:t1"], "the tab of that name in the raiser's workspace");
	assert.equal(h.sent.length, 0);
	assert.equal(h.asked.filter((r) => r.cmd !== "boss-waits").length, 0);
	// a tab that is gone, or a name two tabs carry (the workspace is not named), is said and nothing is switched
	const gone = harness();
	gone.plant("wA", { id: "W1", card: card({ from: { ...FROM, tab: "closed-tab" } }) as never });
	await gone.run("", /^Switch to/);
	assert.deepEqual(gone.focused, []);
	assert.match(gone.last().text, /tab was not found/);
	const twice = harness();
	twice.plant("wA", { id: "W1", card: card({ from: { ...FROM, workspace: undefined } }) as never });
	await twice.run("", /^Switch to/);
	assert.deepEqual(twice.focused, []);
	assert.match(twice.last().text, /More than one tab/);
});

// --- one card after another (docs/specs/2026-11-16-wait-cards-flow.md, B) ---------------------------------------------------------------------------------------------

/** Three cards of one tower; the list shows the newest first: third (W3), second (W2), first (W1). */
const three = (over: Parameters<typeof harness>[0] = {}) => {
	const h = harness(over);
	h.plant("wA", { id: "W1", card: card({ do: "first" }) as never });
	h.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	h.plant("wA", { id: "W3", card: card({ do: "third" }) as never });
	return h;
};
const cardOf = (d: Dialog) => /^(?:\[Alpha\]|［Alpha］) (W\d+)/.exec(d.title)?.[1];

test("after a press the next card's dialog opens with no list between: three cards are answered one after another in the list's order, around its end, and the picker ends when none is left", async () => {
	const h = three();
	await h.run("", /second/, "I'm done", "I'm done", "I'm done");
	assert.deepEqual(h.dialogs.map((d) => cardOf(d) ?? d.title), ["Waits for you (3)", "W2", "W1", "W3"], "the list once, then each card's own dialog");
	assert.deepEqual(h.sent.map((s) => s.id), ["W2", "W1", "W3"]);
	assert.deepEqual(h.told.map((t) => t.text), ["W2 done: mp3946-print was told.", "W1 done: mp3946-print was told.", "W3 done: mp3946-print was told."], "each press says its own line, and nothing is said when none is left");
	for (const id of ["W1", "W2", "W3"]) assert.equal(h.wait("wA", id).state, "answered");
});

test("a skip and a reply go on to the next card too; a card that already carries a final press is passed over, and one the boss answered in this picker is not offered again", async () => {
	const h = three();
	h.plant("wA", { id: "W4", card: card({ do: "pressed before" }) as never, state: "answered", press: { act: "done", at: iso(NOW) } as never });
	// the list: W4 (pressed), W3, W2, W1. Skip W3, reply to W2, then W1 is the only one left; after it nothing is.
	await h.run("", /third/, "Skip", "", true, /^Reply to the tower/, "on Monday", "I'm done");
	assert.deepEqual(h.dialogs.filter((d) => d.kind === "select").map((d) => cardOf(d) ?? d.title), ["Waits for you (4)", "W3", "W2", "W1"]);
	assert.deepEqual(h.sent.map((s) => [s.id, s.act]), [["W3", "decline"], ["W1", "done"]]);
	assert.equal(h.asked.filter((r) => r.cmd === "tower-event").length, 1);
});

test("a card among others offers Next card and All cards: Next moves on with nothing pressed, All cards returns to the list; a single card has neither and keeps Back", async () => {
	const h = three();
	await h.run("", /third/, "Next card", "Next card", "All cards", undefined);
	assert.deepEqual(h.dialogs.map((d) => cardOf(d) ?? d.title), ["Waits for you (3)", "W3", "W2", "W1", "Waits for you (3)"]);
	assert.deepEqual(h.dialogs[1]!.options, ["I'm done", "Skip", "Reply to the tower", "Switch to mp3946-print's tab", "Next card", "All cards"]);
	assert.equal(h.sent.length, 0, "moving between cards presses nothing");
	assert.equal(h.told.length, 0);
	// the last card that still waits has no next: only the way to the list
	const last = three();
	await last.run("", /third/, "I'm done", "I'm done", undefined, undefined);
	assert.deepEqual(last.dialogs[3]!.options, ["I'm done", "Skip", "Reply to the tower", "Switch to mp3946-print's tab", "All cards"]);
	const zh = three({ lang: "zh-TW" });
	await zh.run("", /third/, "下一張", "全部卡片", undefined);
	assert.deepEqual(zh.dialogs[1]!.options!.slice(-2), ["下一張", "全部卡片"]);
	assert.deepEqual(zh.dialogs.map((d) => cardOf(d) ?? d.title), ["等你處理（3）", "W3", "W2", "等你處理（3）"]);
});

test("a press the server refuses shows the server's reason and the list is read again", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card({ do: "other" }) as never });
	// the boss opens the picker, then the card is pressed elsewhere before they press it here
	let first = true;
	const before = h.deps.memory;
	h.deps.memory = async (ws, json) => {
		if (first) { first = false; await before(ws, json); }
		return before(ws, json);
	};
	await h.run("", /Re-authorize/, "I'm done", undefined);
	assert.equal(h.last().level, "error");
	assert.match(h.last().text, /^W1 was pressed already: I'm done at \d\d:\d\d \(the list is read again\)$/);
	assert.equal(h.reads(), 2, "the list was read again");
});

test("auto mode: parked cards are listed and pressable; start entering is left out, with the line; a press goes through", async () => {
	const h = harness({ auto: true });
	h.plant("wA", { id: "W1", card: card(SECRET) as never, parked: true });
	await h.run("", undefined);
	assert.deepEqual(h.dialogs[0]!.options, ["Skip", "Reply to the tower", "Switch to mp3946-print's tab", "Back"]);
	assert.match(h.dialogs[0]!.title, /Parked for your return\./);
	assert.match(h.dialogs[0]!.title, /Start entering is off while auto mode is on: \/boss auto off first\.$/);
	const zh = harness({ auto: true, lang: "zh-TW" });
	zh.plant("wA", { id: "W1", card: card(SECRET) as never });
	await zh.run("", undefined);
	assert.match(zh.dialogs[0]!.title, /自動模式開著時不能開始輸入密鑰：先 \/boss auto off。$/);
	const press = harness({ auto: true });
	press.plant("wA", { id: "W1", card: card() as never, parked: true });
	await press.run("", "I'm done");
	assert.match(press.last().text, /^W1 done: /);
	const list = harness({ auto: true });
	list.plant("wA", { id: "W1", card: card() as never, parked: true });
	list.plant("wA", { id: "W2", card: card() as never });
	await list.run("", undefined);
	assert.match(list.dialogs[0]!.options![1]!, /^2\. \[Alpha\] \[parked\] /);
});

test("every dialog is terminal-only, under the boss's mark, inside the here mark; a pane that cannot be marked refuses and asks nothing; a session without a screen is refused", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card() as never });
	h.plant("wA", { id: "W2", card: card({ do: "second" }) as never });
	await h.run("", /Re-authorize/, "Skip", "why", true, undefined);
	assert.deepEqual(h.dialogs.map((d) => d.kind), ["select", "select", "input", "confirm", "select"]);
	assert.match(h.dialogs[4]!.title, /^\[Alpha\] W2\n/, "the last one is the next card's, which is the only one left");
	for (const d of h.dialogs) {
		assert.ok(d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY), `${d.kind} "${d.title.split("\n")[0]}" is terminal-only`);
		assert.equal(d.boss, true, `${d.kind} runs under the boss's mark`);
		assert.equal(d.here, true, `${d.kind} opens inside the here mark`);
	}
	const reply = harness();
	reply.plant("wA", { id: "W1", card: card() as never });
	await reply.run("", /^Reply/, "words");
	assert.deepEqual(reply.dialogs.map((d) => [d.kind, d.here, Boolean(d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY))]), [["select", true, true], ["input", true, true]]);
	const refused = harness({ hereFails: true });
	refused.plant("wA", { id: "W1", card: card() as never });
	await refused.run("", "I'm done");
	assert.equal(refused.dialogs.length, 0, "a refused mark asks nothing");
	assert.equal(refused.sent.length, 0);
	assert.equal(refused.last().level, "error");
	assert.match(refused.last().text, /could not be marked as local-only/);
	const noScreen = harness({ interactive: false });
	noScreen.plant("wA", { id: "W1", card: card() as never });
	await noScreen.run("", "I'm done");
	assert.equal(noScreen.dialogs.length, 0);
	assert.equal(noScreen.asked.length, 0, "nothing is even read");
	assert.equal(noScreen.last().level, "error");
	assert.match(noScreen.last().text, /only in a pi session with a screen/);
});

test("the text of a card is cleaned again before it is drawn: an escape in the list or the card title never reaches the terminal", async () => {
	const h = harness();
	h.plant("wA", { id: "W1", card: card({ do: "fix\x1b[2J it", happened: "bad\x1b]0;x\x07 news", from: { ...FROM, name: "ma\x1bin" } }) as never });
	// the harness's list is the real one, which cleans; a server that did not (an older one) is cleaned here too
	const before = h.deps.ask;
	h.deps.ask = async (request) => {
		const got = await before(request);
		if (request.cmd !== "boss-waits") return got;
		const towers = got.towers as { waits: { card: { do: string; from: { name: string } } }[] }[];
		towers[0]!.waits[0]!.card.do = "fix\x1b[2J it";
		towers[0]!.waits[0]!.card.from.name = "ma\x1bin";
		return got;
	};
	await h.run("", undefined);
	const drawn = JSON.stringify(h.dialogs);
	assert.equal(/\\u001b|\\u0007/.test(drawn), false, drawn);
	assert.match(h.dialogs[0]!.title, /What you do: fix\[2J it/);
});

test("in a pi session /boss wait is a command the harness runs: without the sb server it says so, and Tab completes it", async () => {
	const world = new World();
	try {
		const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
		await a.start();
		await a.command("wait");
		assert.deepEqual(a.notices.at(-1), { text: "The sb server is not available in this session.", level: "warning" });
		const completions = (a.commands.get("boss") as unknown as { getArgumentCompletions(prefix: string): { value: string }[] | null }).getArgumentCompletions("wa");
		assert.deepEqual(completions?.map((c) => c.value), ["wait"]);
		assert.match(String((a.commands.get("boss") as unknown as { description: string }).description), /\/boss wait lists the wait cards/);
	} finally {
		await world.stopAll();
	}
});
