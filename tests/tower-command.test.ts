import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTowerArgs, runTowerCommand, type TowerCmdDeps } from "../src/towercmd.ts";

// `/boss tower status | retry | parked | deliver <id> | drop <id> | leave | new` (docs/specs/2026-10-26-sb-backend.md, The boss conversation): the pi twins of the tower card's buttons and the composer's Leave and New. Each
// is one control command, the one the GUI's route reaches too; the writes need a pi with a screen.

const ROW = {
	workspace: "wA", label: "Alpha",
	service: {
		state: "running", queued: 2, run: { kind: "local", startedAt: "2026-10-28T10:00:00Z" },
		conversation: { since: "2026-10-28T10:00:00Z", resumed: true, turns: 14, idle: true, idleAt: Date.parse("2026-10-28T10:20:00Z"), idleMs: 600_000, capAt: Date.parse("2026-10-28T14:00:00Z") },
		lastRun: { endedAt: "2026-10-28T09:00:00Z", outcome: "done" }, crashes: 1,
		notices: [{ id: "n1", level: "warning", text: "An event was parked after two runs crashed with it: intercom docs" }],
		parked: [{ id: "e-9", kind: "intercom", from: "docs-main", first: "deploy ws01?" }],
		localRuns: [{ kind: "conversation", startedAt: "2026-10-28T10:00:00Z", note: "(boss quit)" }, { kind: "event", startedAt: "2026-10-28T09:30:00Z", outcome: "done", note: "routed it" }],
	},
};
function harness(over: Partial<TowerCmdDeps> = {}) {
	const told: { text: string; level: string }[] = [], sent: Record<string, unknown>[] = [];
	let answer: Record<string, unknown> = { ok: true };
	const deps: TowerCmdDeps = {
		lang: "en", own: "wA", interactive: true,
		ask: async (request) => (sent.push(request), request.cmd === "status" ? { ok: true, towers: [ROW] } : { ok: true, ...answer }),
		tell: (text, level = "info") => void told.push({ text, level }),
		...over,
	};
	return { told, sent, deps, say: (a: Record<string, unknown>) => void (answer = a), run: (line: string) => runTowerCommand(parseTowerArgs(line)!, deps), last: () => told.at(-1)! };
}

test("the words that are commands: status, retry, parked, leave, new alone, and deliver or drop with an event id; anything else is a message for the tower", () => {
	for (const op of ["status", "retry", "parked", "leave", "new"]) assert.deepEqual(parseTowerArgs(` ${op.toUpperCase()} `), { op });
	assert.deepEqual(parseTowerArgs("deliver e-9"), { op: "deliver", id: "e-9" });
	assert.deepEqual(parseTowerArgs("drop  E_1.2"), { op: "drop", id: "E_1.2" });
	for (const prompt of ["new tests for the build", "leave it to docs", "status of the deploy", "deliver", "drop e-9 now", "deliver ../x", "", "retry later"]) assert.equal(parseTowerArgs(prompt), undefined, prompt);
});

test("status says the service, the conversation, the notices, the parked events and the last runs; parked lists only the parked ones", async () => {
	const h = harness();
	await h.run("status");
	const text = h.last().text;
	assert.match(text, /^Tower \(Alpha\): running · 2 queued · run: a local run since \d\d:\d\d · last run \d\d:\d\d: done · 1 recent crash$/m);
	assert.match(text, /Boss conversation: resumed session, 14 boss turns · since \d\d:\d\d · waiting for you; ends at \d\d:\d\d if you stay quiet · hard cap \d\d:\d\d/);
	assert.match(text, /\[warning\] An event was parked after two runs crashed with it/);
	assert.match(text, /Parked events \(1\): \/boss tower deliver <id> · drop <id>\n {2}e-9 {2}intercom · docs-main: deploy ws01\?/);
	assert.match(text, /conversation · live: \(boss quit\)|conversation · live/);
	assert.match(text, /event · done: routed it/);
	await h.run("parked");
	assert.match(h.last().text, /^Parked events \(1\)/);
	assert.doesNotMatch(h.last().text, /Tower \(/);
	assert.deepEqual(h.sent.map((r) => r.cmd), ["status", "status"], "reads ask for the status only");
});

test("retry, deliver, drop, leave and new are one control command each, for this session's workspace, and say what the server said", async () => {
	const h = harness();
	await h.run("retry");
	await h.run("deliver e-9");
	await h.run("drop e-9");
	h.say({ left: true });
	await h.run("leave");
	assert.match(h.last().text, /Left the boss conversation/);
	h.say({ left: true, already: true });
	await h.run("leave");
	assert.match(h.last().text, /closing already/);
	h.say({ fresh: true, left: false });
	await h.run("new");
	assert.match(h.last().text, /^Started over: the next conversation is a new session\./);
	h.say({ fresh: true, left: true });
	await h.run("new");
	assert.match(h.last().text, /the conversation ended, and the next one is a new session/);
	assert.deepEqual(h.sent, [
		{ cmd: "tower-retry", workspace: "wA" }, { cmd: "tower-deliver", id: "e-9", workspace: "wA" }, { cmd: "tower-drop", id: "e-9", workspace: "wA" },
		{ cmd: "tower-leave", workspace: "wA" }, { cmd: "tower-leave", workspace: "wA" }, { cmd: "tower-new", workspace: "wA" }, { cmd: "tower-new", workspace: "wA" },
	]);
});

test("the server's refusal is shown as it wrote it; a pi with no screen may read but not write; a session in no workspace has no tower", async () => {
	const refusing = harness({ ask: async (request) => (request.cmd === "status" ? { ok: true, towers: [ROW] } : { ok: false, error: "No boss conversation is live in this tower." }) });
	await refusing.run("leave");
	assert.deepEqual(refusing.last(), { text: "No boss conversation is live in this tower.", level: "error" });
	await refusing.run("drop nope");
	assert.equal(refusing.last().level, "error");
	const headless = harness({ interactive: false });
	for (const line of ["retry", "deliver e-9", "drop e-9", "leave", "new"]) {
		await headless.run(line);
		assert.match(headless.last().text, /only in a pi session with a screen/, line);
	}
	assert.deepEqual(headless.sent, [], "nothing was sent");
	await headless.run("status");
	assert.match(headless.last().text, /^Tower \(Alpha\)/);
	const nowhere = harness({ own: undefined });
	await nowhere.run("status");
	assert.match(nowhere.last().text, /not in a Herdr workspace/);
	const missing = harness({ ask: async () => ({ ok: true, towers: [] }) });
	await missing.run("status");
	assert.match(missing.last().text, /No tower service for wA/);
});

test("in Traditional Chinese the words follow, and what the server sent is cleaned of control characters", async () => {
	const h = harness({ lang: "zh-TW", ask: async () => ({ ok: true, towers: [{ ...ROW, label: "Al\u001b[31mpha", service: { ...ROW.service, parked: [{ id: "e-9", kind: "intercom", first: "a\u0007b" }] } }] }) });
	await h.run("status");
	assert.match(h.last().text, /^塔台（Al\[31mpha）：執行中・2 則待處理/);
	assert.match(h.last().text, /老闆對話：接續舊工作階段，已有 14 輪/);
	assert.doesNotMatch(h.last().text, /[\u0000-\u0008\u001b]/);
});
