import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Net } from "../src/net.ts";
import type { Pane } from "../src/herdr.ts";
import { parseArgs } from "../src/server/cli.ts";
import { createWardRead, judgeWard, QUIET_MS, readSession, sessionReader, WARD_LOOK_MS, type WardRec, wardOf } from "../src/server/ward.ts";
import { runWard, WARD_CLI_REFUSED } from "../src/server/wardcli.ts";
import type { WatchNet } from "../src/server/watchread.ts";
import { startWatches, watchReply } from "../src/server/watchesops.ts";
import { fakeClock } from "./fake-clock.ts";

// `sb ward` / `sb_ward` (docs/how-it-works.md#ward-a-plain-pane): the server wakes a main only when a worker in a plain pane really ended. A fake Herdr (a pane list the test edits), fake session files and a loops folder in a
// temp folder, and a clock the test moves; nothing reaches the real Herdr or a real session.

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const MAIN = "0199aaaa-main-0000-0000-000000000001", WORKER = "0199bbbb-work-0000-0000-000000000002", MEMBER = "0199dddd-memb-0000-0000-000000000003";
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
	const pane: Pane = { pane_id: "%7", tab_id: "t2", workspace_id: "w1", terminal_id: "T7", agent: "pi", agent_status: "working", agent_session: { value: file } };
	let list: Pane[] = [{ pane_id: "%1", tab_id: "t1", workspace_id: "w1", agent: "pi", agent_status: "working" }, pane];
	const monitors = new Set<string>();
	// `hold.list`: Herdr's pane list waits until the test lets it answer (a look in flight).
	const hold: { list?: Promise<void> } = {};
	const run = async (args: string[]) => {
		if (args[0] === "pane" && args[1] === "list") return (await hold.list, JSON.stringify({ result: { panes: list } }));
		throw new Error(`unexpected herdr ${args.join(" ")}`);
	};
	const units: Record<string, { role: string; base: string; pane?: string; live: boolean }> = { [MAIN]: { role: "main", base: "w1", pane: "%1", live: true }, [MEMBER]: { role: "member", base: "w1", pane: "%3", live: true } };
	// The registry is empty until a reading (no page, no watch): only `read` fills it (ward-review F009).
	const reading = { done: 0 };
	const net: WatchNet = { onRead: () => () => {}, last: () => ({ bases: [] }) as Net, lookup: (key) => (reading.done && units[key] ? { key, name: key.slice(0, 8), ...units[key]! } : undefined), read: async () => (reading.done++, { bases: [] }) as Net };
	// The registration secrets the car book handed (carbook.ts `sessionOf`): one per session's pi process.
	// The role the car book reads now (its live look), which may differ from the net's last reading.
	const bookRole: Record<string, string> = {};
	const secrets: Record<string, string> = { [`s-${MAIN}`]: MAIN, [`s-${MEMBER}`]: MEMBER, [`s-${WORKER}`]: WORKER };
	const timer = (ms: number, fn: () => void) => { let live = true; clock.at(clock.elapsed() + ms, () => live && fn()); return () => void (live = false); };
	const sent: { session: string; text: string; key: string; state: string; id?: string }[] = [];
	const stops: (() => void)[] = [];
	// `lost`: the main takes the line, but its answer never reaches the server.
	const takes = { now: true, lost: false };
	const start = () => startWatches({ net, now: clock.now, send: async (to, text, facts) => (takes.lost ? (sent.push({ session: to.session, text, ...facts }), false) : takes.now ? (sent.push({ session: to.session, text, ...facts }), true) : false), log: () => {}, stops, slot: { dir } as never, over: { timer }, ward: { run, monitorPanes: () => monitors, loopsDir: loops, owner: async (secret) => (typeof secret === "string" && secrets[secret] ? { session: secrets[secret]!, role: bookRole[secrets[secret]!] ?? units[secrets[secret]!]?.role ?? "train" } : "sb: this request is not from a registered session") } });
	let routes = start();
	after(() => stops.forEach((s) => s()));
	return {
		clock, file, pane, sent, monitors, loops, units, bookRole, takes, dir, reading, hold, get routes() { return routes; },
		/** Another pane in another workspace that runs pi. */
		other: () => void list.push({ pane_id: "%9", tab_id: "t9", workspace_id: "w2", agent: "pi", agent_status: "working", agent_session: { value: file } }),
		/** The server stops and a new one starts from `watches.json`. */
		restart: () => void (stops.splice(0).forEach((s) => s()), (routes = start())),
		set: (over: Partial<Pane>) => Object.assign(pane, over),
		drop: () => void (list = list.filter((p) => p !== pane)),
		back: () => void (list.includes(pane) || list.push(pane)),
		push: (p: Pane) => void list.push(p),
		write: (text: string) => appendFileSync(file, text),
		add: (ward: Record<string, unknown> = {}, session = MAIN, key = "ward:%7", secret: string | null = `s-${session}`) => watchReply(routes, { cmd: "ward-add", session, key, ward, ...(secret ? { secret } : {}) }, () => true)!,
		stop: (session = MAIN, secret: string | null = `s-${session}`, key = "ward:%7") => watchReply(routes, { cmd: "watch-stop", session, key, ...(secret ? { secret } : {}) }, () => true)!,
		/** `n` looks of the ward, one WARD_LOOK_MS apart. */
		async looks(n: number) { for (let i = 0; i < n; i++) { await settle(); clock.advance(WARD_LOOK_MS); await settle(); } },
		list: async (secret: string | null = `s-${MAIN}`) => (await watchReply(routes, { cmd: "watch-list", session: MAIN, ...(secret ? { secret } : {}) }, () => true)!).watches as { key: string; ward?: unknown }[],
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
	assert.deepEqual((await w.list()), []);
});

test("an active loop of the worker's session keeps it from being finished", async () => {
	const w = world();
	w.set({ agent_status: "done" });
	writeFileSync(join(w.loops, `loops-${WORKER}.json`), JSON.stringify({ loops: [{ status: "active", expiresAt: w.clock.now() + 3_600_000 }] }));
	assert.equal((await w.add()).ok, true);
	await w.looks(15);
	assert.equal(w.sent.length, 0);
});

test("a report to the main over call_peer is finished at the next look; one written before the ward does not count; an intercom send is no report", async () => {
	const w = world();
	w.write(calls("c0", "call_peer", { to: "main", message: "early" }) + result("c0", "call_peer"));
	assert.equal((await w.add()).ok, true);
	await w.looks(2);
	assert.equal(w.sent.length, 0, "the report before the ward is old");
	// ward-review F001: intercom's result names no recipient (a full id, a name, a prefix, or a `cwd` may resolve to another session), so no intercom send is a report, delivered or not.
	w.write(calls("c1", "intercom", { action: "send", to: MAIN, message: "done" }) + result("c1", "intercom"));
	w.write(calls("c2", "intercom", { action: "send", to: MAIN, cwd: "/elsewhere", message: "done" }) + result("c2", "intercom"));
	w.write(calls("c3", "intercom", { action: "send", to: "boss-main", message: "done" }) + result("c3", "intercom"));
	w.write(calls("c4", "call_peer", { to: "main", message: "done" }));
	await w.looks(1);
	assert.equal(w.sent.length, 0, "an intercom send is no report; a call without its result has not reached the main yet");
	w.write(result("c4", "call_peer"));
	await w.looks(1);
	assert.equal(w.sent.length, 1);
	assert.equal(w.sent[0]!.state, "finished");
	assert.match(w.sent[0]!.text, /finished: it reported to you \(call_peer\)/);
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
	assert.deepEqual((await w.list()), []);

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
	const no = async (over: Record<string, unknown>, key = "ward:%7") => (await watchReply(w.routes, { cmd: "ward-add", session: MAIN, secret: `s-${MAIN}`, key, ward: over }, () => true)!);
	assert.match(String((await no({}, "ward:%1")).error), /your own pane/);
	assert.match(String((await no({}, "ward:%99")).error), /no pane %99/);
	assert.match(String((await no({ item: "bad item!" })).error), /item is a plain key/);
	w.set({ agent: "claude" });
	assert.match(String((await no({})).error), /runs no pi session/);
});

test("judgeWard and readSession: the turn from the session file, reports only from the ward's start", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sb-ward-unit-")), file = join(dir, "s.jsonl");
	dirs.push(dir);
	const main = { id: MAIN };
	writeFileSync(file, line({ type: "session", id: WORKER }) + user("go"));
	assert.equal((await readSession(file, 0, main)).turn, "working");
	appendFileSync(file, said("done"));
	assert.equal((await readSession(file, 0, main)).turn, "ended");
	appendFileSync(file, line({ type: "custom_message", customType: "x", content: "note" }));
	assert.equal((await readSession(file, 0, main)).turn, "ended", "a custom message after the turn is no turn");
	appendFileSync(file, calls("m", "MonitorCreate", { command: "sleep 60" }));
	assert.equal((await readSession(file, 0, main)).turn, "working");
	assert.equal((await readSession(join(dir, "none.jsonl"), 0, main)).turn, "unknown");
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

test("cli.mjs ward is retired (F003, boss decision (a)): parsed, then refused with a pointer to sb_ward, asking the server nothing", () => {
	assert.deepEqual(parseArgs(["ward", "%7", "--item", "MP-1", "--until", "2h"]), { command: "ward", flags: { pane: "%7", item: "MP-1", until: "2h" } });
	let err = "";
	assert.equal(runWard({ err: (t) => void (err += t) }), 1);
	assert.equal(err, `${WARD_CLI_REFUSED}\n`);
	assert.match(err, /sb_ward/);
});

test("a ward is kept in watches.json: a restarted server keeps it, does not tell a blocked spell again, and wakes on the next ending", async () => {
	const w = world();
	assert.equal((await w.add({ item: "MP-9" })).ok, true);
	w.set({ agent_status: "blocked" });
	await w.looks(2);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked"]);
	w.restart();
	await w.looks(1);
	assert.deepEqual((await w.list()).map((x) => [x.key, x.ward]), [["ward:%7", { pane: "%7", file: w.file, item: "MP-9" }]]);
	await w.looks(4);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked"], "the spell was told before the restart");
	w.drop();
	await w.looks(4);
	assert.deepEqual(w.sent.map((s) => s.state), ["blocked", "dead"]);
});

test("ward-review F003: only a live main of the server's reading wards, only a pane of its own workspace, and only it lists the ward's file or stops it", async () => {
	const w = world();
	assert.match(String((await w.add({}, MEMBER)).error), /only a tab's main wards a worker; your session is a member/);
	assert.match(String((await w.add({}, "0199eeee-none")).error), /not from a registered session/, "no pi process of it registered");
	w.units[MAIN]!.live = false;
	assert.match(String((await w.add()).error), /not a live unit of the net/);
	w.units[MAIN]!.live = true;
	w.other();
	assert.match(String((await w.add({}, MAIN, "ward:%9")).error), /not in your workspace/);
	// The workspace and the main's own pane are the server's reading, whatever the request says.
	assert.match(String((await watchReply(w.routes, { cmd: "ward-add", session: MAIN, secret: `s-${MAIN}`, workspace: "w2", key: "ward:%1", ward: { here: "%5" } }, () => true)!).error), /your own pane/);
	assert.match(String((await watchReply(w.routes, { cmd: "watch-add", session: MAIN, workspace: "w1", key: "ward:%7" }, () => true)!).error), /set with sb_ward/);
	assert.equal((await w.add()).ok, true);
	w.units[MAIN]!.role = "member";
	assert.deepEqual((await w.list()).map((x) => [x.ward, (x as { newest?: unknown }).newest]), [[{ pane: "%7" }, undefined]], "no file, nor the line that names it, for a session that is no main now");
	assert.match(String((await w.stop()).error), /only a tab's main/);
	w.units[MAIN]!.role = "main";
	assert.deepEqual((await w.list()).map((x) => x.ward), [{ pane: "%7", file: w.file }]);
	assert.equal((await w.stop()).ok, true);
});

test("F003 (boss decision (a)): a ward is added, listed with its file, and stopped only with the registration secret of its main's own pi process", async () => {
	const w = world();
	assert.match(String((await w.add({}, MAIN, "ward:%7", null)).error), /not from a registered session/, "no secret: a shell that names the main's id");
	assert.match(String((await w.add({}, MAIN, "ward:%7", "s-forged")).error), /not from a registered session/);
	assert.match(String((await w.add({}, MAIN, "ward:%7", `s-${MEMBER}`)).error), /not this session's/, "another live session's secret");
	assert.deepEqual(await w.list(), [], "nothing was set");
	assert.equal((await w.add()).ok, true);
	assert.deepEqual((await w.list()).map((x) => x.ward), [{ pane: "%7", file: w.file }], "its main sees the file");
	assert.deepEqual((await w.list(null)).map((x) => [x.ward, (x as { newest?: unknown }).newest]), [[{ pane: "%7" }, undefined]], "without the secret: no file, nor the line that names it");
	assert.deepEqual((await w.list(`s-${WORKER}`)).map((x) => x.ward), [{ pane: "%7" }], "nor with another's");
	assert.match(String((await w.stop(MAIN, null)).error), /not from a registered session/);
	assert.match(String((await w.stop(MAIN, `s-${WORKER}`)).error), /not this session's/);
	assert.equal((await w.list()).length, 1, "still warded");
	assert.equal((await w.stop()).ok, true);
	assert.deepEqual(await w.list(), []);
});

test("F003: a ward row an older build stored (main.names, set by the retired shell path) still reads, and the field is dropped", () => {
	const row = { pane: "%7", file: "/f.jsonl", worker: WORKER, offset: 3, item: "MP-1", main: { id: MAIN, names: ["boss-main"] } };
	assert.deepEqual(wardOf(row), { pane: "%7", file: "/f.jsonl", worker: WORKER, offset: 3, item: "MP-1", main: { id: MAIN } });
	assert.deepEqual(wardOf({ ...row, main: { id: MAIN } }), { pane: "%7", file: "/f.jsonl", worker: WORKER, offset: 3, item: "MP-1", main: { id: MAIN } });
});

test("ward-review F008: a look in flight when its ward is stopped keeps no reader when it finishes", async () => {
	const w = world();
	const held = () => w.routes.ward!.held();
	assert.equal((await w.add()).ok, true);
	assert.equal(held(), 1);
	let open!: () => void;
	w.hold.list = new Promise<void>((r) => (open = r));
	await settle();
	w.clock.advance(WARD_LOOK_MS); // the next look starts and waits on Herdr's list
	await settle();
	assert.equal((await w.stop()).ok, true);
	assert.equal(held(), 0);
	delete w.hold.list;
	open();
	await settle();
	assert.equal(held(), 0, "the look that ends after the stop recreates no reader");
});

test("ward-review F004: a change found but not taken before a restart is sent after it, with the same id; one taken is not sent again", async () => {
	const w = world();
	assert.equal((await w.add()).ok, true);
	w.takes.now = false; // the main does not answer
	w.set({ agent_status: "blocked" });
	await w.looks(4);
	assert.equal(w.sent.length, 0);
	w.restart();
	w.takes.now = true;
	await w.looks(4);
	assert.deepEqual(w.sent.map((x) => x.state), ["blocked"], "the blocked spell found before the restart is told after it");
	const id = w.sent[0]!.id;
	assert.ok(id);
	w.restart();
	await w.looks(4);
	assert.equal(w.sent.length, 1, "told once");

	const v = world();
	assert.equal((await v.add()).ok, true);
	v.takes.now = false;
	v.drop();
	await v.looks(1);
	v.restart();
	v.back(); // a pane list that lacked it for a moment
	v.takes.now = true;
	await v.looks(4);
	assert.deepEqual(v.sent.map((x) => x.state), ["dead"], "a dead found before the restart is told though the read after it is a fresh look");
});

test("ward-review F005: wards are kept in wards.json, apart from watches.json, so a server of an older build that rewrites watches.json leaves them for the next one", async () => {
	const w = world();
	assert.equal((await w.add({ item: "MP-9" })).ok, true);
	const read = (name: string) => (JSON.parse(readFileSync(join(w.dir, name), "utf8")) as { watches: { key: string }[] }).watches.map((r) => r.key);
	assert.deepEqual([read("watches.json"), read("wards.json")], [[], ["ward:%7"]]);
	w.restart();
	writeFileSync(join(w.dir, "watches.json"), JSON.stringify({ version: 1, watches: [] })); // an older server's save: the plain watches it knows
	w.restart();
	assert.deepEqual((await w.list()).map((x) => x.key), ["ward:%7"]);
});

test("ward-review F006: a moved worker whose old pane id now names another pane is found by its session file; a pane whose session Herdr does not name is judged nothing; a pane id on another terminal is a gone pane", async () => {
	const w = world();
	assert.equal((await w.add()).ok, true);
	w.set({ pane_id: "%8" });
	w.push({ pane_id: "%7", tab_id: "t2", workspace_id: "w1", terminal_id: "T9", agent: "pi", agent_status: "idle", agent_session: { value: "/other.jsonl" } });
	await w.looks(4);
	assert.equal(w.sent.length, 0, "the old id on another pane is not the worker");

	const u = world();
	assert.equal((await u.add()).ok, true);
	u.set({ agent_session: undefined, agent_status: "blocked" });
	u.write(said("done"));
	await u.looks(8);
	assert.equal(u.sent.length, 0, "no session named: neither blocked nor finished");
	u.set({ agent_session: { value: u.file } });
	await u.looks(2);
	assert.deepEqual(u.sent.map((x) => x.state), ["blocked"]);

	const g = world();
	assert.equal((await g.add()).ok, true);
	g.drop();
	g.push({ pane_id: "%7", tab_id: "t2", workspace_id: "w1", terminal_id: "T9", agent: "pi", agent_status: "idle" });
	await g.looks(2);
	assert.deepEqual(g.sent.map((x) => x.state), ["dead"]);
	assert.match(g.sent[0]!.text, /its pane is gone/);
});

test("ward-review F008: the reader goes on where it stopped, keeps a line not yet ended, and reads the first line at the ward's start however much came after it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sb-ward-read-")), file = join(dir, "s.jsonl"), main = { id: MAIN };
	dirs.push(dir);
	writeFileSync(file, line({ type: "session", id: WORKER }) + user("go"));
	const offset = readFileSync(file).length;
	// The report is the first line after the ward's start, and more than the tail came after it.
	appendFileSync(file, calls("c1", "call_peer", { to: "main", message: "done" }) + result("c1", "call_peer") + user("x".repeat(300 * 1024)) + said("next"));
	assert.equal((await readSession(file, offset, main)).reported, "call_peer");

	const g = join(dir, "g.jsonl");
	writeFileSync(g, line({ type: "session", id: WORKER }));
	const at = readFileSync(g).length, read = sessionReader(g, at, main, 64);
	const half = said("done");
	appendFileSync(g, user("go") + half.slice(0, 20));
	let r = await read();
	while (r.turn === "unknown") r = await read(); // 64 bytes a read: behind the file's end, the turn is unknown
	assert.equal(r.turn, "working");
	appendFileSync(g, half.slice(20));
	r = await read();
	while (r.turn === "unknown") r = await read();
	assert.equal(r.turn, "ended", "the line cut between two reads is read whole once");
	appendFileSync(g, calls("c2", "call_peer", { to: "main", message: "done" }) + result("c2", "call_peer"));
	for (let i = 0; i < 20 && !r.reported; i++) r = await read();
	assert.equal(r.reported, "call_peer");
});

test("ward-review F007: a worker that waits on its own watch of the server, or whose loops file does not read, is not finished", async () => {
	const w = world();
	w.set({ agent_status: "idle" });
	w.write(said("waiting on my watch"));
	const own = await w.routes.watches.add({ session: WORKER, workspace: "w1", key: "ward:%1", ward: { pane: "%1", file: "/none.jsonl", worker: "0199ffff", offset: 0, main: { id: WORKER } } });
	assert.equal(own.ok, true, JSON.stringify(own));
	assert.equal((await w.add()).ok, true);
	await w.looks(12);
	assert.deepEqual(w.sent.filter((x) => x.key === "ward:%7"), [], "its watch runs");
	w.routes.watches.stop(WORKER, "ward:%1");
	writeFileSync(join(w.loops, `loops-${WORKER}.json`), "{ not json");
	await w.looks(12);
	assert.deepEqual(w.sent.filter((x) => x.key === "ward:%7"), [], "a loops file that does not read is not none");
	writeFileSync(join(w.loops, `loops-${WORKER}.json`), JSON.stringify({ loops: [] }));
	await w.looks(6);
	assert.deepEqual(w.sent.filter((x) => x.key === "ward:%7").map((x) => x.state), ["finished"]);
});

test("ward-review F009: the first ward on a server with no page and no watch reads the net itself before it checks the main", async () => {
	const w = world();
	assert.equal(w.reading.done, 0);
	const r = await w.add();
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.ok(w.reading.done >= 1);
});

test("ward-review F004: an ending found before a restart goes out after it as it was, with its own id, past the deadline too; a change a restart found waiting is checked first", async () => {
	const w = world();
	assert.equal((await w.add({}, MAIN, "ward:%7")).ok, true);
	w.takes.lost = true; // the main takes it, the answer is lost
	w.drop();
	await w.looks(1);
	assert.deepEqual(w.sent.map((x) => x.state), ["dead"]);
	const id = w.sent[0]!.id;
	const kept = (JSON.parse(readFileSync(join(w.dir, "wards.json"), "utf8")) as { watches: { pending?: { id: string; state: string } }[] }).watches[0]!.pending;
	assert.deepEqual([kept?.state, kept?.id], ["dead", id]);
	w.restart();
	w.back(); // the pane is listed again: no new verdict replaces the ending
	w.clock.advance(7 * 3_600_000); // past the ward's 6 h: no `expired` replaces it either
	w.takes.lost = false;
	await w.looks(4);
	assert.deepEqual(w.sent.map((x) => [x.state, x.id]), [["dead", id], ["dead", id]], "sent again as it was, so the main drops the second");
	assert.deepEqual(await w.list(), []);

	const v = world();
	assert.equal((await v.add()).ok, true);
	v.takes.now = false;
	v.set({ agent_status: "blocked" });
	await v.looks(2);
	v.set({ agent_status: "working" }); // it goes on, and the server restarts before its next look
	v.restart();
	v.takes.now = true;
	await v.looks(6);
	assert.deepEqual(v.sent.map((x) => x.text), [], "a blocked spell that ended before the first reading is not told");
});

test("ward-review F006, F008: another session's file at the worker's path is not read as its; a line longer than the cap is dropped, not kept, and the reader goes on at the next line", async () => {
	const w = world();
	w.set({ agent_status: "idle" });
	assert.equal((await w.add()).ok, true);
	writeFileSync(w.file, line({ type: "session", id: "0199eeee-other" }) + said("done")); // the path now holds another session, whose turn ended
	await w.looks(12);
	assert.deepEqual(w.sent, [], "nothing is judged from another session's file");

	const dir = mkdtempSync(join(tmpdir(), "sb-ward-cap-")), file = join(dir, "s.jsonl"), main = { id: MAIN };
	dirs.push(dir);
	writeFileSync(file, line({ type: "session", id: WORKER }));
	const read = sessionReader(file, readFileSync(file).length, main, 64, 256);
	appendFileSync(file, "x".repeat(1000));
	for (let i = 0; i < 20; i++) assert.equal((await read()).turn, "unknown", "a long line not yet ended");
	appendFileSync(file, "\n" + said("done"));
	let r = await read();
	for (let i = 0; i < 20 && r.turn === "unknown"; i++) r = await read();
	assert.equal(r.turn, "ended");
});

test("ward-review F008: a ward lets go of its reader on every end: a stop, a replace, and its expiry", async () => {
	const w = world();
	const held = () => w.routes.ward!.held();
	assert.equal((await w.add()).ok, true);
	assert.equal(held(), 1);
	assert.equal((await w.stop()).ok, true);
	assert.equal(held(), 0, "a stop");
	assert.equal((await w.add()).ok, true);
	w.write(said("more"));
	assert.equal((await w.add()).ok, true, "the same pane again replaces the ward");
	assert.equal(held(), 1, "a replace keeps only the new ward's");
	const short = world();
	assert.equal((await short.add({}, MAIN, "ward:%7")).ok, true);
	const r = await watchReply(short.routes, { cmd: "ward-add", session: MAIN, secret: `s-${MAIN}`, key: "ward:%7", untilMs: 60_000, ward: {} }, () => true)!;
	assert.equal(r.ok, true);
	await short.looks(5);
	assert.deepEqual(short.sent.map((x) => x.state), ["expired"]);
	assert.equal(short.routes.ward!.held(), 0, "its expiry");
});

test("F003 review: list and stop take the role the car book reads now: a session the net last read as main but whose registration is a train's now is no main", async () => {
	const w = world();
	assert.equal((await w.add()).ok, true);
	w.bookRole[MAIN] = "train";
	assert.deepEqual((await w.list()).map((x) => x.ward), [{ pane: "%7" }], "no file");
	assert.match(String((await w.stop()).error), /only a tab's main wards a worker; your session is a train now/);
	assert.match(String((await w.add()).error), /your session is a train now/);
	delete w.bookRole[MAIN];
	assert.equal((await w.stop()).ok, true);
});

test("ward-review F008: a ward's reader is kept per watch instance: a look in flight of an ended instance keeps nothing, however many other wards ended meanwhile", async () => {
	let open!: () => void;
	const gate = new Promise<void>((r) => (open = r));
	const dir = mkdtempSync(join(tmpdir(), "sb-ward-live-")), file = join(dir, "s.jsonl");
	dirs.push(dir);
	writeFileSync(file, line({ type: "session", id: WORKER }) + said("done"));
	const pane: Pane = { pane_id: "%7", tab_id: "t2", workspace_id: "w1", agent: "pi", agent_status: "idle", agent_session: { value: file } };
	const ward = createWardRead({ run: async () => (await gate, JSON.stringify({ result: { panes: [pane] } })), now: () => 0, monitorPanes: () => new Set(), loopsDir: dir });
	const rec: WardRec = { pane: "%7", file, worker: WORKER, offset: 0, main: { id: MAIN } };
	const live = { ended: false };
	const look = ward.read({ ward: rec, live });
	live.ended = true;
	ward.forget(live);
	for (let i = 0; i < 1100; i++) ward.forget({ ended: true }); // many other wards end
	open();
	assert.equal((await look).ok, true);
	assert.equal(ward.held(), 0);
	const next = { ended: false };
	await ward.read({ ward: rec, live: next });
	assert.equal(ward.held(), 1, "a live instance keeps its reader");
});
