import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readPointer } from "../src/server/bossconv.ts";
import { fileOf } from "../src/server/record.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { bundle, noLink, noTailscale } from "./gui-fakes.ts";
import { type Answer, call, type Request, rig as makeRig, scratchRoot } from "./run-rig.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The pi side of a run (src/runmode.ts, a real pi session with a faux model) against the real sb server of a test world (src/server/main.ts, a fake Herdr and fake pi-intercom clients): the two halves
// of the protocol agree on every request and reply (docs/specs/2026-10-26-sb-backend.md, Real pi session, Integration).

let world: TowerWorld, root = "";
const sessions: AgentSession[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	root = scratchRoot();
});
afterEach(async () => {
	for (const s of sessions.splice(0)) s.dispose();
	await world.close();
	rmSync(root, { recursive: true, force: true });
});
const from = { id: "main-1", name: "docs-main" };

test("an event wakes a run; the run claims, takes the event, answers with tower_reply under the tower identity, and ends with tower_done: the server records the note and the run as done", async () => {
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } }];
	const s: Running = await world.start({ gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200 } });
	await s.handle.ready;
	const serverAsk = (r: Request): Promise<Answer> => callControl(s.handle.endpoint, world.record()!.secret, r as { cmd: string }).then((x) => x.reply as Answer);
	await serverAsk({ cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming(from, { id: "m1", content: { text: "[straw net from=docs-main] where does the deploy stand?" } });
	await until(() => world.pis.size === 1, "the run's pi");
	const [id, pi] = [...world.pis.entries()][0]!;
	const received: string[] = [];
	// The pi of the faux session is not the fake pi the server recorded: its claim carries the recorded pane, pid, and start time.
	const ask = (r: Request) => (r.cmd === "claim" ? serverAsk({ ...r, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` }) : serverAsk(r)).then((a) => (received.push(String(r.cmd)), a));
	const r = await makeRig(root, ask, sessions, { flag: id });
	const seen: string[] = [];
	r.faux.setResponses([
		((context: { messages: unknown[] }) => (seen.push(JSON.stringify(context.messages)), call("tower_reply", { to: "docs-main", message: "deploy is green", reply: false }))) as never,
		call("tower_done", { note: "answered docs-main about the deploy" }),
		fauxAssistantMessage("done"),
	]);
	await until(() => r.shutdowns.length === 1, "the run to end itself");
	assert.match(seen[0]!, /where does the deploy stand/, "the event reached the model");
	assert.match(seen[0]!, /tower of workspace Alpha/, "with the server's brief in the role section");
	const sent = world.client("sb-tower-wa")!.sent.at(-1)!;
	assert.equal(sent.to, "main-1");
	assert.match(sent.text, /id=sb-tower-wa role=tower/);
	assert.match(sent.text, /kind=tower_reply/);
	assert.ok(sent.text.endsWith("] deploy is green"));
	for (const cmd of ["claim", "run-file", "run-poll", "run-taken", "run-tool", "run-done"]) assert.ok(received.includes(cmd), `the run asked ${cmd}`);
	// pi is gone: the pane is back at its shell, and the server closes the run.
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run recorded as done");
	assert.equal(readRun(world.slot, "wA", id)?.events.length, 1);
	assert.deepEqual(readQueue(world.slot, "wA").filter((e) => !e.taken), [], "nothing is left in the queue");
	const status = (await serverAsk({ cmd: "status" })).towers as { service: { state: string } }[];
	assert.equal(status[0]!.service.state, "standing");
});

test("an ally run: a teammate's message wakes a run in its own pane; the run claims at the sender's level, answers the ask by inReplyTo through the server, and ends; the message leaves the inbox and the pane closes", async () => {
	const DEV = "a".repeat(26), TEAM = "1".repeat(32), ASK = "c".repeat(32);
	mkdirSync(join(root, "project"), { recursive: true });
	mkdirSync(join(root, "straw-boss"), { recursive: true });
	writeFileSync(join(root, "straw-boss", "config.json"), JSON.stringify({ link: { teams: { [TEAM]: { project: join(root, "project") } }, trust: { [DEV]: "reply" } } }));
	const s: Running = await world.start({ gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200 } });
	await s.handle.ready;
	const serverAsk = (r: Request): Promise<Answer> => callControl(s.handle.endpoint, world.record()!.secret, r as { cmd: string }).then((x) => x.reply as Answer);
	await serverAsk({ cmd: "ensure-tower", workspace: "wA" });
	world.linkAnswers.set("send", (b) => ({ ok: true, text: "Sent.", details: { device: b.device } }));
	world.ally.add("m1", DEV, "is the deploy green?", { team: TEAM, label: "Carol Mac", awaitsReply: ASK, replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size === 1, "the ally run's pi");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const ask = (r: Request) => (r.cmd === "claim" ? serverAsk({ ...r, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` }) : serverAsk(r));
	const r = await makeRig(root, ask, sessions, { flag: id });
	const seen: string[] = [];
	r.faux.setResponses([
		((context: { messages: unknown[] }) => (seen.push(JSON.stringify(context.messages)), call("tower_send", { device: "Carol Mac", message: "yes, green", inReplyTo: ASK }))) as never,
		call("tower_done", { note: "answered Carol about the deploy" }),
		fauxAssistantMessage("done"),
	]);
	await until(() => r.shutdowns.length === 1, "the run to end itself");
	assert.match(seen[0]!, /is the deploy green\?/);
	assert.match(seen[0]!, new RegExp(`asks=${ASK}`), "the ask id is in the header the server wrote");
	assert.match(seen[0]!, /You are an ally run/, "the ally brief");
	const sent = world.linkCalls.find((c) => c.body.op === "send")!;
	assert.equal(sent.body.device, DEV, "to the sender's full id");
	assert.equal(sent.body.inReplyTo, ASK);
	assert.equal(sent.from, "sb-tower-wa");
	const pane = readRun(world.slot, "wA", id)!.pane;
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run recorded as done");
	assert.deepEqual(world.ally.takenIds, ["m1"]);
	assert.ok(world.herdr.closed.includes(pane));
	assert.equal(readRun(world.slot, "wA", id)?.kind, "ally");
});

test("a boss conversation of a real pi session: pi writes the new session's file only at its first assistant message, yet it becomes the boss session, and after /quit the next conversation resumes that file", async () => {
	const s: Running = await world.start({ gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200 } });
	await s.handle.ready;
	const serverAsk = (r: Request): Promise<Answer> => callControl(s.handle.endpoint, world.record()!.secret, r as { cmd: string }).then((x) => x.reply as Answer);
	await serverAsk({ cmd: "ensure-tower", workspace: "wA" });
	assert.equal((await serverAsk({ cmd: "tower-event", workspace: "wA", text: "hello boss", present: true })).ok, true);
	await until(() => world.pis.size === 1, "the conversation's pi");
	const [id, pi] = [...world.pis.entries()][0]!;
	let token = "";
	const ask = (r: Request) => (r.cmd === "claim" ? serverAsk({ ...r, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` }).then((a) => ((token = String(a.token)), a)) : serverAsk(r));
	const sessionDir = join(world.env.PI_CODING_AGENT_DIR!, "sessions", "--proj--");
	const r = await makeRig(root, ask, sessions, { flag: id, sessionDir });
	const onDiskAtTheModel: boolean[] = [];
	r.faux.setResponses([((_context: unknown) => (onDiskAtTheModel.push(existsSync(sessionDir) && readdirSync(sessionDir).length > 0), fauxAssistantMessage("hello"))) as never]);
	await until(() => readPointer(world.slot, "wA") !== undefined, "the boss session to be kept once pi has written it");
	assert.deepEqual(onDiskAtTheModel, [false], "pi had not written the file when the model was asked");
	const file = r.session.sessionManager.getSessionFile()!;
	assert.ok(existsSync(file));
	assert.equal(readPointer(world.slot, "wA")!.file, realpathSync(file));
	assert.doesNotMatch(readFileSync(fileOf(world.slot, "log"), "utf8"), /error code=conversation/);
	// /quit: the extension tells the server the boss left; pi is gone.
	assert.equal((await serverAsk({ cmd: "run-done", token, left: true })).ok, true);
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the conversation to end as done");
	assert.equal((await serverAsk({ cmd: "tower-event", workspace: "wA", text: "again", present: true })).ok, true);
	await until(() => world.pis.size === 2, "the second conversation's pi");
	const args = [...world.pis.values()][1]!.args;
	assert.equal(args[args.indexOf("--session") + 1], realpathSync(file), "the next conversation resumes the same file");
});
