import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fieldsOf } from "../src/header.ts";
import type { Request } from "../src/server/socket.ts";
import { watchdogReply } from "../src/server/watchdogops.ts";
import { createWatchReport } from "../src/server/watchreport.ts";
import { fakeClock } from "./fake-clock.ts";

// The sb server's `watch-report` route (docs/specs/2026-11-09-agent-kinds.md §10): a watchdog child's one message to its dispatcher. The server ties the caller to a watchdog by pi-herdr-agents' own files (the activity file, a launch or
// resume script, the child's session file), keeps the rate and the repeat rule, and sends under a `watch_report` header in the child's name. The files here are laid out as pi-herdr-agents writes them.

const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-report-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;

interface Laid { session: string; child: string; activityFile: string; parent: string; scripts: string }
/** A parent session `parent` that launched the child `child` under `name`; what is written is the test's. */
function lay(o: { agent?: string | null; entry?: string | null; phase?: string; script?: "launch" | "resume" | "none"; sessionFile?: boolean; name?: string } = {}): Laid & { sessions: string } {
	const sessions = join(root, `agent-${++n}`, "sessions"), folder = join(sessions, "--Users-me-proj--"), parent = `parent${n}`, child = `kid${n}`;
	const art = join(folder, "artifacts", parent), scripts = join(art, "subagent-scripts"), activityFile = join(art, "subagent-activity", `${child}.json`);
	const session = join(folder, `2026-11-14T00-00-00-000Z_${child}-1a2b-3c4d-5e6f.jsonl`), name = o.name ?? "watch-train";
	mkdirSync(scripts, { recursive: true });
	mkdirSync(dirname(activityFile), { recursive: true });
	writeFileSync(join(folder, `2026-11-13T00-00-00-000Z_${parent}.jsonl`), "{}\n");
	writeFileSync(activityFile, JSON.stringify({ version: 1, id: child, phase: o.phase ?? "active", updatedAt: 1 }));
	const agent = o.agent === undefined ? "watchdog" : o.agent, lines = (id: string, withAgent: boolean) => `#!/bin/sh\nexport PI_SUBAGENT_ID='${id}'\nexport PI_SUBAGENT_NAME='${name}'\nexport PI_SUBAGENT_SESSION='${session}'\n${withAgent && agent ? `export PI_SUBAGENT_AGENT='${agent}'\n` : ""}exec pi\n`;
	if ((o.script ?? "launch") === "launch") writeFileSync(join(scripts, `${name}-${child}.sh`), lines(child, true));
	if (o.script === "resume") writeFileSync(join(scripts, `${name}-resume-1763078400000.sh`), lines(child, false));
	const entry = o.entry === undefined ? "watchdog" : o.entry;
	if (o.sessionFile !== false) writeFileSync(session, `${JSON.stringify({ type: "session", id: child })}\n${entry ? `${JSON.stringify({ type: "custom", customType: "straw-boss", data: { agent: entry } })}\n` : ""}`);
	return { sessions, session, child, activityFile, parent, scripts };
}

function reporter(sessions: string, o: { live?: string[]; delivery?: "socket_delivered" | "queued" | "failed"; offline?: boolean } = {}) {
	const clock = fakeClock(1_700_000_000_000), sent: { to: string; text: string; messageId?: string }[] = [];
	const intercom = { listSessions: async () => (o.live ?? []).map((id) => ({ id, name: `name of ${id}` })) as never, send: async (to: string, m: { text: string; messageId?: string }) => (sent.push({ to, ...m }), { id: "x", delivered: o.delivery !== "failed", delivery: o.delivery ?? "socket_delivered", ...(o.delivery === "failed" ? { reason: "no such session" } : {}) }) };
	const report = createWatchReport({ sessionsDir: sessions, now: clock.now, intercom: () => (o.offline ? undefined : intercom) });
	const dog = { read: { read: async () => ({ ok: true }) }, report };
	return { clock, sent, send: (l: Laid, text: string, more: Record<string, unknown> = {}) => watchdogReply(dog, { cmd: "watch-report", session: l.session, child: l.child, activityFile: l.activityFile, text, ...more } as Request)! };
}

test("a watchdog's report reaches its parent, and only its parent, under kind=watch_report from `watchdog <child name>` with role=session and reply=none; the reply says delivered or queued", async () => {
	const l = lay(), r = reporter(l.sessions, { live: [l.parent, "someone-else"] });
	assert.deepEqual(await r.send(l, "train 1114-a: gate step failed (exit 1)", { to: "someone-else", parent: "someone-else" }), { ok: true, delivery: "delivered" });
	assert.equal(r.sent.length, 1);
	assert.equal(r.sent[0]!.to, l.parent, "an extra `to` is ignored: the parent comes from the activity file's folder");
	assert.match(r.sent[0]!.messageId!, /^watch-report-/);
	const f = fieldsOf(r.sent[0]!.text)!;
	assert.equal(f.kind, "watch_report");
	assert.equal(f.from, "watchdog watch-train");
	assert.equal(f.id, l.child);
	assert.equal(f.role, "session");
	assert.equal(f.reply, "none");
	assert.ok(r.sent[0]!.text.endsWith("] train 1114-a: gate step failed (exit 1)"), r.sent[0]!.text);
	const q = lay(), queued = reporter(q.sessions, { live: [q.parent], delivery: "queued" });
	assert.deepEqual(await queued.send(q, "hello"), { ok: true, delivery: "queued" });
});

test("a dispatcher that ended is `gone` and nothing is sent; a broker that is not connected, or that does not take the message, is an error", async () => {
	const l = lay(), r = reporter(l.sessions, { live: ["other"] });
	assert.deepEqual(await r.send(l, "x"), { ok: true, delivery: "gone" });
	assert.equal(r.sent.length, 0);
	const off = reporter(l.sessions, { offline: true });
	assert.deepEqual(await off.send(l, "x"), { ok: false, error: "pi-intercom is not connected" });
	const failing = reporter(l.sessions, { live: [l.parent], delivery: "failed" });
	assert.deepEqual(await failing.send(l, "x"), { ok: false, error: "not delivered: no such session" });
});

test("a resumed watchdog is accepted: a new id that only a `-resume-` script carries, and the entry in its session file", async () => {
	const l = lay({ script: "resume" }), r = reporter(l.sessions, { live: [l.parent] });
	assert.deepEqual(await r.send(l, "still watching"), { ok: true, delivery: "delivered" });
	assert.equal(fieldsOf(r.sent[0]!.text)!.from, "watchdog watch-train", "named by the resume script's name");
});

test("a first launch whose session file pi has not written yet is accepted by its watchdog launch script, and by nothing less", async () => {
	const l = lay({ sessionFile: false }), r = reporter(l.sessions, { live: [l.parent] });
	assert.deepEqual(await r.send(l, "sb: watchdog watch-train cannot start: its tool list lacks watch_read/watch_report (a spawn tools override?)"), { ok: true, delivery: "delivered" });
	const worker = lay({ sessionFile: false, agent: "worker" });
	assert.deepEqual(await reporter(worker.sessions, { live: [worker.parent] }).send(worker, "x"), { ok: false, error: "not a watchdog's session" });
	const resumed = lay({ sessionFile: false, script: "resume" });
	assert.deepEqual(await reporter(resumed.sessions, { live: [resumed.parent] }).send(resumed, "x"), { ok: false, error: "not a watchdog's session" }, "a resume script names no agent");
	// The session file exists and holds no entry yet (the first turn has not run): the launch script still stands in.
	const early = lay({ entry: null });
	assert.deepEqual(await reporter(early.sessions, { live: [early.parent] }).send(early, "x"), { ok: true, delivery: "delivered" });
});

test("refused: a path outside the sessions folder, no script that ties the child to the session, a child that is done, and a session that is not a watchdog's", async () => {
	const l = lay(), r = reporter(l.sessions, { live: [l.parent] });
	const outside = join(root, "elsewhere", "artifacts", "p", "subagent-activity", `${l.child}.json`);
	mkdirSync(dirname(outside), { recursive: true });
	writeFileSync(outside, "{}");
	assert.deepEqual(await r.send({ ...l, activityFile: outside }, "x"), { ok: false, error: "outside the sessions folder" });
	assert.deepEqual(await r.send({ ...l, session: join(root, "elsewhere", "s.jsonl") }, "x"), { ok: false, error: "outside the sessions folder" });
	assert.deepEqual(await r.send({ ...l, activityFile: join(dirname(l.activityFile), "..", "..", "..", "..", "..", "..", "elsewhere", "artifacts", "p", "subagent-activity", `${l.child}.json`) }, "x"), { ok: false, error: "outside the sessions folder" }, "dots that lead out");
	const link = join(dirname(l.activityFile), "linked.json");
	symlinkSync(outside, link);
	assert.deepEqual(await r.send({ ...l, child: "linked", activityFile: link }, "x"), { ok: false, error: "outside the sessions folder" }, "a link that leads out");
	assert.deepEqual(await r.send({ ...l, activityFile: join(dirname(l.activityFile), "missing.json"), child: "missing" }, "x"), { ok: false, error: "outside the sessions folder" }, "no such activity file");
	assert.deepEqual(await r.send({ ...l, activityFile: l.session }, "x"), { ok: false, error: "outside the sessions folder" }, "not <artifacts>/subagent-activity/<child>.json");
	// Another child's activity file under the same parent: no script carries that id.
	writeFileSync(join(dirname(l.activityFile), "other.json"), JSON.stringify({ phase: "active" }));
	assert.deepEqual(await r.send({ ...l, child: "other", activityFile: join(dirname(l.activityFile), "other.json") }, "x"), { ok: false, error: "no launch script ties other to that session" });
	const untied = lay({ script: "none" });
	assert.deepEqual(await reporter(untied.sessions, { live: [untied.parent] }).send(untied, "x"), { ok: false, error: `no launch script ties ${untied.child} to that session` });
	// The script ties the child to another session file than the one named.
	const stray = join(dirname(l.session), "2026-11-14T00-00-00-000Z_stray.jsonl");
	writeFileSync(stray, `${JSON.stringify({ type: "custom", customType: "straw-boss", data: { agent: "watchdog" } })}\n`);
	assert.deepEqual(await r.send({ ...l, session: stray }, "x"), { ok: false, error: `no launch script ties ${l.child} to that session` });
	const done = lay({ phase: "done" });
	assert.deepEqual(await reporter(done.sessions, { live: [done.parent] }).send(done, "x"), { ok: false, error: "that child is done" });
	// A scout: its session's entry says so, whatever a script claims; and a worker with neither.
	const scout = lay({ entry: "scout" });
	assert.deepEqual(await reporter(scout.sessions, { live: [scout.parent] }).send(scout, "x"), { ok: false, error: "not a watchdog's session" });
	const worker = lay({ agent: "worker", entry: null });
	assert.deepEqual(await reporter(worker.sessions, { live: [worker.parent] }).send(worker, "x"), { ok: false, error: "not a watchdog's session" });
	assert.equal(r.sent.length, 0, "nothing was sent");
});

test("one report every 30 s per session, and never the same text as the last; a refused report counts for neither", async () => {
	const l = lay(), r = reporter(l.sessions, { live: [l.parent] });
	assert.deepEqual(await r.send(l, "first"), { ok: true, delivery: "delivered" });
	r.clock.advance(29_999);
	assert.deepEqual(await r.send(l, "second"), { ok: false, error: "rate: one report every 30 s" });
	r.clock.advance(1);
	assert.deepEqual(await r.send(l, "first"), { ok: false, error: "same text as the last report" });
	assert.deepEqual(await r.send(l, "second"), { ok: true, delivery: "delivered" });
	r.clock.advance(3_600_000);
	assert.deepEqual(await r.send(l, "second"), { ok: false, error: "same text as the last report" }, "an hour later too");
	assert.deepEqual(await r.send(l, "third"), { ok: true, delivery: "delivered" });
	assert.equal(r.sent.length, 3);
	// Another watchdog of the same parent has a clock of its own.
	const other = lay(), o = reporter(other.sessions, { live: [other.parent] });
	assert.deepEqual(await o.send(other, "first"), { ok: true, delivery: "delivered" });
});

test("the text is 1 to 2000 plain characters, and the three paths and the id are strings of a sane length", async () => {
	const l = lay(), r = reporter(l.sessions, { live: [l.parent] }), bad = { ok: false, error: "text is 1 to 2000 plain characters" };
	assert.deepEqual(await r.send(l, ""), bad);
	assert.deepEqual(await r.send(l, "   "), bad);
	assert.deepEqual(await r.send(l, "x".repeat(2001)), bad);
	assert.deepEqual(await r.send(l, "a\u001b[31mb"), bad);
	assert.deepEqual(await r.send(l, 5 as never), bad);
	assert.deepEqual(await r.send({ ...l, child: "../x" }, "x"), { ok: false, error: "watch-report needs session, child, and activityFile" });
	assert.deepEqual(await r.send({ ...l, session: undefined as never }, "x"), { ok: false, error: "watch-report needs session, child, and activityFile" });
	assert.deepEqual(await r.send(l, `two lines\n${"x".repeat(1990)}`), { ok: true, delivery: "delivered" });
	assert.deepEqual(await watchdogReply(undefined, { cmd: "watch-report" }), { ok: false, error: "the server is still starting" });
});
