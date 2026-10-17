import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { readRecord } from "../src/gui.ts";
import type { Net, Unit } from "../src/net.ts";
import { selectDigest } from "../src/owners.ts";
import { type Agent, until, World } from "./fakes.ts";
import { assistant, call, header, lines, user } from "./sessions.ts";

// End to end through the fakes: session B's bridge relays a robot_hand selector over the fake broker to the hub of session A's GUI server,
// the page's answer goes back to B's owner, and the terminal answering first makes it stale.

const scratch = mkdtempSync(join(tmpdir(), "psb-answer-test-")), bundle = join(scratch, "bundle"), agentDir = join(scratch, "agent");
mkdirSync(bundle);
mkdirSync(join(agentDir, "sessions"), { recursive: true });
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");
const saved = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => ((process.env.PI_CODING_AGENT_DIR = saved), rmSync(scratch, { recursive: true, force: true })));
let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const SELECT = { title: "Robot Hand — List it\n\n  ! ls", choices: [{ label: "Run it in a new Herdr pane", note: "Runs it at once in a new pane" }, { label: "Copy it", localOnly: true as const }, { label: "No, thanks" }], copy: "ls" };
const DIGEST = selectDigest(SELECT);
const snapshot = (url: string) =>
	new Promise<Net>((resolve, reject) => {
		const req = get(`${url}events`, (res) => {
			let buffer = "";
			res.setEncoding("utf8").on("data", (chunk: string) => {
				buffer += chunk;
				const line = buffer.split("\n").find((l) => l.startsWith("data: "));
				if (line && buffer.includes("\n\n")) (req.destroy(), resolve(JSON.parse(line.slice(6)) as Net));
			});
		});
		req.on("error", reject);
	});
const post = (url: string, csrf: string, path: string, body: unknown) =>
	new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
		const { port, pathname } = new URL(url), data = JSON.stringify(body);
		const req = request({ host: "127.0.0.1", port, path: `${pathname}api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-sb-csrf": csrf, "content-length": String(Buffer.byteLength(data)) } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
		});
		req.on("error", reject).end(data);
	});

/** A (the GUI server) and B in tab wA:t1; B's pane runs pi on a session file whose newest message calls robot_hand. */
async function setup(sub = false) {
	world.herdr.addTab("wA:t1", "work");
	const herdrCall = async (method: string, params: Record<string, unknown>) => (method === "pane.get" ? { pane: world.herdr.pane(String(params.pane_id)) } : {});
	const a = world.agent({ id: "A", pane: "wA:p1", tab: "wA:t1", deps: { bundle, openUrl: async () => {}, call: herdrCall } });
	const b = world.agent({ id: "B", pane: "wA:p2", tab: "wA:t1", env: sub ? { PI_SUBAGENT_ID: "kid" } : undefined });
	// A subagent shows under its launcher: A's session file names the artifacts pi-herdr-agents writes, and B's file is named for the child.
	const file = join(agentDir, "sessions", sub ? "2026-10-18T00-00-00-000Z_kid-1a2b3c4d-5e6f7a8b-9c0d.jsonl" : "2026_B.jsonl");
	if (sub) {
		const parent = join(agentDir, "sessions", "2026-10-18T00-00-00-000Z_A.jsonl"), artifacts = join(agentDir, "sessions", "artifacts", "A");
		mkdirSync(join(artifacts, "subagent-activity"), { recursive: true });
		writeFileSync(join(artifacts, "subagent-activity", "kid.json"), JSON.stringify({ phase: "active" }));
		writeFileSync(parent, lines([header("A")]));
		Object.assign(world.herdr.pane("wA:p1"), { agent_session: { value: parent } });
		a.file = parent;
	}
	writeFileSync(file, lines([header("B"), user("u1", null, "go"), assistant("a1", "u1", [call("c1", "robot_hand", { command: "ls", reason: "List it" })])]));
	Object.assign(world.herdr.pane("wA:p2"), { agent_session: { value: file } });
	b.file = file;
	await Promise.all([a.start(), b.start()]);
	await a.command("gui");
	const url = a.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).find(Boolean)!;
	return { a, b, url, csrf: readRecord(world.stateDir)!.csrf! };
}
/** robot_hand in B: the call starts, the selector opens, and the owner settles the first of terminal and answer. */
function selector(b: Agent) {
	let by: string | undefined;
	const got: unknown[] = [];
	void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "robot_hand", args: {} });
	const off = b.on("robot-hand:answer", (raw) => {
		const x = raw as { id: string; answerId: string; selections: number[] };
		const accepted = !by && x.id === "d1";
		b.emit("robot-hand:answer-result", { version: 1, id: x.id, answerId: x.answerId, accepted, ...(accepted ? {} : { reason: "closed" }) });
		if (accepted) (got.push(x.selections), (by = "remote"), b.emit("robot-hand:closed", { version: 1, id: "d1", by, answerId: x.answerId }));
	});
	b.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "c1", digest: DIGEST, select: SELECT });
	return { got, off, terminal: () => ((by = "local"), b.emit("robot-hand:closed", { version: 1, id: "d1", by })) };
}
const unitB = (n: Net) => n.bases.flatMap((x) => x.tabs.flatMap((t) => t.units)).find((u) => u.key === "B") as Unit | undefined;

test("a robot_hand selector in another session is answered from the page, once, through its own owner", async () => {
	const { b, url, csrf } = await setup();
	assert.equal(readRecord(world.stateDir)?.ownerSession, "A", "gui.json names the server's session");
	const hand = selector(b);
	let seen: Unit | undefined;
	await until(async () => (seen = unitB(await snapshot(url)))?.pending?.answer, "B's dialog in the snapshot");
	assert.equal(seen!.mark, "waiting");
	assert.deepEqual(seen!.pending!.answer, { dialog: "d1", digest: DIGEST, select: SELECT });
	const body = { dialog: "d1", digest: DIGEST, answerId: "a".repeat(20), choice: 0 };
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", body), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(hand.got, [[0]]);
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", body), { status: 200, body: { outcome: "accepted" } }, "the same answer again replays");
	assert.deepEqual(hand.got, [[0]], "applied once");
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", { ...body, answerId: "b".repeat(20) }), { status: 200, body: { outcome: "stale", by: "remote" } }, "another answer later hears it is closed");
	hand.off();
});

test("the terminal answering first makes a page's answer stale, and the owner never sees a second choice", async () => {
	const { b, url, csrf } = await setup();
	const hand = selector(b);
	await until(async () => unitB(await snapshot(url))?.pending?.answer, "B's dialog in the snapshot");
	// The page still shows the dialog when the terminal settles it: the server's own reading is a moment behind.
	hand.terminal();
	// Whether the bridge still had it open (it refuses it) or had already reported it closed (the hub says so), the page hears the same.
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", { dialog: "d1", digest: DIGEST, answerId: "c".repeat(20), choice: 2 }), { status: 200, body: { outcome: "stale", by: "local" } });
	assert.deepEqual(hand.got, []);
	hand.off();
});

test("a subagent's dialog is answered too, and a pi outside Herdr relays nothing", async () => {
	const { b, url, csrf } = await setup(true);
	const hand = selector(b), kid = (n: Net) => n.bases.flatMap((x) => x.tabs.flatMap((t) => t.units.flatMap((u) => u.subs))).find((u) => u.key === "kid");
	await until(async () => kid(await snapshot(url))?.pending?.answer, "the subagent's dialog under its launcher");
	assert.deepEqual(await post(url, csrf, "sessions/kid/answer", { dialog: "d1", digest: DIGEST, answerId: "d".repeat(20), choice: 2 }), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(hand.got, [[2]]);
	hand.off();
	const outside = world.agent({ id: "C", pane: "wA:p3", tab: "wA:t1", outsideHerdr: true });
	await outside.start();
	assert.deepEqual(["robot-hand:pending", "rpiv:ask-user:prompt"].map((c) => outside.bus.get(c)?.length ?? 0), [0, 0], "no owner is listened to outside Herdr");
});

test("an owner that stays silent: the answer is not confirmed, Check again replays it, another answer hears busy, and the owner's close settles it", async () => {
	const { b, url, csrf } = await setup();
	void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "robot_hand", args: {} });
	b.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "c1", digest: DIGEST, select: SELECT });
	await until(async () => unitB(await snapshot(url))?.pending?.answer, "B's dialog in the snapshot");
	const body = { dialog: "d1", digest: DIGEST, answerId: "e".repeat(20), choice: 2 };
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", body), { status: 200, body: { outcome: "unknown" } }, "no verdict within 2 s");
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", body), { status: 200, body: { outcome: "unknown" } }, "Check again reaches the bridge and replays, not 'changed'");
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", { ...body, answerId: "f".repeat(20), choice: 0 }), { status: 200, body: { outcome: "busy" } });
	b.emit("robot-hand:closed", { version: 1, id: "d1", by: "remote", answerId: body.answerId });
	await until(async () => !unitB(await snapshot(url))?.pending, "the dialog closed");
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", body), { status: 200, body: { outcome: "accepted" } }, "the owner took it after all");
});
