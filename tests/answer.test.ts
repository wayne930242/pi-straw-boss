import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, mock, test } from "node:test";
import { readRecord } from "../src/handover.ts";
import type { Net, Unit } from "../src/net.ts";
import { guiNamespace } from "../src/bridge.ts";
import { secretDigest, selectDigest } from "../src/owners.ts";
import { newKeys, seal } from "../src/seal.ts";
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
				// The first plain message: named events (hello) come before it.
				const block = buffer.split("\n\n").slice(0, -1).find((b) => !b.startsWith("event: "));
				if (block) (req.destroy(), resolve(JSON.parse(block.slice(6)) as Net));
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
async function setup(sub = false, calls: [string, string][] = [["c1", "robot_hand"]], ui = false) {
	world.herdr.addTab("wA:t1", "work");
	const herdrCall = async (method: string, params: Record<string, unknown>) => (method === "pane.get" ? { pane: world.herdr.pane(String(params.pane_id)) } : {});
	const a = world.agent({ id: "A", pane: "wA:p1", tab: "wA:t1", deps: { bundle, openUrl: async () => {}, call: herdrCall } });
	const b = world.agent({ id: "B", pane: "wA:p2", tab: "wA:t1", ui, env: sub ? { PI_SUBAGENT_ID: "kid" } : undefined });
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
	writeFileSync(file, lines([header("B"), user("u1", null, "go"), assistant("a1", "u1", calls.map(([id, name]) => call(id, name, { command: "ls", reason: "List it" })))]));
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

const GATE = { title: "Allow edit?\n\n  src/a.ts", choices: [{ label: "Allow" }, { label: "Deny" }] }, GATE_DIGEST = selectDigest(GATE);

test("a pi-code hook gate on one of two open calls is answered from the page with Allow and Deny, through its own owner", async () => {
	const { b, url, csrf } = await setup(false, [["c1", "bash"], ["c2", "edit"]]);
	const got: [string, number[]][] = [];
	let open = "";
	const off = b.on("pi-code:dialog:answer", (raw) => {
		const x = raw as { id: string; answerId: string; selections: number[] };
		b.emit("pi-code:dialog:answer-result", { version: 1, id: x.id, answerId: x.answerId, accepted: x.id === open });
		if (x.id === open) (got.push([x.id, x.selections]), b.emit("pi-code:dialog:closed", { version: 1, id: x.id, by: "remote", answerId: x.answerId }));
	});
	void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	void b.fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: {} });
	for (const [id, callId, choice] of [["g1", "c2", 0], ["g2", "c1", 1]] as const) {
		open = id;
		b.emit("pi-code:dialog:pending", { version: 1, id, toolCallId: callId, digest: GATE_DIGEST, select: GATE });
		let seen: Unit | undefined;
		await until(async () => (seen = unitB(await snapshot(url)))?.pending?.answer?.dialog === id, `${id} in the snapshot`);
		assert.deepEqual(seen!.pending, { callId, tool: callId === "c2" ? "edit" : "bash", answer: { dialog: id, digest: GATE_DIGEST, select: GATE } });
		assert.deepEqual(await post(url, csrf, "sessions/B/answer", { dialog: id, digest: GATE_DIGEST, answerId: String(choice).repeat(20), choice }), { status: 200, body: { outcome: "accepted" } });
	}
	assert.deepEqual(got, [["g1", [0]], ["g2", [1]]], "Allow, then Deny");
	off();
});

test("two open calls with two relayed gate dialogs stay terminal-only", async () => {
	const { b, url } = await setup(false, [["c1", "bash"], ["c2", "edit"]]);
	void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	void b.fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: {} });
	for (const [id, callId] of [["g1", "c1"], ["g2", "c2"]]) b.emit("pi-code:dialog:pending", { version: 1, id, toolCallId: callId, digest: GATE_DIGEST, select: GATE });
	await until(async () => unitB(await snapshot(url))?.pending?.why, "B's dialogs in the snapshot");
	const pending = unitB(await snapshot(url))!.pending!;
	assert.deepEqual([pending.answer, pending.why], [undefined, "It waits on more than one dialog."]);
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

test("a close from the page reaches the session's own bridge: it answers yes, quits as /quit would, and its pane closes", async () => {
	const { b, url, csrf } = await setup();
	await until(async () => unitB(await snapshot(url)), "B in the snapshot");
	// B's bridge finds the new server at its next look at gui.json (within 2 s); until then the server cannot reach it.
	let r = await post(url, csrf, "close/unit", { key: "B" });
	for (let i = 0; i < 60 && /did not answer/.test(String(r.body.reason)); i++) (await new Promise((done) => setTimeout(done, 50)), (r = await post(url, csrf, "close/unit", { key: "B" })));
	assert.equal(r.status, 200, JSON.stringify(r.body));
	await until(() => b.stopped && world.herdr.closed.includes("wA:p2"), "B quit and its pane closed");
});

const SECRET = { label: "Deploy token", instructions: ["Open the link.", "Create a token."], url: "https://example.com/tokens", destination: ".env.local (DEPLOY_TOKEN)" };
/** Every file under `dir`, read as text. */
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [readFileSync(join(dir, n), "utf8")]));

test("a secret_drop in another session is answered from no page (SB-F001): a value POSTed from this computer's page is refused, nothing reaches the owner or the channel, and the value lands nowhere", async () => {
	const { a, b, url, csrf } = await setup(false, [["c1", "secret_drop"]]), value = "tok-e2e-7c1d9a-not-for-logs", digest = secretDigest(SECRET);
	const c = world.agent({ id: "C", pane: "wA:p3", tab: "wA:t1" });
	await c.start();
	const ns = guiNamespace("A"), heard: Record<string, unknown>[] = [];
	await until(() => c.regs.get(ns), "C on the server's channel");
	const reg = c.regs.get(ns)!, onEvent = reg.onEvent;
	reg.onEvent = (e: Record<string, unknown>) => (heard.push(e), onEvent(e));
	const written: string[] = [];
	for (const stream of [process.stdout, process.stderr]) mock.method(stream, "write", ((chunk: unknown) => (written.push(String(chunk)), true)) as never);
	for (const level of ["log", "info", "warn", "error", "debug"] as const) mock.method(console, level, (...args: unknown[]) => void written.push(args.map(String).join(" ")));
	const got: unknown[] = [], seen: string[] = [], replies: unknown[] = [];
	try {
		Object.assign(world.herdr.pane("wA:p2"), { agent_status: "blocked" }); // Herdr sees pi stopped on the secret_drop's terminal dialog
		void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "secret_drop", args: {} });
		b.on("robot-hand:secret:answer", (raw) => got.push(raw));
		b.emit("robot-hand:secret:pending", { version: 1, id: "s1", toolCallId: "c1", digest, secret: SECRET });
		let unit: Unit | undefined;
		await until(async () => (unit = unitB(await snapshot(url)))?.pending?.why, "B's secret_drop wait in the snapshot");
		seen.push(JSON.stringify(unit));
		assert.deepEqual(unit!.pending, { callId: "c1", tool: "secret_drop", why: "It waits for a secret." }, "read-only: no dialog, no field, nothing of what it asks for");
		for (const body of [{ value }, { value: `${value}\u0007` }, { choice: 0, value }, {}]) {
			const r = await post(url, csrf, "sessions/B/answer", { dialog: "s1", digest, answerId: "s".repeat(20), ...body });
			replies.push(r);
			assert.deepEqual([r.status, r.body.error], "value" in body || "choice" in body ? [400, "terminal_only"] : [409, "changed"], JSON.stringify(Object.keys(body)));
		}
		seen.push(JSON.stringify(await snapshot(url)), JSON.stringify(replies));
	} finally {
		mock.restoreAll();
	}
	assert.deepEqual(got, [], "nothing reached the owner");
	assert.equal(heard.some((e) => (e.payload as { type?: string } | undefined)?.type === "answer"), false, "no answer was ever published on the channel");
	assert.equal(world.broker.published.some((p) => (p.payload as { type?: string }).type === "answer"), false);
	const everything = [...seen, ...written, ...a.notices.map((n) => n.text), ...b.notices.map((n) => n.text), ...c.notices.map((n) => n.text), ...filesUnder(scratch), JSON.stringify(heard), JSON.stringify(world.broker.published)];
	assert.equal(everything.some((t) => t.includes(value)), false, "the value is nowhere");
	assert.equal(everything.some((t) => t.includes("Deploy token")), false, "nor is what the secret asks for: its dialog is not relayed");
});

test("an answer to a secret dialog sent straight to its bridge, plain or sealed, never reaches the owner: B's bridge refuses it", async () => {
	const { b, url } = await setup(false, [["c1", "secret_drop"]]), digest = secretDigest(SECRET), value = "tok-forged";
	const seen: unknown[] = [];
	Object.assign(world.herdr.pane("wA:p2"), { agent_status: "blocked" });
	void b.fire("tool_execution_start", { toolCallId: "c1", toolName: "secret_drop", args: {} });
	b.on("robot-hand:secret:answer", (raw) => seen.push(raw));
	b.emit("robot-hand:secret:pending", { version: 1, id: "s1", toolCallId: "c1", digest, secret: SECRET });
	await until(async () => unitB(await snapshot(url))?.pending?.why, "B's secret_drop wait in the snapshot");
	// The server's session is the only sender B accepts; the same checks run on the owner path, so drive the bridge as the server does.
	const target = [...world.broker.published].reverse().find((p) => (p.payload as { type?: string }).type === "dialogs" && p.from === "B")!.payload as { bridgeId: string; dialogs: unknown[] };
	assert.deepEqual(target.dialogs, [], "the secret dialog is not relayed");
	const forged = { version: 1, type: "answer", to: target.bridgeId, id: "s1", answerId: "f".repeat(20), digest };
	const reg = b.regs.get(guiNamespace("A"))!, owner = world.broker.ownerOf(guiNamespace("A"));
	for (const payload of [{ ...forged, value }, { ...forged, sealed: seal(value, newKeys().pub, { id: "s1", digest, answerId: "f".repeat(20), bridgeId: target.bridgeId }) }])
		reg.onEvent({ type: "message", fromSessionId: "A", owner, payload });
	assert.deepEqual(seen, []);
	const acks = world.broker.published.filter((p) => p.from === "B" && (p.payload as { type?: string }).type === "ack").map((p) => p.payload as { outcome: string; reason?: string });
	assert.deepEqual(acks.map((x) => [x.outcome, x.reason]), Array(2).fill(["rejected", "terminal_only"]), "each reached the bridge and was refused there");
});

// Any extension's ctx.ui.confirm and select (src/intercept.ts): the wrap relays them through the same bridge, hub, and route as an owner's dialog.
type Fn = (...args: unknown[]) => Promise<unknown>;
const confirmIn = (b: Agent, title = "mp-infra command review", message = "ssh box ls -la\n\nReads a directory") => (b.ui.confirm as Fn)(title, message);
const selectIn = (b: Agent, title: string, options: string[]) => (b.ui.select as Fn)(title, options);
const answerOf = (n: Net) => unitB(n)?.pending?.answer;
const sentAnswer = (url: string, csrf: string, a: { dialog: string; digest: string }, choice: number, id: string) => post(url, csrf, "sessions/B/answer", { dialog: a.dialog, digest: a.digest, answerId: id.repeat(20), choice });

test("an mp-infra-like confirm inside a bash tool call is answered from this computer's page, Allow and Deny, and the terminal dialog goes", async () => {
	const { b, url, csrf } = await setup(false, [["c1", "bash"]], true);
	await b.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ssh box ls -la" } });
	for (const [choice, verdict] of [[0, true], [1, false]] as const) {
		const asked = confirmIn(b), dialog = b.dialogs.at(-1)!;
		let seen: Unit | undefined;
		await until(async () => (seen = unitB(await snapshot(url)))?.pending?.answer?.select?.confirm, "the confirm in the snapshot");
		const a = answerOf({ bases: [{ tabs: [{ units: [seen!] }], outside: [] }] } as never)!;
		assert.equal(seen!.mark, "waiting");
		assert.deepEqual(a.select, { title: "mp-infra command review\n\nssh box ls -la\n\nReads a directory", choices: [{ label: "Yes" }, { label: "No" }], confirm: true });
		assert.equal(a.digest, selectDigest(a.select!));
		assert.deepEqual(await sentAnswer(url, csrf, a, choice, String(choice)), { status: 200, body: { outcome: "accepted" } });
		assert.equal(await asked, verdict, choice ? "Deny" : "Allow");
		assert.equal(dialog.opts?.signal?.aborted, true, "pi's own dialog was dismissed");
		assert.deepEqual(await sentAnswer(url, csrf, a, choice, String(choice)), { status: 200, body: { outcome: "accepted" } }, "the same answer again replays");
		await until(async () => !answerOf(await snapshot(url)), "the closed dialog out of the snapshot");
	}
	assert.equal(b.dialogs.length, 2, "each confirm opened pi's dialog once");
});

test("a select from any extension is answered from the page and resolves with that option; the terminal answering first makes the page's answer stale", async () => {
	const { b, url, csrf } = await setup(false, [["c1", "bash"]], true);
	await b.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	const asked = selectIn(b, "Which target?", ["staging", "production", "cancel"]);
	await until(async () => answerOf(await snapshot(url)), "the select in the snapshot");
	let a = answerOf(await snapshot(url))!;
	assert.deepEqual(a.select, { title: "Which target?", choices: [{ label: "staging" }, { label: "production" }, { label: "cancel" }] });
	assert.deepEqual(await sentAnswer(url, csrf, a, 1, "a"), { status: 200, body: { outcome: "accepted" } });
	assert.equal(await asked, "production");
	await until(async () => !answerOf(await snapshot(url)), "closed");
	const second = selectIn(b, "Again?", ["x", "y"]);
	await until(async () => answerOf(await snapshot(url))?.select?.title === "Again?", "the second select");
	a = answerOf(await snapshot(url))!;
	b.dialogs.at(-1)!.settle("y");
	assert.equal(await second, "y", "the terminal's answer reaches the extension as it came");
	assert.deepEqual(await sentAnswer(url, csrf, a, 0, "b"), { status: 200, body: { outcome: "stale", by: "local" } }, "the page hears the terminal won");
});

test("input, editor and custom are untouched, and a session whose only open call is secret_drop relays no select or confirm", async () => {
	const { b, url } = await setup(false, [["c1", "secret_drop"]], true);
	const { input, editor, custom } = b.ui;
	await b.fire("tool_execution_start", { toolCallId: "c1", toolName: "secret_drop", args: {} });
	assert.deepEqual([b.ui.input === input, b.ui.editor === editor, b.ui.custom === custom], [true, true, true]);
	const asked = confirmIn(b);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(answerOf(await snapshot(url)), undefined);
	assert.equal(b.dialogs.length, 1, "the terminal dialog opened as always");
	b.dialogs[0]!.settle(true);
	assert.equal(await asked, true);
});

test("a robot_hand selector is relayed by its owner only: the select the extension opens for it is not relayed a second time", async () => {
	const { b, url, csrf } = await setup(false, [["c1", "robot_hand"]], true);
	const hand = selector(b);
	// robot_hand announces its dialog, then opens pi's own selector for the same call with the same words.
	const asked = selectIn(b, SELECT.title, SELECT.choices.map((c) => c.label));
	await until(async () => answerOf(await snapshot(url)), "B's dialog in the snapshot");
	const a = answerOf(await snapshot(url))!;
	assert.deepEqual(a, { dialog: "d1", digest: DIGEST, select: SELECT }, "the owner's dialog, with its notes and copy command: one dialog, not two");
	assert.deepEqual(await post(url, csrf, "sessions/B/answer", { dialog: "d1", digest: DIGEST, answerId: "c".repeat(20), choice: 2 }), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(hand.got, [[2]], "the owner took the answer");
	b.dialogs[0]!.settle(undefined);
	await asked;
	hand.off();
});

test("two tool calls in flight leave an intercepted dialog in the terminal", async () => {
	const { b, url } = await setup(false, [["c1", "bash"], ["c2", "edit"]], true);
	await b.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	await b.fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: {} });
	const asked = confirmIn(b);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(answerOf(await snapshot(url)), undefined);
	b.dialogs[0]!.settle(false);
	assert.equal(await asked, false);
});
