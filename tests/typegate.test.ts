import assert from "node:assert/strict";
import { test } from "node:test";
import { claimGate, giveBackGate, handGate, holdGate, idleShell, type NoReason, proofGate, refusedGate, retryGate, runEndGate, seatGate, settleGate, tableGate, type TypeFacts, typeGate } from "../src/server/typegate.ts";
import { TOWER_LABEL } from "../src/herdr.ts";

// The gate (src/server/typegate.ts) is the one place that says whether the server may type the tower prompt's command into a standing pane. Each rule is pinned alone here: a case in which only that rule says no
// (a rule dropped fails its case), and the order in which the rules are asked (a rule moved fails the case that has two of them say no).

const idleDarwin = { shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [{ pid: 5, name: "zsh" }] };
const runningDarwin = { shell_pid: 5, foreground_process_group_id: 9, foreground_processes: [{ pid: 9, name: "node" }] };
const shellAlone = { shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [{ pid: 5, name: "powershell.exe" }] };
const shellAndProgram = { foreground_processes: [{ pid: 5, name: "powershell.exe" }, { pid: 9, name: "node.exe" }] };

/** The pane every rule lets through: a typeable one. `calls` lists the facts the gate asked, in order. */
function facts(over: Partial<TypeFacts> = {}, win = false): { f: TypeFacts; calls: string[] } {
	const calls: string[] = [];
	const f: TypeFacts = {
		attached: true,
		seated: () => true,
		groups: !win,
		busy: false,
		held: false,
		run: false,
		agent: "none",
		prompt: () => false,
		gone: async () => void calls.push("gone"),
		parked: () => (calls.push("parked"), false),
		runSoon: () => (calls.push("runSoon"), false),
		launchWait: () => (calls.push("launchWait"), false),
		command: () => (calls.push("command"), true),
		settle: () => (calls.push("settle"), { hand: false, giveUp: false }),
		fresh: () => (calls.push("fresh"), true),
		read: async () => (calls.push("read"), win ? shellAlone : idleDarwin),
		...over,
	};
	return { f, calls };
}

test("typeGate: a pane no rule says no to is typed into, on macOS by the groups and on Windows once it is known fresh", async () => {
	assert.deepEqual(await typeGate(facts().f), { type: true });
	assert.deepEqual(await typeGate(facts({}, true).f), { type: true });
});

// One row per rule: the facts that make only that rule say no.
const rules: [NoReason, Partial<TypeFacts>, boolean?][] = [
	["absent", { attached: false }],
	["unseated", { seated: () => false }],
	["busy", { busy: true }],
	["run", { run: true }],
	["agent", { agent: "other" }],
	["prompt", { prompt: () => true }],
	["parked", { parked: () => true }],
	["run-soon", { runSoon: () => true }],
	["launch-wait", { launchWait: () => true }],
	["stand-in", { agent: "stand-in" }],
	["no-command", { command: () => false }],
	["hand", { settle: () => ({ hand: true, giveUp: false }) }],
	["gave-up", { settle: () => ({ hand: false, giveUp: true }) }],
	["held", { held: true }, true],
	["unproven", { fresh: () => false }, true],
	["not-idle", { read: async () => runningDarwin }],
	["not-idle", { read: async () => undefined }],
	["not-idle", { read: async () => shellAndProgram }, true],
];
for (const [reason, over, win] of rules) {
	test(`typeGate: ${reason} says no (${Object.keys(over).join(", ")}${win ? ", Windows" : ""})`, async () => {
		assert.deepEqual(await typeGate(facts(over, win).f), { type: false, reason });
	});
}

test("typeGate: the rules that apply on macOS and Linux only with the groups do not apply there", async () => {
	// Herdr gives the foreground group: a held service, or a pane not known fresh, is judged by the group alone.
	assert.deepEqual(await typeGate(facts({ held: true }).f), { type: true });
	assert.deepEqual(await typeGate(facts({ fresh: () => false }).f), { type: true });
});

test("typeGate: a held or unmarked Windows pane is never read, so nothing is asked of Herdr for it", async () => {
	for (const over of [{ held: true }, { fresh: () => false }]) {
		const { f, calls } = facts(over, true);
		await typeGate(f);
		assert.ok(!calls.includes("read"), JSON.stringify(calls));
	}
});

test("typeGate: the rules are asked in order, and a fact is read only when every rule before it passed", async () => {
	// Every rule from the nth on says no at once: the nth is the answer, whatever the later ones say.
	const all: Partial<TypeFacts> = { attached: false, seated: () => false, busy: true, run: true, agent: "other", prompt: () => true, parked: () => true, runSoon: () => true, launchWait: () => true, command: () => false, settle: () => ({ hand: true, giveUp: true }), held: true, fresh: () => false, read: async () => runningDarwin };
	const expected: [Partial<TypeFacts>, NoReason][] = [
		[all, "absent"],
		[{ ...all, attached: true }, "unseated"],
		[{ ...all, attached: true, seated: () => true }, "busy"],
		[{ ...all, attached: true, seated: () => true, busy: false }, "run"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false }, "agent"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "stand-in" }, "prompt"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "stand-in", prompt: () => false }, "parked"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "stand-in", prompt: () => false, parked: () => false }, "run-soon"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "stand-in", prompt: () => false, parked: () => false, runSoon: () => false }, "launch-wait"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "stand-in", prompt: () => false, parked: () => false, runSoon: () => false, launchWait: () => false }, "stand-in"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "none", prompt: () => false, parked: () => false, runSoon: () => false, launchWait: () => false }, "no-command"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "none", prompt: () => false, parked: () => false, runSoon: () => false, launchWait: () => false, command: () => true }, "hand"],
		[{ ...all, attached: true, seated: () => true, busy: false, run: false, agent: "none", prompt: () => false, parked: () => false, runSoon: () => false, launchWait: () => false, command: () => true, settle: () => ({ hand: false, giveUp: true }) }, "gave-up"],
	];
	for (const [over, reason] of expected) assert.deepEqual(await typeGate(facts(over).f), { type: false, reason }, reason);
	// Windows: held before unproven before the read.
	const win = { ...expected[expected.length - 1]![0], settle: () => ({ hand: false, giveUp: false }) };
	assert.deepEqual(await typeGate(facts(win, true).f), { type: false, reason: "held" });
	assert.deepEqual(await typeGate(facts({ ...win, held: false }, true).f), { type: false, reason: "unproven" });
	assert.deepEqual(await typeGate(facts({ ...win, held: false, fresh: () => true }, true).f), { type: false, reason: "not-idle" });

	// Lazy: the stand-in is taken away only when the prompt is not there, and nothing after a no is asked.
	for (const [over, asked] of [
		[{ seated: () => false }, []],
		[{ prompt: () => true }, []],
		[{ run: true }, []],
		[{ parked: () => true }, ["gone"]],
		[{ launchWait: () => true }, ["gone", "parked", "runSoon"]],
		[{ command: () => false }, ["gone", "parked", "runSoon", "launchWait"]],
		[{ settle: () => ({ hand: true, giveUp: false }) }, ["gone", "parked", "runSoon", "launchWait", "command"]],
	] as [Partial<TypeFacts>, string[]][]) {
		const { f, calls } = facts(over);
		await typeGate(f);
		// The overridden fact is not logged; the ones asked before it are.
		assert.deepEqual(calls, asked, JSON.stringify(Object.keys(over)));
	}
	const typed = facts();
	await typeGate(typed.f);
	assert.deepEqual(typed.calls, ["gone", "parked", "runSoon", "launchWait", "command", "settle", "read", "fresh"]);
});

test("typeGate: the prompt is asked again after every await, so a poll that lands while Herdr answers is not typed over (RVTG-F002)", async () => {
	for (const [name, over] of [
		["gone", (set: () => void) => ({ gone: async () => set() })],
		["read", (set: () => void) => ({ read: async () => (set(), idleDarwin) })],
	] as const) {
		let polled = false;
		const { f } = facts({ prompt: () => polled, ...over(() => (polled = true)) });
		assert.deepEqual(await typeGate(f), { type: false, reason: "prompt" }, name);
	}
	// Asked three times: before the stand-in is taken away, after it, and after Herdr's process info, right before typing.
	let asked = 0;
	assert.deepEqual(await typeGate(facts({ prompt: () => (asked++, false) }).f), { type: true });
	assert.equal(asked, 3);
});

test("typeGate: the seat is asked again after every await, so a Herdr that comes back while the look waits is not typed into", async () => {
	for (const [name, over] of [
		["gone", (void_: () => void) => ({ gone: async () => void_() })],
		["read", (void_: () => void) => ({ read: async () => (void_(), idleDarwin) })],
	] as const) {
		let voided = false;
		const { f } = facts({ seated: () => !voided, ...over(() => (voided = true)) });
		assert.deepEqual(await typeGate(f), { type: false, reason: "unseated" }, name);
	}
});

test("seatGate: a pane in a tab labelled with the tower glyph is the tower's own; a pane in any other tab is a stranger's, whatever its id; a pane or tab not listed proves nothing", () => {
	const pane = { pane_id: "w1:p1" };
	assert.equal(seatGate({ pane, tab: { label: TOWER_LABEL } }), "ours");
	assert.equal(seatGate({ pane, tab: { label: "1" } }), "stranger");
	assert.equal(seatGate({ pane, tab: { label: "tower" } }), "stranger", "the word is no proof: a subagent can be called tower");
	assert.equal(seatGate({ pane, tab: {} }), "stranger");
	assert.equal(seatGate({ pane: undefined, tab: { label: TOWER_LABEL } }), "absent");
	assert.equal(seatGate({ pane, tab: undefined }), "absent");
});

test("proofGate: a proof holds for the terminal it was made for; another terminal under the same pane id is a new Herdr; an unknown terminal binds at the first listing; no listing proves nothing", () => {
	assert.equal(proofGate({ terminal: "term_1", pane: { terminal_id: "term_1" } }), "holds");
	assert.equal(proofGate({ terminal: "term_1", pane: { terminal_id: "term_2" } }), "moved", "Herdr gives every pane of a new server a new terminal id");
	assert.equal(proofGate({ terminal: "term_1", pane: {} }), "moved", "a terminal the proof was made for and that is no longer listed is not the same terminal");
	assert.equal(proofGate({ terminal: undefined, pane: { terminal_id: "term_2" } }), "bind", "a proof made for a pane just made takes the terminal it is listed in");
	assert.equal(proofGate({ terminal: undefined, pane: {} }), "holds", "a Herdr that lists no terminal ids leaves the proof as the glyph made it");
	assert.equal(proofGate({ terminal: "term_1", pane: undefined }), "absent");
	assert.equal(proofGate({ terminal: undefined, pane: undefined }), "absent");
});

/** The facts of a claim for a base the desk made a moment ago; `log` lists what the gate asked, in order. */
function claim(over: Partial<Parameters<typeof claimGate>[0]> = {}) {
	const log: string[] = [];
	return { log, f: { base: true, bare: true, used: false, end: async () => void log.push("end"), typed: () => (log.push("typed"), false), ...over } };
}

test("claimGate: a base the desk just made ends the service of the lost workspace and is a fresh shell only while it is bare and nothing was typed into it since", async () => {
	const fresh = claim();
	assert.deepEqual(await claimGate(fresh.f), { claimed: true, fresh: true });
	assert.deepEqual(fresh.log, ["end", "typed"], "the service is ended first: what its looks had in flight is on record when the typing is asked");
	const typed = claim({ typed: () => true });
	assert.deepEqual(await claimGate(typed.f), { claimed: true, fresh: false }, "F10: one typing per pane; the prompt a lost workspace's service started there is the one");
	assert.deepEqual(await claimGate(claim({ bare: false }).f), { claimed: true, fresh: false }, "an agent or no tower mark: the stand-in of the lost service shows, the service still ends");
});

test("claimGate: a claim that names no base, or that a service was opened for already, ends nothing and marks nothing", async () => {
	for (const over of [{ base: false }, { used: true }, { base: false, bare: true, used: true }]) {
		const { f, log } = claim(over);
		assert.deepEqual(await claimGate(f), { claimed: false, fresh: false });
		assert.deepEqual(log, [], "neither the end nor the typing is asked");
	}
});

test("typeGate: the freshness a Windows pane is typed on is read after Herdr answered, not before", async () => {
	let fresh = true;
	const { f } = facts({ fresh: () => fresh, read: async () => ((fresh = false), shellAlone) }, true);
	assert.deepEqual(await typeGate(f), { type: false, reason: "not-idle" });
});

test("idleShell: the groups decide where Herdr gives them, a list of shells only for a fresh pane, an empty list never", () => {
	assert.equal(idleShell(idleDarwin), true);
	assert.equal(idleShell(runningDarwin, true), false);
	assert.equal(idleShell(shellAlone, false, false), false);
	assert.equal(idleShell(shellAlone, true, false), true);
	assert.equal(idleShell({ foreground_processes: [] }, true, false), false);
	assert.equal(idleShell(undefined, true), false);
});

test("holdGate: where Herdr gives groups the idle shell frees the pane; on Windows the programs must be gone and the shell alone at two looks in a row", () => {
	assert.deepEqual(holdGate({ groups: true, idle: true, gone: false, clear: 0 }), { free: true, clear: 0 });
	assert.deepEqual(holdGate({ groups: true, idle: false, gone: true, clear: 0 }), { free: false, clear: 0 });
	assert.deepEqual(holdGate({ groups: true, idle: false, gone: false, clear: 1 }), { free: false, clear: 1 }, "the count is Windows's: groups leave it alone");
	assert.deepEqual(holdGate({ groups: false, idle: true, gone: true, clear: 0 }), { free: false, clear: 1 }, "the first look only counts");
	assert.deepEqual(holdGate({ groups: false, idle: true, gone: true, clear: 1 }), { free: true, clear: 0 }, "the second frees and starts over");
	assert.deepEqual(holdGate({ groups: false, idle: true, gone: false, clear: 1 }), { free: false, clear: 0 }, "a program still alive or listed starts over");
	assert.deepEqual(holdGate({ groups: false, idle: false, gone: true, clear: 1 }), { free: false, clear: 0 }, "a foreground that is not the shell alone starts over");
});

const back = { fresh: true, keepParked: false, parked: false, prompt: false, now: 1000, markMs: 60_000 };
test("giveBackGate: a run's end ends the park and marks the pane fresh, with no expiry; the run whose pi never started marks nothing", () => {
	assert.deepEqual(giveBackGate(back), { apply: true, unpark: true, fresh: true, freshUntil: undefined });
	assert.deepEqual(giveBackGate({ ...back, parked: true, prompt: true }), { apply: true, unpark: true, fresh: true, freshUntil: undefined }, "a run's end gives back whatever the prompt did");
	assert.deepEqual(giveBackGate({ ...back, fresh: false }), { apply: true, unpark: true, fresh: false, freshUntil: undefined });
});
test("giveBackGate: a Retry or proof keeps the park, expires its mark, marks no parked pane, and changes nothing while the prompt polls", () => {
	const retry = { ...back, keepParked: true };
	assert.deepEqual(giveBackGate(retry), { apply: true, unpark: false, fresh: true, freshUntil: 61_000 });
	assert.deepEqual(giveBackGate({ ...retry, parked: true }), { apply: true, unpark: false, fresh: false, freshUntil: undefined });
	assert.deepEqual(giveBackGate({ ...retry, fresh: false }), { apply: true, unpark: false, fresh: false, freshUntil: undefined });
	assert.deepEqual(giveBackGate({ ...retry, prompt: true }), { apply: false });
	assert.deepEqual(giveBackGate({ ...retry, prompt: true, parked: true }), { apply: false });
});

test("runEndGate and handGate: an unstarted run leaves the pane unmarked; a hand-over is not believed while the prompt polls", () => {
	assert.deepEqual(runEndGate(true), { fresh: false });
	assert.equal(runEndGate(false), undefined);
	assert.equal(handGate(false), true);
	assert.equal(handGate(true), false);
});

test("settleGate: a mark lapses after its time; a hand-over is proved by its pi being gone, believed no longer than handMs, and its mark lasts handMs more", () => {
	const dead = () => false, live = () => true;
	const at = { fresh: true, freshUntil: undefined, hand: undefined, now: 10_000, handMs: 60_000, alive: live };
	assert.deepEqual(settleGate(at), { fresh: true, freshUntil: undefined, hand: undefined, failures0: false }, "a mark with no expiry stays");
	assert.deepEqual(settleGate({ ...at, freshUntil: 10_000 }), { fresh: true, freshUntil: 10_000, hand: undefined, failures0: false }, "at its time it still stands");
	assert.deepEqual(settleGate({ ...at, freshUntil: 9999 }), { fresh: false, freshUntil: undefined, hand: undefined, failures0: false });
	const hand = { pid: 7, at: 5000 };
	assert.deepEqual(settleGate({ ...at, fresh: false, hand, alive: live }), { fresh: false, freshUntil: undefined, hand, failures0: false }, "its pi still runs: the pane waits");
	assert.deepEqual(settleGate({ ...at, fresh: false, hand, alive: dead }), { fresh: true, freshUntil: 70_000, hand: undefined, failures0: true }, "its pi is gone");
	assert.deepEqual(settleGate({ ...at, fresh: false, hand: { at: 5000 }, alive: live }), { fresh: true, freshUntil: 70_000, hand: undefined, failures0: true }, "no pid said: nothing to wait for");
	assert.deepEqual(settleGate({ ...at, fresh: false, hand: { pid: 7, at: 10_000 - 60_001 }, alive: dead }), { fresh: false, freshUntil: undefined, hand: undefined, failures0: false }, "the time is up: the hand-over is forgotten, not believed");
	assert.deepEqual(settleGate({ ...at, fresh: false, hand: { pid: 7, at: 10_000 - 60_000 }, alive: dead }).hand, undefined);
	assert.equal(settleGate({ ...at, fresh: false, hand: { pid: 7, at: 10_000 - 60_000 }, alive: dead }).fresh, true, "exactly handMs is still within the time");
});

test("tableGate and retryGate: only a read that succeeds and finds nothing proves a pane empty; Retry reads the table first on Windows and gives nothing back to a run or a program", () => {
	assert.equal(tableGate(undefined), "unreadable");
	assert.equal(tableGate([{ pid: 9 }]), "program");
	assert.equal(tableGate([]), "empty");
	const idle = { win: false, run: false, queued: false, wasBusy: false };
	assert.equal(retryGate(idle), "give-back");
	assert.equal(retryGate({ ...idle, wasBusy: true }), "none");
	assert.equal(retryGate({ ...idle, win: true }), "prove");
	assert.equal(retryGate({ ...idle, win: true, wasBusy: true }), "prove", "the table is read whatever the service believes");
	for (const win of [false, true]) {
		assert.equal(retryGate({ ...idle, win, run: true }), "none", "a live run holds the pane");
		assert.equal(retryGate({ ...idle, win, queued: true }), "none", "a waiting event: the run's start decides");
	}
});

test("refusedGate: a refusal keeps the mark the pane had (a lapsing one is pushed on) until the third in a row, which gives up; later ones change nothing more", () => {
	const base = { wasFresh: true, freshUntil: undefined, failures: 1, tries: 3, now: 5000, handMs: 60_000 };
	assert.deepEqual(refusedGate(base), { fresh: true, freshUntil: undefined, giveUp: false });
	assert.deepEqual(refusedGate({ ...base, freshUntil: 100, failures: 2 }), { fresh: true, freshUntil: 65_000, giveUp: false });
	assert.deepEqual(refusedGate({ ...base, wasFresh: false }), { fresh: false, freshUntil: undefined, giveUp: false });
	assert.deepEqual(refusedGate({ ...base, freshUntil: 100, failures: 3 }), { fresh: false, freshUntil: undefined, giveUp: true });
	assert.deepEqual(refusedGate({ ...base, failures: 4 }), { fresh: false, freshUntil: undefined, giveUp: false });
});
