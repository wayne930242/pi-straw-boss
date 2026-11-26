import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Net } from "../src/net.ts";
import type { Pane } from "../src/herdr.ts";
import { parseArgs } from "../src/server/cli.ts";
import { judgeWard, QUIET_MS, readSession, WARD_LOOK_MS, type WardRec } from "../src/server/ward.ts";
import { runWard } from "../src/server/wardcli.ts";
import type { WatchNet } from "../src/server/watchread.ts";
import { startWatches, watchReply } from "../src/server/watchesops.ts";
import { fakeClock } from "./fake-clock.ts";

// `sb ward` / `sb_ward` (docs/how-it-works.md#ward-a-plain-pane): the server wakes a main only when a worker in a plain pane really ended. A fake Herdr (a pane list the test edits), fake session files and a loops folder in a
// temp folder, and a clock the test moves; nothing reaches the real Herdr or a real session.

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const MAIN = "0199aaaa-main-0000-0000-000000000001", WORKER = "0199bbbb-work-0000-0000-000000000002";
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (text: string) => line({ type: "message", id: "u", timestamp: "2026-11-27T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const said = (text: string) => line({ type: "message", id: "a", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const calls = (id: string, name: string, args: Record<string, unknown>) => line({ type: "message", id, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id: string, name: string, details: Record<string, unknown> = name === "call_peer" ? { to: "main", id: MAIN, status: "sent" } : { messageId: `m${id}`, delivered: true }, isError = false) => line({ type: "message", id: `r${id}`, message: { role: "toolResult", toolCallId: id, toolName: name, isError, details, content: [{ type: "text", text: "ok" }] } });

function world() {
	const dir = mkdtempSync(join(tmpdir(), "sb-ward-")), loops = join(dir, "loops"), file = join(dir, `2026_${WORKER}.jsonl`);
	dirs.push(dir);
	mkdirSync(loops);
	writeFileSync(file, line({ type: "session", id: WORKER, cwd: dir }) + user("do the work") + said("working on it"));
	const clock = fakeClock(1_700_000_000_000);
	const pane: Pane = { pane_id: "%7", tab_id: "t2", workspace_id: "w1", agent: "pi", agent_status: "working", agent_session: { value: file } };
	let list: Pane[] = [{ pane_id: "%1", tab_id: "t1", workspace_id: "w1", agent: "pi", agent_status: "working" }, pane];
	const monitors = new Set<string>();
	const run = async (args: string[]) => {
		if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: list } });
		throw new Error(`unexpected herdr ${args.join(" ")}`);
	};
	const net: WatchNet = { onRead: () => () => {}, last: () => ({ bases: [] }) as Net, lookup: (key) => (key === MAIN ? { key, base: "w1", name: "main", role: "main", live: true } : undefined), read: async () => ({ bases: [] }) as Net };
	const timer = (ms: number, fn: () => void) => { let live = true; clock.at(clock.elapsed() + ms, () => live && fn()); return () => void (live = false); };
	const sent: { session: string; text: string; key: string; state: string }[] = [];
	const stops: (() => void)[] = [];
	const start = () => startWatches({ net, now: clock.now, send: async (to, text, facts) => (sent.push({ session: to.session, text, ...facts }), true), log: () => {}, stops, slot: { dir } as never, over: { timer }, ward: { run, monitorPanes: () => monitors, loopsDir: loops } });
	let routes = start();
	after(() => stops.forEach((s) => s()));
	return {
		clock, file, pane, sent, monitors, loops, get routes() { return routes; },
		/** The server stops and a new one starts from `watches.json`. */
		restart: () => void (stops.splice(0).forEach((s) => s()), (routes = start())),
		set: (over: Partial<Pane>) => Object.assign(pane, over),
		drop: () => void (list = list.filter((p) => p !== pane)),
		write: (text: string) => appendFileSync(file, text),
		add: (ward: Record<string, unknown> = {}) => watchReply(routes, { cmd: "watch-add", session: MAIN, workspace: "w1", key: "ward:%7", ward: { names: ["boss-main"], here: "%1", ...ward } }, () => true)!,
		/** `n` looks of the ward, one WARD_LOOK_MS apart. */
		async looks(n: number) { for (let i = 0; i < n; i++) { await settle(); clock.advance(WARD_LOOK_MS); await settle(); } },
		list: () => routes.watches.list(MAIN).watches as { key: string; ward?: unknown }[],
	};
}

test("a worker idle while its own monitor runs is not finished: no wake for as long as the monitor runs; once it stops, two quiet looks a minute apart wake the main once with finished", async () => {
	const w = world();
	w.set({ agent_status: "idle" });
	w.monitors.add("%7");
	const added = await w.add({ item: "MP-5102" });
	assert.equal(added.ok, true, JSON.stringify(added));
	assert.deepEqual(added.ward, { pane: "%7", file: w.file, item: "MP-5102" });
	await w.looks(30); // ten minutes
	assert.equal(w.sent.length, 0, "idle with a running monitor wakes nothing");
	w.monitors.clear();
	await w.looks(2);
	assert.equal(w.sent.length, 0, "one quiet look is not enough");
	await w.looks(Math.ceil(QUIET_MS / WARD_LOOK_MS) + 1);
	assert.equal(w.sent.length, 1);
	assert.equal(w.sent[0]!.state, "finished");
	assert.equal(w.sent[0]!.key, "ward:%7");
	assert.match(w.sent[0]!.text, /^ward %7 \(MP-5102\): finished: its last turn ended and nothing of it has run for a minute\./);
	await w.looks(20);
	assert.equal(w.sent.length, 1, "one wake per ending: the ward ended with it");
	assert.deepEqual(w.list(), []);
});

test("an active loop of the worker's session keeps it from being finished", async () => {
	const w = world();
	w.set({ agent_status: "done" });
	writeFileSync(join(w.loops, `loops-${WORKER}.json`), JSON.stringify({ loops: [{ status: "active", expiresAt: w.clock.now() + 3_600_000 }] }));
	assert.equal((await w.add()).ok, true);
	await w.looks(15);
	assert.equal(w.sent.length, 0);
});

test("a report to the main over intercom or call_peer is finished at the next look; one written before the ward does not count", async () => {
	const w = world();
	w.write(calls("c0", "intercom", { action: "send", to: MAIN, message: "early" }) + result("c0", "intercom"));
	assert.equal((await w.add()).ok, true);
	await w.looks(2);
	assert.equal(w.sent.length, 0, "the report before the ward is old");
	w.write(calls("c1", "intercom", { action: "send", to: "someone-else", message: "x" }) + result("c1", "intercom"));
	// ward-review F001: a name or an id prefix may resolve to another session (intercom matches a full name before an id prefix), and a result that says not delivered reached nobody.
	w.write(calls("c3", "intercom", { action: "send", to: "boss-main", message: "done" }) + result("c3", "intercom"));
	w.write(calls("c4", "intercom", { action: "send", to: MAIN.slice(0, 8), message: "done" }) + result("c4", "intercom"));
	w.write(calls("c5", "intercom", { action: "send", to: MAIN, message: "done" }) + result("c5", "intercom", { messageId: "m5", delivered: false, reason: "offline" }));
	w.write(calls("c2", "intercom", { action: "send", to: MAIN, message: "done" }));
	await w.looks(1);
	assert.equal(w.sent.length, 0, "a call without its result has not reached the main yet; another target, a name, a prefix, or an undelivered send is no report");
	w.write(result("c2", "intercom"));
	await w.looks(1);
	assert.equal(w.sent.length, 1);
	assert.equal(w.sent[0]!.state, "finished");
	assert.match(w.sent[0]!.text, /finished: it reported to you \(intercom send\)/);
	await w.looks(5);
	assert.equal(w.sent.length, 1);

	const v = world();
	assert.equal((await v.add()).ok, true);
	// call_peer to its own tab's main may reach another main than the warder: only the result's recipient id counts.
	v.write(calls("p0", "call_peer", { to: "main", message: "done" }) + result("p0", "call_peer", { to: "main", id: "0199cccc-other-main", status: "sent" }));
	v.write(calls("p2", "call_peer", { to: "main", message: "done" }) + result("p2", "call_peer", { to: "main", id: MAIN, status: "queued" }));
	await v.looks(1);
	assert.equal(v.sent.length, 0, "a call_peer to another main, or one not sent, is no report");
	v.write(calls("p1", "call_peer", { to: "main", message: "done" }) + result("p1", "call_peer"));
	await v.looks(1);
	assert.deepEqual(v.sent.map((s) => s.state), ["finished"]);
});

test("a pane that is gone, or one pi left, is dead: one wake, and the ward ends; a pane that only moved is not", async () => {
	const w = world();
	assert.equal((await w.add()).ok, true);
	w.drop();
	await w.looks(3);
	assert.deepEqual(w.sent.map((s) => s.state), ["dead"]);
	assert.ok(w.sent[0]!.text.startsWith(`ward %7: dead: its pane is gone. Read its session file (${w.file})`), w.sent[0]!.text);
	assert.deepEqual(w.list(), []);

	const moved = world();
	assert.equal((await moved.add()).ok, true);
	moved.set({ pane_id: "%8" });
	await moved.looks(3);
	assert.equal(moved.sent.length, 0, "a pane Herdr gave a new id still holds the session file: the same worker");

	const v = world();
	assert.equal((await v.add()).ok, true);
	v.set({ agent: undefined, agent_session: undefined, agent_status: undefined });
	await v.looks(3);
	assert.deepEqual(v.sent.map((s) => s.state), ["dead"]);
	assert.match(v.sent[0]!.text, /pi left the pane/);
});

test("a dialog or a pane Herdr shows blocked is blocked: one wake per blocked spell, and the ward goes on to the next ending", async () => {
	const w = world();
	assert.equal((await w.add()).ok, true);
	w.write(calls("q1", "ask_user_question", { questions: [] }));
	await w.looks(6);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked"]);
	assert.match(w.sent[0]!.text, /blocked: it waits on a dialog/);
	w.write(result("q1", "ask_user_question"));
	await w.looks(4);
	w.set({ agent_status: "blocked" });
	await w.looks(6);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked", "blocked"], "a new spell is told again, once");
	assert.match(w.sent[1]!.text, /Herdr shows its pane blocked/);
	w.set({ agent_status: "working" });
	w.drop();
	await w.looks(4);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked", "blocked", "dead"]);
});

test("a ward is refused on the caller's own pane, a pane that runs no pi, an unknown pane, and a bad item", async () => {
	const w = world();
	const no = async (over: Record<string, unknown>, key = "ward:%7") => (await watchReply(w.routes, { cmd: "watch-add", session: MAIN, workspace: "w1", key, ward: { here: "%1", ...over } }, () => true)!);
	assert.match(String((await no({}, "ward:%1")).error), /your own pane/);
	assert.match(String((await no({}, "ward:%99")).error), /no pane %99/);
	assert.match(String((await no({ item: "bad item!" })).error), /item is a plain key/);
	w.set({ agent: "claude" });
	assert.match(String((await no({})).error), /runs no pi session/);
});

test("judgeWard and readSession: the turn from the session file, reports only from the ward's start", () => {
	const dir = mkdtempSync(join(tmpdir(), "sb-ward-unit-")), file = join(dir, "s.jsonl");
	dirs.push(dir);
	const main = { id: MAIN, names: ["boss-main"] };
	writeFileSync(file, line({ type: "session", id: WORKER }) + user("go"));
	assert.equal(readSession(file, 0, main).turn, "working");
	appendFileSync(file, said("done"));
	assert.equal(readSession(file, 0, main).turn, "ended");
	appendFileSync(file, line({ type: "custom_message", customType: "x", content: "note" }));
	assert.equal(readSession(file, 0, main).turn, "ended", "a custom message after the turn is no turn");
	appendFileSync(file, calls("m", "MonitorCreate", { command: "sleep 60" }));
	assert.equal(readSession(file, 0, main).turn, "working");
	assert.equal(readSession(join(dir, "none.jsonl"), 0, main).turn, "unknown");
	const rec: WardRec = { pane: "%7", file, worker: WORKER, offset: 0, main };
	const pane = { agent: "pi", agent_status: "idle", agent_session: { value: file } };
	assert.equal(judgeWard(rec, { pane, turn: "ended", runs: ["a monitor of it runs"] }, {}, 0).state, "unchanged");
	const first = judgeWard(rec, { pane, turn: "ended", runs: [] }, {}, 0);
	assert.deepEqual([first.state, first.told], ["unchanged", { quiet: 0 }]);
	assert.equal(judgeWard(rec, { pane, turn: "ended", runs: [] }, first.told, QUIET_MS - 1).state, "unchanged");
	assert.equal(judgeWard(rec, { pane, turn: "ended", runs: [] }, first.told, QUIET_MS).state, "finished");
	assert.equal(judgeWard(rec, { pane: { ...pane, agent_status: "working" }, turn: "ended", runs: [] }, first.told, QUIET_MS).state, "unchanged", "Herdr's working breaks the quiet");
	assert.equal(judgeWard(rec, { pane: { ...pane, agent_session: { value: "/other.jsonl" } }, turn: "ended", runs: [] }, {}, 0).state, "dead");
});

test("cli.mjs ward: parsed, and sent as the session's ward in the workspace of its pane", async () => {
	assert.deepEqual(parseArgs(["ward", "%7", "--item", "MP-1", "--until", "2h"]), { command: "ward", flags: { pane: "%7", item: "MP-1", until: "2h" } });
	assert.throws(() => parseArgs(["ward", "--item", "MP-1"]), /ward needs the pane/);
	const asked: Record<string, unknown>[] = [];
	let out = "", err = "";
	const run = async () => JSON.stringify({ result: { panes: [{ pane_id: "%1", tab_id: "t1", workspace_id: "w1" }] } });
	const io = { out: (t: string) => void (out += t), err: (t: string) => void (err += t), run, env: { PI_INTERCOM_SESSION_ID: MAIN, HERDR_PANE_ID: "%1" }, ask: async (r: Record<string, unknown>) => (asked.push(r), { ok: true as const, reply: { ward: { pane: "%7", file: "/f" }, watch: { until: 5, line: "ward %7: unchanged: it works." } } }) };
	assert.equal(await runWard({} as never, { pane: "%7", item: "MP-1", until: "2h" }, io), 0, err);
	assert.deepEqual(asked[0], { cmd: "watch-add", session: MAIN, workspace: "w1", key: "ward:%7", untilMs: 7_200_000, ward: { item: "MP-1", here: "%1" } });
	assert.match(out, /"pane":"%7"/);
	assert.equal(await runWard({} as never, { pane: "%7", stop: true }, io), 0);
	assert.deepEqual(asked[1], { cmd: "watch-stop", session: MAIN, key: "ward:%7" });
	assert.equal(await runWard({} as never, { pane: "%7" }, { ...io, env: {} }), 1);
});

test("a ward is kept in watches.json: a restarted server keeps it, does not tell a blocked spell again, and wakes on the next ending", async () => {
	const w = world();
	assert.equal((await w.add({ item: "MP-9" })).ok, true);
	w.set({ agent_status: "blocked" });
	await w.looks(2);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked"]);
	w.restart();
	await w.looks(1);
	assert.deepEqual(w.list().map((x) => [x.key, x.ward]), [["ward:%7", { pane: "%7", file: w.file, item: "MP-9" }]]);
	await w.looks(4);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked"], "the spell was told before the restart");
	w.drop();
	await w.looks(4);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked", "dead"]);
});
