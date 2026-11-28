import assert from "node:assert/strict";
import { test } from "node:test";
import { foregroundOf, type IdleFacts, idleGate, type PaneFacts, paneGate, reopenGate, seatOpen, viewerGate } from "../src/server/towerstow.ts";

// The stow gates (src/server/towerstow.ts) say whether a tower's standing pane closes between runs (the boss's order of 2026-11-28: the pane stays only while a card waits for him). Each rule is pinned alone: a case in
// which only that rule keeps the pane (a rule dropped fails its case), and the order the rules are asked in (a rule moved fails a case where two of them keep it).

const idle = (over: Partial<IdleFacts> = {}): IdleFacts => ({ head: false, ready: true, cards: 0, state: "standing", run: false, queued: 0, soon: false, idleFor: 31_000, idleMs: 30_000, ...over });
const pane = (over: Partial<PaneFacts> = {}): PaneFacts => ({ pane: { agent: "tower" }, inTab: 1, inWorkspace: 2, parked: false, prompt: true, draft: false, foreground: "clean", ...over });

test("idleGate: an idle tower with no card stows; each rule alone keeps the pane, with its reason", () => {
	assert.deepEqual(idleGate(idle()), { stow: true });
	const cases: [Partial<IdleFacts>, string][] = [
		[{ head: true }, "head"],
		[{ ready: false }, "unready"],
		[{ cards: 1 }, "cards"],
		[{ run: true }, "run"],
		[{ state: "waking" }, "run"],
		[{ state: "running" }, "run"],
		[{ state: "closing" }, "run"],
		[{ state: "held" }, "held"],
		[{ queued: 1 }, "queued"],
		[{ soon: true }, "soon"],
		[{ idleFor: 29_999 }, "recent"],
	];
	for (const [over, why] of cases) assert.deepEqual(idleGate(idle(over)), { stow: false, why }, JSON.stringify(over));
});

test("idleGate: the head keeps its pane before any other rule, and a card keeps it before a run or the clock", () => {
	assert.deepEqual(idleGate(idle({ head: true, cards: 2, run: true })), { stow: false, why: "head" });
	assert.deepEqual(idleGate(idle({ head: true, ready: false })), { stow: false, why: "head" });
	assert.deepEqual(idleGate(idle({ cards: 1, run: true, idleFor: 0 })), { stow: false, why: "cards" });
	assert.deepEqual(idleGate(idle({ run: true, queued: 3, idleFor: 0 })), { stow: false, why: "run" });
	assert.deepEqual(idleGate(idle({ queued: 1, idleFor: 0 })), { stow: false, why: "queued" });
	// No state yet (the runs have not attached the service): no run is known to be live, and the clock decides.
	assert.deepEqual(idleGate(idle({ state: undefined })), { stow: true });
});

test("reopenGate: a standing pane always comes back; under headless runs only a viewer the idle close took, and only on an attended device (the boss's order of 2026-11-28)", () => {
	const cases: [{ headless: boolean; stowed: boolean; attended: boolean }, boolean][] = [
		[{ headless: false, stowed: false, attended: false }, true],
		[{ headless: false, stowed: true, attended: false }, true],
		[{ headless: true, stowed: true, attended: true }, true],
		[{ headless: true, stowed: true, attended: false }, false],
		[{ headless: true, stowed: false, attended: true }, false],
		[{ headless: true, stowed: false, attended: false }, false],
	];
	for (const [f, open] of cases) assert.equal(reopenGate(f), open, JSON.stringify(f));
});

test("viewerGate: a headless ensure-tower makes a viewer on Open viewer wherever none stands, and on a plain attended ensure only with the service it makes (the viewer flap of 2026-11-28)", () => {
	const cases: [Parameters<typeof viewerGate>[0], boolean][] = [
		[{ asked: "attended", attended: true, service: "none" }, true],
		[{ asked: "attended", attended: false, service: "none" }, false],
		[{ asked: "attended", attended: true, service: "tabless" }, false],
		[{ asked: "attended", attended: true, service: "tab" }, false],
		[{ asked: true, attended: false, service: "none" }, true],
		[{ asked: true, attended: true, service: "tabless" }, true],
		[{ asked: true, attended: true, service: "tab" }, false],
		[{ asked: false, attended: true, service: "none" }, false],
		[{ asked: false, attended: true, service: "tabless" }, false],
	];
	for (const [f, open] of cases) assert.equal(viewerGate(f), open, JSON.stringify(f));
});

test("paneGate: a lone standing pane with the prompt at rest stows; each rule alone keeps it, with its reason", () => {
	assert.deepEqual(paneGate(pane()), { stow: true });
	assert.deepEqual(paneGate(pane({ pane: { agent: undefined } })), { stow: true }, "the stand-in lapsed while the prompt polls: still the tower's");
	const cases: [Partial<PaneFacts>, string][] = [
		[{ pane: undefined }, "gone"],
		[{ pane: { agent: "pi" } }, "agent"],
		[{ inTab: 2 }, "tab"],
		[{ inWorkspace: 1 }, "last"],
		[{ parked: true }, "parked"],
		[{ prompt: false }, "prompt"],
		[{ draft: true }, "draft"],
		[{ foreground: "program" }, "program"],
		[{ foreground: "unknown" }, "unknown"],
	];
	for (const [over, why] of cases) assert.deepEqual(paneGate(pane(over)), { stow: false, why }, JSON.stringify(over));
});

test("paneGate: a pi the boss typed by hand keeps the pane before its tab; a split keeps it before the workspace's last-pane rule", () => {
	assert.deepEqual(paneGate(pane({ pane: { agent: "pi" }, inTab: 2, inWorkspace: 2 })), { stow: false, why: "agent" });
	assert.deepEqual(paneGate(pane({ inTab: 2, inWorkspace: 2 })), { stow: false, why: "tab" });
	assert.deepEqual(paneGate(pane({ inWorkspace: 1, parked: true })), { stow: false, why: "last" });
	assert.deepEqual(paneGate(pane({ parked: true, prompt: false })), { stow: false, why: "parked" });
	assert.deepEqual(paneGate(pane({ prompt: false, draft: true })), { stow: false, why: "prompt" });
});

test("foregroundOf: only the pane's shell and the tower prompt are clean; a program, or a list Herdr did not give, keeps the pane", () => {
	const prompt = { pid: 9, name: "node", cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` };
	assert.equal(foregroundOf({ foreground_processes: [prompt] }, "wA"), "clean");
	assert.equal(foregroundOf({ shell_pid: 5, foreground_processes: [{ pid: 5, name: "zsh" }, prompt] }, "wA"), "clean");
	assert.equal(foregroundOf({ foreground_processes: [{ pid: 9, name: "node", cmdline: "node prompt-like.js" }] }, "wA", 9), "clean", "the pid that polled is the prompt");
	assert.equal(foregroundOf({ shell_pid: 5, foreground_processes: [{ pid: 5, name: "powershell.exe" }] }, "wA"), "clean", "Windows lists the shell alone under the prompt");
	assert.equal(foregroundOf({ foreground_processes: [{ ...prompt, cmdline: prompt.cmdline.replace("wA", "wB") }] }, "wA"), "program", "another tower's prompt is no prompt of this pane");
	assert.equal(foregroundOf({ shell_pid: 5, foreground_processes: [{ pid: 5, name: "zsh" }, { pid: 11, name: "vim" }] }, "wA"), "program");
	assert.equal(foregroundOf({ shell_pid: 5, foreground_processes: [{ pid: 12, name: "bash" }] }, "wA"), "program", "a nested shell is the boss's");
	assert.equal(foregroundOf({ foreground_processes: [] }, "wA"), "unknown");
	assert.equal(foregroundOf(undefined, "wA"), "unknown");
});

test("seatOpen: a stowed tower opens its pane in its own workspace; after a Herdr restart only a workspace that still carries its label is its own", () => {
	assert.equal(seatOpen({ seated: true, label: "Alpha", record: "Alpha" }), "open");
	assert.equal(seatOpen({ seated: true, label: "Renamed", record: "Alpha" }), "open", "a rename while this Herdr runs changes nothing");
	assert.equal(seatOpen({ seated: false, label: "Alpha", record: "Alpha" }), "open");
	assert.equal(seatOpen({ seated: false, label: "Someone else's", record: "Alpha" }), "stranger");
	assert.equal(seatOpen({ seated: true, label: undefined, record: "Alpha" }), "gone");
});
