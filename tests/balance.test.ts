// @ts-nocheck: layouts and fake Herdr calls are loose test data.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { balanceAfterClose, balanceTab, planBalance } from "../src/balance.mjs";
import paneBalance, { runHelper } from "../src/balance.ts";
import { markRun } from "../src/runmark.ts";

const rect = (x, y, width, height) => ({ x, y, width, height });

// pi-herdr-agents splits each worker off the parent pane, so three workers leave a chain of halves.
const chain = {
	splits: [
		{ id: "split_0_root", direction: "right", ratio: 0.5, rect: rect(0, 0, 183, 62) },
		{ id: "split_1_0", direction: "right", ratio: 0.5, rect: rect(0, 0, 92, 62) },
		{ id: "split_2_00", direction: "right", ratio: 0.5, rect: rect(0, 0, 46, 62) },
	],
	panes: [
		{ pane_id: "lead", rect: rect(0, 0, 23, 62) },
		{ pane_id: "w3", rect: rect(23, 0, 23, 62) },
		{ pane_id: "w2", rect: rect(46, 0, 46, 62) },
		{ pane_id: "w1", rect: rect(92, 0, 91, 62) },
	],
};
const balanced = {
	splits: [
		{ id: "split_0_root", direction: "right", ratio: 0.5, rect: rect(0, 0, 180, 60) },
	],
	panes: [{ pane_id: "lead", rect: rect(0, 0, 90, 60) }, { pane_id: "w1", rect: rect(90, 0, 90, 60) }],
};
test("planBalance gives every column and row an equal share, outermost split first", () => {
	assert.deepEqual(planBalance(chain), [
		{ pane: "w2", direction: "right", amount: 0.25 },
		{ pane: "w3", direction: "right", amount: 0.1667 },
	], "a chain of halves becomes four equal columns");

	assert.deepEqual(planBalance({ splits: [], panes: [{ pane_id: "lead", rect: rect(0, 0, 183, 62) }] }), [],
		"a lone pane needs nothing");

	assert.deepEqual(planBalance(balanced), [], "equal columns stay put");

	// A worker closed on the left of a 3:1 split shrinks the first side, so the second side grows back.
	const afterClose = {
		splits: [{ id: "split_0_root", direction: "right", ratio: 0.75, rect: rect(0, 0, 180, 60) }],
		panes: [{ pane_id: "lead", rect: rect(0, 0, 135, 60) }, { pane_id: "w1", rect: rect(135, 0, 45, 60) }],
	};
	assert.deepEqual(planBalance(afterClose), [{ pane: "w1", direction: "left", amount: 0.25 }]);

	// A stacked pair counts as one column; the stacked split balances its own rows.
	const stacked = {
		splits: [
			{ id: "split_0_root", direction: "right", ratio: 0.5, rect: rect(0, 0, 180, 60) },
			{ id: "split_1_1", direction: "down", ratio: 0.7, rect: rect(90, 0, 90, 60) },
		],
		panes: [
			{ pane_id: "lead", rect: rect(0, 0, 90, 60) },
			{ pane_id: "top", rect: rect(90, 0, 90, 42) },
			{ pane_id: "bottom", rect: rect(90, 42, 90, 18) },
		],
	};
	assert.deepEqual(planBalance(stacked), [{ pane: "bottom", direction: "up", amount: 0.2 }]);

});

test("balanceTab rereads after every resize, skips zoomed tabs, takes turns per tab; a quitting pi rebalances after its pane closes", async () => {
	const lockRoot = mkdtempSync(join(tmpdir(), "psb-balance-test-"));
	const withTab = (layout) => JSON.stringify({ result: { layout: { ...layout, tab_id: "w:t1" } } });

	// Each resize is planned from a fresh layout, so the chain takes one resize per read.
	const afterRoot = { ...chain, splits: [{ ...chain.splits[0], ratio: 0.75 }, ...chain.splits.slice(1)] };
	const layouts = [chain, chain, afterRoot, balanced];
	const calls = [];
	await balanceTab("lead", {
		lockRoot,
		run: async (args) => {
			calls.push(args);
			return args[1] === "layout" ? withTab(layouts.shift()) : "{}";
		},
});
assert.deepEqual(calls.filter((args) => args[1] === "resize"), [
	["pane", "resize", "--pane", "w2", "--direction", "right", "--amount", "0.25"],
	["pane", "resize", "--pane", "w3", "--direction", "right", "--amount", "0.1667"],
]);
assert.equal(layouts.length, 0, "the layout is reread after every resize");

calls.length = 0;
await balanceTab("lead", { lockRoot, run: async (args) => (calls.push(args), withTab({ ...chain, zoomed: true })) });
assert.ok(calls.every((args) => args[1] === "layout"), "a zoomed tab is left alone");

// Two sessions balancing one tab take turns instead of applying the same delta twice.
let ratio = 0.75;
let resizes = 0;
const live = () => ({
	splits: [{ id: "split_0_root", direction: "right", ratio, rect: rect(0, 0, 180, 60) }],
	panes: [
		{ pane_id: "lead", rect: rect(0, 0, 180 * ratio, 60) },
		{ pane_id: "w1", rect: rect(180 * ratio, 0, 180 * (1 - ratio), 60) },
	],
});
const shared = async (args) => {
	if (args[1] === "layout") return withTab(live());
	resizes++;
	await new Promise((resolve) => setTimeout(resolve, 20));
	const amount = Number(args[7]);
	ratio += args[5] === "right" ? amount : -amount;
	return "{}";
};
await Promise.all([balanceTab("lead", { lockRoot, run: shared }), balanceTab("w1", { lockRoot, run: shared })]);
assert.ok(Math.abs(ratio - 0.5) < 0.01, `concurrent sessions leave equal columns, got ${ratio}`);
assert.equal(resizes, 1, "the second session sees the balanced tab instead of overshooting it");

// A quitting Pi waits for its pane to close, then balances the tab it left through another pane.
const closing = (goneAfter) => {
	let gets = 0;
	const laidOut = [];
	const run = async (args) => {
		if (args[1] === "get") {
			if (gets++ < goneAfter) return JSON.stringify({ result: { pane: { pane_id: args[2], tab_id: "w:t1" } } });
			throw Object.assign(new Error("exit 1"), { stderr: '{"error":{"code":"pane_not_found"}}' });
		}
		if (args[1] === "list") {
			return JSON.stringify({ result: { panes: [{ pane_id: "x1", tab_id: "x:t1" }, { pane_id: "lead", tab_id: "w:t1" }] } });
		}
		if (args[1] === "layout") {
			laidOut.push(args[3]);
			return withTab(balanced);
		}
		throw new Error(`unexpected herdr call ${args.join(" ")}`);
	};
	return { run, laidOut };
};
const closed = closing(3);
await balanceAfterClose("w1", "w:t1", { run: closed.run, lockRoot, pollMs: 1, waitMs: 1000 });
assert.deepEqual(closed.laidOut, ["lead", "lead"], "the tab the pane left is balanced once it closes");

const kept = closing(Infinity);
await balanceAfterClose("w1", "w:t1", { run: kept.run, lockRoot, pollMs: 1, waitMs: 20 });
assert.deepEqual(kept.laidOut, [], "a pane that stays open after Pi quits changes nothing");

// Herdr can close the pane before the helper first asks about it; the tab the Pi saw still counts.
const gone = closing(0);
await balanceAfterClose("w1", "w:t1", { run: gone.run, lockRoot, pollMs: 1, waitMs: 1000 });
assert.deepEqual(gone.laidOut, ["lead", "lead"], "a pane already closed still rebalances the tab it left");

	rmSync(lockRoot, { recursive: true, force: true });
});

test("the extension runs the helper detached when its pi starts and when it quits, and nothing outside Herdr", () => {
	const spawned = [];
	runHelper(["after-close", "w1", "w:t1"], (command, args, options) => {
		spawned.push({ command, args, options });
		return { on() {}, unref() {} };
	});
	assert.equal(spawned[0].command, process.execPath);
	assert.match(spawned[0].args[0], /src\/balance\.mjs$/);
	assert.deepEqual(spawned[0].args.slice(1), ["after-close", "w1", "w:t1"]);
	assert.equal(spawned[0].options.detached, true, "the helper outlives the quitting pi");
	assert.equal(spawned[0].options.windowsHide, true, "a detached console child on Windows gets no console window of its own");

	const handlers = new Map();
	const runs = [];
	const pi = { on(event, handler) { handlers.set(event, handler); } };
	const started = Symbol.for("pi-straw-boss.pane-balance.started");
	delete globalThis[started];
	paneBalance(pi, (args) => runs.push(args), {});
	assert.equal(handlers.size, 0, "outside Herdr the extension registers nothing");
	assert.deepEqual(runs, []);
	const env = { HERDR_PANE_ID: "lead", HERDR_TAB_ID: "w:t1" };
	paneBalance(pi, (args) => runs.push(args), env);
	assert.deepEqual(runs, [["now", "lead"]], "a starting pi balances its tab as soon as it loads");
	paneBalance(pi, (args) => runs.push(args), env);
	assert.deepEqual(runs, [["now", "lead"]], "a /reload in the same process does not balance again");
	assert.deepEqual([...handlers.keys()], ["session_shutdown"], "only a pi starting or quitting rebalances");
	handlers.get("session_shutdown")({ reason: "reload" });
	assert.equal(runs.length, 1, "a reload is not a quit");
	handlers.get("session_shutdown")({ reason: "quit" });
	assert.deepEqual(runs.at(-1), ["after-close", "lead", "w:t1"]);
	delete globalThis[started];
});

test("VM: a tower run's pi (flag or claim) never spawns after-close: its pane stays or the server closes it, and the orphan would hold pi.cmd's wait for 30 s", () => {
	const started = Symbol.for("pi-straw-boss.pane-balance.started");
	const handlers = new Map();
	const pi = { on(event, handler) { handlers.set(event, handler); } };
	const env = { HERDR_PANE_ID: "lead", HERDR_TAB_ID: "w:t1" };
	const quitting = (argv) => {
		const runs = [];
		delete globalThis[started];
		paneBalance(pi, (args) => runs.push(args), env, argv);
		runs.length = 0;
		handlers.get("session_shutdown")({ reason: "quit" });
		return runs;
	};
	assert.deepEqual(quitting([]), [["after-close", "lead", "w:t1"]], "a pi of a main still rebalances after its pane closes");
	assert.deepEqual(quitting(["node", "pi", "--sb-run", "RUN"]), [], "a run started with --sb-run (local or ally)");
	assert.deepEqual(quitting(["node", "pi", "--sb-run=RUN"]), [], "in the = form too");
	// A pi in a standing pane has no flag: the run mode marks the process when the server hands it the pane.
	markRun();
	try {
		assert.deepEqual(quitting([]), [], "a run claimed through pane-role");
		markRun("ally");
		assert.deepEqual(quitting(["node", "pi", "--sb-run", "RUN"]), [["after-close", "lead", "w:t1"]], "an ally run's pane is closed by the server: the tab is rebalanced");
	} finally {
		delete globalThis[Symbol.for("pi-straw-boss.run.mark")];
		delete globalThis[started];
	}
});
