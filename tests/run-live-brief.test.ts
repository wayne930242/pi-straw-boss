import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { BRIEF_MARK } from "../src/eventmarks.ts";
import { eventText } from "../src/runmode.ts";
import { type Answer, type Request, rig as makeRig, scratchRoot } from "./run-rig.ts";
import { until } from "./server-world.ts";

// The run's side of a brief in two texts (src/runmode.ts), on a real pi agent session with a faux model: `brief` is the run's system section, and `live` is a message at the start of the first turn that has not had
// it. The section is the same bytes from turn to turn while `live` moves, so the conversation before it stays a cached prefix (tests/head-live-brief.test.ts has the server's side).

let root = "";
const sessions: AgentSession[] = [];
beforeEach(() => void (root = scratchRoot()));
afterEach(() => {
	for (const s of sessions.splice(0)) s.dispose();
	rmSync(root, { recursive: true, force: true });
});

const FIXED = "You are the head tower: the boss's own tower, in no workspace. FIXED-MARK";
const live = (state: string) => `Your conversation with the boss: chapter 1.\n\nWorkspaces now:\n- Alpha (wA): tower standing by\n  work: main docs-main ${state}`;
/** The server a head run talks to: its claim answers the brief in two texts unless `whole`, a poll may answer a newer brief once, and its events are taken one at a time. */
function server(over: { whole?: string } = {}) {
	const requests: Request[] = [], queue: { id: string; kind: string; text: string; from?: { id: string } }[] = [], taken: string[] = [];
	let fresh: Answer | undefined;
	return {
		requests, taken,
		push: (id: string, text: string) => void queue.push({ id, kind: "intercom", text, from: { id: "sb-tower-wa" } }),
		/** The next poll answers a refreshed brief, as runs.ts `refreshed` does. */
		refresh: (answer: Record<string, unknown>) => void (fresh = { ok: true, ...answer }),
		refreshed: () => fresh === undefined,
		async ask(request: Request): Promise<Answer> {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return { ok: true, token: "TOKEN", kind: "head", run: "RUN", workspace: "wH", identity: "sb-head", label: "Head tower", ...(over.whole ? { brief: over.whole } : { brief: FIXED, live: live("idle") }) };
				case "run-poll": {
					if (fresh) return ([fresh, fresh = undefined] as const)[0]!;
					if (request.idle !== true) return { ok: true };
					const next = queue.find((e) => !taken.includes(e.id));
					return next ? { ok: true, event: next } : { ok: true };
				}
				case "run-taken": return (taken.push(String(request.id)), { ok: true });
				default: return { ok: true };
			}
		},
	};
}
interface Turn { system: string; messages: string }
/** A faux answer that keeps what the model was given: the system prompt with every system message, and the rest. */
const spy = (turns: Turn[]) => (context: { messages: { role?: string }[]; systemPrompt?: string }) => {
	turns.push({ system: (context.systemPrompt ?? "") + JSON.stringify(context.messages.filter((m) => m.role === "system")), messages: JSON.stringify(context.messages.filter((m) => m.role !== "system")) });
	return fauxAssistantMessage("ok");
};
const count = (text: string, part: string) => text.split(part).length - 1;

test("a head run says at its claim that it takes a brief in two texts; the fixed text is its section and the live text is one message, after the event that started the turn", async () => {
	const srv = server(), turns: Turn[] = [];
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	r.faux.setResponses([spy(turns) as never]);
	await until(() => turns.length === 1, "the first turn");
	assert.equal(srv.requests.find((q) => q.cmd === "claim")!.liveBrief, true);
	assert.match(turns[0]!.system, /FIXED-MARK/);
	assert.match(turns[0]!.system, /You are the head tower: the boss's own tower\. You belong to no workspace/, "the role prompt comes before it");
	assert.doesNotMatch(turns[0]!.system, /Workspaces now:|docs-main/, "the section holds nothing of the live text");
	assert.equal(count(turns[0]!.messages, BRIEF_MARK), 1);
	assert.ok(turns[0]!.messages.includes(JSON.stringify(`${BRIEF_MARK}\n${live("idle")}`).slice(1, -1)), "the message is the marker line and the live text");
	assert.ok(turns[0]!.messages.indexOf("EVENT-ONE") < turns[0]!.messages.indexOf(BRIEF_MARK));
	const kept = r.session.messages.find((m) => (m as { customType?: string; details?: { brief?: boolean } }).details?.brief === true) as { customType?: string; display?: boolean } | undefined;
	assert.deepEqual([kept?.customType, kept?.display], ["straw-tower", false], "kept in the session, and not shown: the boss never saw the brief in the section either");
});

test("another main's state flip reaches a live head run as a newer live text: the section is the same bytes in the next turn, and the newer text is a second message behind the first", async () => {
	const srv = server(), turns: Turn[] = [];
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	r.faux.setResponses([spy(turns) as never, spy(turns) as never, spy(turns) as never]);
	await until(() => turns.length === 1, "the first turn");
	// Nothing moved: a second turn is given no second brief.
	srv.push("e2", "EVENT-TWO");
	await until(() => turns.length === 2, "the second turn");
	assert.equal(count(turns[1]!.messages, BRIEF_MARK), 1, "the same live text is given once");
	// The server refreshes the brief (the memory moved), and by then the main works.
	srv.refresh({ brief: FIXED, live: live("working") });
	await until(() => srv.refreshed(), "the poll that takes the newer brief");
	srv.push("e3", "EVENT-THREE");
	await until(() => turns.length === 3, "the third turn");
	assert.equal(turns[1]!.system, turns[0]!.system);
	assert.equal(turns[2]!.system, turns[0]!.system, "the section is the same bytes after the refresh");
	assert.equal(count(turns[2]!.messages, BRIEF_MARK), 2);
	assert.ok(turns[2]!.messages.startsWith(turns[1]!.messages.slice(0, -1)), "what the model was given before is a prefix of what it is given now: nothing earlier was rewritten");
	assert.ok(turns[2]!.messages.indexOf("docs-main idle") < turns[2]!.messages.indexOf("docs-main working"));
});

test("a tree move followed immediately by reload resends the brief without changing the section", async () => {
	const srv = server(), turns: Turn[] = [];
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	r.faux.setResponses([spy(turns) as never, spy(turns) as never]);
	await until(() => turns.length === 1 && srv.taken.length === 1 && !r.session.isStreaming, "the first turn to settle");
	assert.equal(count(turns[0]!.messages, BRIEF_MARK), 1);
	const manager = r.session.sessionManager;
	const beforeBrief = manager.getBranch().find((entry) => entry.type === "custom_message" && entry.content === eventText({ kind: "intercom", text: "EVENT-ONE", from: { id: "sb-tower-wa" } }));
	assert.ok(beforeBrief, "the waking event precedes the brief");
	await r.session.navigateTree(beforeBrief.id);
	assert.ok(!r.session.messages.some((m) => (m as { details?: { brief?: boolean } }).details?.brief), "the new branch has no brief");
	await r.session.reload();
	srv.push("e2", "EVENT-TWO");
	await until(() => turns.length === 2, "the first turn after reload");
	assert.equal(turns[1]!.system, turns[0]!.system);
	assert.equal(count(turns[1]!.messages, BRIEF_MARK), 1, "the new branch receives the brief after reload");
});

test("a whole brief and its refresh are delivered without rewriting the run's section", async () => {
	const whole = `${FIXED} WHOLE-MARK\n\nWorkspaces now:\n- Alpha (wA): tower standing by`;
	const srv = server({ whole }), turns: Turn[] = [];
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	r.faux.setResponses([spy(turns) as never, spy(turns) as never]);
	await until(() => turns.length === 1, "the first turn");
	srv.refresh({ brief: whole.replace("WHOLE-MARK", "UPDATED-MARK") });
	await until(() => srv.refreshed(), "the poll that takes the newer brief");
	srv.push("e2", "EVENT-TWO");
	await until(() => turns.length === 2, "the second turn");
	assert.equal(turns[1]!.system === turns[0]!.system, true, "the refreshed whole brief must not rewrite the role section");
	assert.doesNotMatch(turns[0]!.system, /WHOLE-MARK|Workspaces now:/);
	assert.match(turns[0]!.messages, /WHOLE-MARK/);
	assert.match(turns[1]!.messages, /UPDATED-MARK/);
});

test("a compaction folds the brief into its summary, so the session is given it again behind the summary, and the next turn is given no third", async () => {
	const srv = server(), turns: Turn[] = [];
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	r.faux.setResponses([spy(turns) as never, spy(turns) as never]);
	await until(() => turns.length === 1, "the first turn");
	await until(() => srv.taken.length === 1 && !r.session.isStreaming, "the turn to settle");
	const briefs = () => r.session.messages.filter((m) => (m as { details?: { brief?: boolean } }).details?.brief === true).length;
	assert.equal(briefs(), 1);
	const runner = (r.session as unknown as { _extensionRunner: { emit(event: unknown): Promise<unknown> } })._extensionRunner;
	await runner.emit({ type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false });
	await until(() => briefs() === 2, "the brief to be given again");
	// The next turn starts with the brief it already has: no third one.
	srv.push("e2", "EVENT-TWO");
	await until(() => turns.length === 2, "the second turn");
	assert.equal(count(turns[1]!.messages, BRIEF_MARK), 2, "the one of the claim and the one after the compaction");
	assert.equal(briefs(), 2);
});

test("a threshold compaction at the end of a turn stores the brief behind the summary and starts no model turn of its own", async () => {
	const srv = server();
	srv.push("e1", "EVENT-ONE");
	const r = await makeRig(root, (q) => srv.ask(q), sessions);
	// The faux provider estimates usage from the text (4 characters a token): this reply fills the 100k window past the compaction threshold. The compaction of a split turn asks the model twice for a summary.
	r.faux.setResponses([() => fauxAssistantMessage("x".repeat(400_000)), () => fauxAssistantMessage("SUMMARY"), () => fauxAssistantMessage("SUMMARY-PREFIX"), () => fauxAssistantMessage("UNSOLICITED")]);
	const briefs = () => r.session.messages.filter((m) => (m as { details?: { brief?: boolean } }).details?.brief === true).length;
	await until(() => r.faux.state.callCount >= 3 && briefs() === 1 && !r.session.isStreaming, "the turn, its summaries, and the brief behind them");
	assert.equal(r.faux.state.callCount, 3, "the turn and its two summaries: no unsolicited fourth call");
	const order = r.session.messages.map((m) => ((m as { details?: { brief?: boolean } }).details?.brief ? "brief" : (m as { role: string }).role));
	assert.equal(order.at(-1), "brief", "stored after the summary");
	assert.ok(order.indexOf("compactionSummary") < order.indexOf("brief"));
});

test("no event reads as a brief: each code-headed eventText kind (boss, notice, timer, intercom) opens with its own marker, never BRIEF_MARK", () => {
	for (const kind of ["boss", "notice", "timer", "intercom"] as const) for (const flag of [undefined, "crash" as const]) {
		const text = eventText({ kind, text: "x", ...(flag ? { flag } : {}), from: { id: "main-1", name: "docs-main" } });
		assert.ok(!text.startsWith(BRIEF_MARK), `${kind}${flag ? "+crash" : ""} opens with the brief marker`);
	}
});
