import assert from "node:assert/strict";
import { test } from "node:test";
import { type StandinFacts, standinMessage, standinReport, standinState } from "../src/server/standin.ts";

// The stand-in's state, one rule set for every look (src/server/standin.ts; docs/how-it-works.md, The standing pane). The boss's order (2026-11-26): working while the tower handles something, blocked only while
// wait cards wait for him, idle otherwise (Herdr shows done after it by itself); and nothing over a pane a run's pi or another agent holds, where Herdr's pi integration reports. Red on 0.96.1: a look whose gate said
// `run` reported nothing, so under headless runs (the viewer stays in the pane) a blocked from cards before the run stood with none open, and the stand-in had no working.

const base: StandinFacts = { verdict: "prompt", leaving: false, prompt: true, agent: "stand-in", working: false, cards: 0, attended: true };

test("standinState: the table of the boss's order, and who reports", () => {
	const rows: [string, Partial<StandinFacts>, ReturnType<typeof standinState>][] = [
		["between runs, nothing waits", {}, "idle"],
		["between runs, before the first report (no agent on the pane yet)", { agent: "none" }, "idle"],
		["between runs, a card waits", { cards: 2 }, "blocked"],
		["between runs, a card waits on an unattended device: nobody answers it", { cards: 2, attended: false }, "idle"],
		["headless run at work, the viewer polls", { verdict: "run", working: true }, "working"],
		["headless run at work while a card waits: the card outranks the work", { verdict: "run", working: true, cards: 1 }, "blocked"],
		["headless run at work, a card on an unattended device", { verdict: "run", working: true, cards: 1, attended: false }, "working"],
		["headless run idle (a conversation waits for the boss), no card: never blocked", { verdict: "run", working: false }, "idle"],
		["headless run idle, a card waits", { verdict: "run", cards: 1 }, "blocked"],
		["pane run waking, the prompt still polls before it is told to leave", { verdict: "run", working: true }, "working"],
		["pane run taking the pane: the stand-in is released", { verdict: "run", working: true, leaving: true }, undefined],
		["pane run whose pi holds the pane: Herdr's pi integration reports it", { verdict: "run", working: true, prompt: false, agent: "other" }, undefined],
		["a run and a pane whose prompt does not poll", { verdict: "run", working: true, prompt: false, agent: "none" }, undefined],
		["a run's pi with a card open: still the pi integration's", { verdict: "run", cards: 1, prompt: false, agent: "other" }, undefined],
		["another agent (a pi of the boss's own) holds the pane", { verdict: "agent", agent: "other", cards: 1 }, undefined],
		["held: a program of the boss's holds the pane", { verdict: "busy", cards: 1 }, undefined],
		["the prompt is gone and the command may be typed", { verdict: "launch-wait", prompt: false }, undefined],
		["parked by Ctrl+D", { verdict: "parked", prompt: false }, undefined],
		["the pane is not the tower's seat", { verdict: "unseated", cards: 1 }, undefined],
	];
	for (const [what, over, want] of rows) assert.equal(standinState({ ...base, ...over }), want, what);
});

test("standinMessage: the cards first, then working or standing by, then the other towers' cards, then held or the queue, in sb's language", () => {
	const standing = { state: "standing" as const, queued: 0 }, running = { state: "running" as const, queued: 0 };
	const rows: [Parameters<typeof standinMessage>[0], Parameters<typeof standinMessage>[1], string][] = [
		[standing, {}, "standing by"],
		[{ ...standing, queued: 3 }, {}, "3 queued"],
		[{ ...standing, state: "held", queued: 3 }, {}, "held"],
		[standing, { cards: 1 }, "1 card waits"],
		[{ ...standing, queued: 2 }, { cards: 3 }, "3 cards wait · 2 queued"],
		[{ ...standing, state: "held" }, { cards: 2 }, "2 cards wait · held"],
		[running, { working: true }, "working"],
		[{ ...running, queued: 1 }, { working: true }, "working · 1 queued"],
		[running, { working: true, cards: 2 }, "2 cards wait · working"],
		[running, {}, "standing by"],
		// AR-D2: the head counts only its own cards as blocking; the other towers' are a note
		[standing, { elsewhere: 3 }, "standing by · 3 cards wait at other towers"],
		[standing, { elsewhere: 1 }, "standing by · 1 card waits at another tower"],
		[running, { elsewhere: 3, working: true }, "working · 3 cards wait at other towers"],
		[{ ...standing, queued: 2 }, { cards: 1, elsewhere: 2 }, "1 card waits · 2 cards wait at other towers · 2 queued"],
		[standing, { locale: "zh-TW" }, "待命中"],
		[{ ...standing, queued: 1 }, { cards: 2, locale: "zh-TW" }, "2 張卡片等你 · 1 則待處理"],
		[{ ...standing, state: "held" }, { locale: "zh-TW" }, "已擱置"],
		[{ ...standing, state: "held" }, { elsewhere: 2, locale: "zh-TW" }, "其他塔台有 2 張卡片等你 · 已擱置"],
		[running, { working: true, cards: 1, locale: "zh-TW" }, "1 張卡片等你 · 處理中"],
		[undefined, {}, "standing by"],
	];
	for (const [status, words, want] of rows) assert.equal(standinMessage(status, words), want, JSON.stringify({ status, words }));
});

test("standinReport: the state and the message together, or nothing where the server reports none", () => {
	const status = { state: "running" as const, queued: 0 };
	assert.deepEqual(standinReport({ ...base, verdict: "run", working: true, cards: 1, status }), { state: "blocked", message: "1 card waits · working" });
	assert.deepEqual(standinReport({ ...base, verdict: "run", working: true, cards: 1, attended: false, status }), { state: "working", message: "1 card waits · working" }, "unattended: the count is still said");
	assert.deepEqual(standinReport({ ...base, verdict: "run", status, elsewhere: 2, locale: "zh-TW" }), { state: "idle", message: "待命中 · 其他塔台有 2 張卡片等你" });
	assert.equal(standinReport({ ...base, verdict: "run", leaving: true, working: true, status }), undefined);
});
