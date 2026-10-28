import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { eventText } from "../src/runmode.ts";
import { REQUEST_PREFIX } from "../src/owners.ts";
import { Turns } from "../src/link/turn.ts";
import { type Answer, call, type Request, results, rig as makeRig, scratchRoot } from "./run-rig.ts";
import { until } from "./server-world.ts";

// An ally run against a real pi agent session (a faux model, no network, a scripted server): the run is one remote turn at its sender's level for the whole session, its tools are the ally set, and the
// `forward` confirm and the `link_request` approval go through the server with the run's token (docs/specs/2026-10-26-sb-backend.md, Ally runs, Security: Remote turns after the split).

let root = "";
const sessions: AgentSession[] = [];
beforeEach(() => void (root = scratchRoot()));
afterEach(() => {
	for (const s of sessions.splice(0)) s.dispose();
	rmSync(root, { recursive: true, force: true });
});
const DEV = "a".repeat(26);
const TEAM = "1".repeat(32);
const PEER = { device: DEV, label: "Carol Mac", short: DEV.slice(0, 6), team: TEAM, teamName: "Team One" };
const BRIEF = "You are an ally run: BRIEF-MARK";
const HEADER = `[straw net from=Carol Mac id=link:${DEV} role=tower remote=Carol Mac device=${DEV.slice(0, 6)} team="Team One" verified=yes kind=tower_send scope=tower to=x reply=none]`;

function server(over: { kind?: "ally" | "local"; level?: string; peer?: false } = {}) {
	const requests: Request[] = [], queue: { id: string; kind: string; text: string }[] = [], taken: string[] = [];
	const commands: unknown[] = [];
	let tool: (r: Request) => Answer = () => ({ ok: true, text: "tool answer", details: {} });
	let link: (r: Request) => Answer = () => ({ ok: true, answer: { ok: true } });
	return {
		requests, queue, taken,
		push: (id: string, text: string) => void queue.push({ id, kind: "link", text: `${HEADER} ${text}` }),
		command: (c: unknown) => void commands.push(c),
		tools: (f: typeof tool) => void (tool = f),
		links: (f: typeof link) => void (link = f),
		async ask(request: Request): Promise<Answer> {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return { ok: true, token: "TOKEN", kind: over.kind ?? "ally", level: over.level ?? "reply", ...((over.kind ?? "ally") === "ally" && over.peer !== false ? { peer: PEER } : {}), run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: BRIEF };
				case "run-poll": {
					if (commands.length) return { ok: true, command: commands.shift() };
					if (request.idle !== true) return { ok: true };
					const next = queue.find((e) => !taken.includes(e.id));
					return next ? { ok: true, event: next } : { ok: true };
				}
				case "run-taken": return (taken.push(String(request.id)), { ok: true });
				case "run-tool": return tool(request);
				case "link": return link(request);
				default: return { ok: true };
			}
		},
	};
}
/** The computer's own config.json: the team binds the project the session runs in, and the policy gives the device `level` (the run can only be at or below it). */
const configure = (level: string) => {
	mkdirSync(join(root, "project"), { recursive: true });
	mkdirSync(join(root, "straw-boss"), { recursive: true });
	writeFileSync(join(root, "straw-boss", "config.json"), JSON.stringify({ link: { teams: { [TEAM]: { project: join(root, "project") } }, trust: { [DEV]: level } } }));
};
const rig = (srv: ReturnType<typeof server>, over: Parameters<typeof makeRig>[3] = {}) => makeRig(root, (r) => srv.ask(r), sessions, over);

test("an ally run registers the ally tools only, reads its events as the server wrote them, and takes the ally role prompt with its brief", async () => {
	const srv = server();
	srv.push("m1", "please look at the build");
	const seen: string[] = [];
	const r = await rig(srv);
	r.faux.setResponses([((context: { messages: unknown[]; systemPrompt?: string }) => (seen.push(JSON.stringify(context.messages) + (context.systemPrompt ?? "")), fauxAssistantMessage("ok"))) as never]);
	await until(() => seen.length === 1, "the turn");
	const names = r.session.getAllTools().map((t) => t.name);
	for (const n of ["boss_status", "tower_list", "board_read", "tower_send", "tower_reply", "tower_done", "boss_open_main", "boss_close_main"]) assert.ok(names.includes(n), `${n} is registered`);
	for (const n of ["call_tower", "boss_server", "link_request", "boss_broadcast", "board_set", "boss_rename", "boss_promote"]) assert.ok(!names.includes(n), `${n} is not`);
	assert.match(seen[0]!, /You are an ally run: a pi session the sb server started/, "the ally role prompt");
	assert.match(seen[0]!, /BRIEF-MARK/);
	assert.ok(seen[0]!.includes(`verified=yes kind=tower_send`), "the header the server wrote");
	assert.ok(seen[0]!.includes("please look at the build"));
	assert.doesNotMatch(seen[0]!, /\[intercom from/, "no sender line of the broker: the text is the server's");
	assert.equal(eventText({ kind: "link", text: "X" }), "X");
});

test("the run is one remote turn at its claimed level for the whole session: a call outside the allowlist is gated and refused with no answer, tower_send to the sender is free, to another device gated", async () => {
	configure("reply");
	const srv = server();
	srv.push("m1", "do something");
	const r = await rig(srv);
	r.faux.setResponses([call("bash", {}), call("tower_send", { device: PEER.label, message: "done" }), call("tower_send", { device: "someone-else", message: "x" }), fauxAssistantMessage("finished")]);
	await until(() => results(r.session).length === 3, "three results");
	const [bash, toSender, toOther] = results(r.session);
	assert.doesNotMatch(bash!, /RAN/);
	assert.match(bash!, /confirm|declin|timed out|refused/i, "the gate refused it without an answer");
	assert.match(toSender!, /tool answer/);
	assert.doesNotMatch(toOther!, /tool answer/);
	const tools = srv.requests.filter((q) => q.cmd === "run-tool");
	assert.deepEqual(tools.map((q) => (q.args as { device?: string }).device), [PEER.label], "only the allowed call reached the server");
	assert.match(String(tools[0]!.toolCallId), /\S/, "the tool call id goes with the request, for the server's check of the Allow");
});

test("at dispatch the gate is off: a call outside the allowlist runs", async () => {
	configure("dispatch");
	const srv = server({ level: "dispatch" });
	srv.push("m1", "do something");
	const r = await rig(srv);
	r.faux.setResponses([call("bash", {}), fauxAssistantMessage("finished")]);
	await until(() => results(r.session).length === 1, "the result");
	assert.match(results(r.session)[0]!, /RAN/);
});

test("the claim's level is a ceiling: a policy that gives the device less lowers the run, and the pinned sender stays after the run settles", () => {
	const turns = new Turns((id) => (id === DEV ? "reply" : "dispatch"));
	turns.pin({ id: DEV, short: DEV.slice(0, 6), label: "Carol Mac", team: "t", floor: "dispatch" });
	assert.equal(turns.level, "reply", "the policy's level is lower than the claim's");
	turns.settle();
	assert.equal(turns.active, true);
	assert.deepEqual(turns.list.map((s) => s.id), [DEV]);
	const high = new Turns(() => "dispatch");
	high.pin({ id: DEV, short: "aaaaaa", label: "x", team: "t", floor: "forward" });
	assert.equal(high.level, "forward", "the claim's level is lower than the policy's");
});

test("a forward confirm goes to the server with the run's token, and the server's answer, handed over at the poll, lets the call run", async () => {
	configure("forward");
	const srv = server({ level: "forward" });
	srv.push("m1", "do something");
	srv.links(() => ({ ok: true, answer: { ok: true } }));
	const r = await rig(srv, { gateMs: 5000 });
	r.faux.setResponses([call("bash", {}), fauxAssistantMessage("finished")]);
	await until(() => srv.requests.some((q) => q.cmd === "link" && (q.body as { op: string }).op === "confirm-request"), "the confirm request");
	const asked = srv.requests.find((q) => q.cmd === "link")!;
	assert.equal(asked.token, "TOKEN");
	const body = asked.body as { op: string; dialogId: string; tool: string };
	assert.equal(body.tool, "bash");
	srv.command({ type: "confirmed", dialogId: body.dialogId, allow: true });
	await until(() => results(r.session).length === 1, "the result");
	assert.match(results(r.session)[0]!, /RAN/);
});

test("an ally claim that names no peer ends the run before it can take a turn: it is never left unpinned (RV6-F008)", async () => {
	const srv = server({ peer: false });
	srv.push("m1", "hello");
	const r = await rig(srv);
	await until(() => r.shutdowns.length === 1, "the run to end itself");
	assert.ok(r.notes.some((n) => /ally/i.test(n) && /peer|sender/i.test(n)), r.notes.join("|"));
	assert.ok(srv.requests.some((q) => q.cmd === "run-release"), "the server is told to let the run go");
	assert.equal(srv.requests.filter((q) => q.cmd === "run-taken").length, 0, "no event was taken");
	assert.ok(!r.session.getAllTools().some((t) => t.name === "tower_send"), "and no ally tool was registered");
});

test("an ally run's context drops pi-intercom's messages", async () => {
	const srv = server();
	const r = await rig(srv);
	const seen: string[] = [];
	r.api().sendMessage({ customType: "intercom_message", content: "INTERCOM-LEAK", display: true });
	srv.push("m1", "hello");
	r.faux.setResponses([((context: { messages: unknown[] }) => (seen.push(JSON.stringify(context.messages)), fauxAssistantMessage("ok"))) as never]);
	await until(() => seen.length === 1, "the turn");
	assert.doesNotMatch(seen[0]!, /INTERCOM-LEAK/);
	assert.match(seen[0]!, /hello/);
});

// --- link_request in a local run ----------------------------------------------------------------------------------------------------------------------------------

type Pending = { id: string; toolCallId: string; digest: string; select: { title: string } };
test("link_request in a local run: the server opens it, the boss's approval dialog is this run's, and only a yes carries it out (the server is given the call id); a no withdraws it", async () => {
	const srv = server({ kind: "local" });
	srv.push("m1", "go");
	srv.tools((q) => {
		const a = q.args as { phase?: string };
		if (q.tool !== "link_request") return { ok: true, text: "x" };
		if (a.phase === "open") return { ok: true, text: "waiting", details: { id: "REQ1", lines: ["Action: invite", "Team: project-a"], reason: "Carol wants in" } };
		if (a.phase === "run") return { ok: true, text: "Invite text: strawlink1:abc", details: {} };
		return { ok: true, text: "withdrawn", details: {} };
	});
	const r = await rig(srv);
	const pending: Pending[] = [];
	r.api().events.on(`${REQUEST_PREFIX}:pending`, (d: unknown) => void pending.push(d as Pending));
	const answer = (p: Pending, choice: number) => r.api().events.emit(`${REQUEST_PREFIX}:answer`, { version: 1, id: p.id, answerId: `answer-${choice}-`.padEnd(16, "x"), digest: p.digest, selections: [choice] });
	r.faux.setResponses([call("link_request", { action: "invite", reason: "Carol wants in" }), call("link_request", { action: "invite", reason: "again" }), fauxAssistantMessage("finished")]);
	await until(() => pending.length === 1, "the approval dialog");
	assert.ok(pending[0]!.select.title.includes("Action: invite\nTeam: project-a\nAsked by session: tower run of Alpha"), pending[0]!.select.title);
	assert.ok(pending[0]!.select.title.includes("Reason: Carol wants in"));
	assert.equal(srv.requests.filter((q) => q.cmd === "run-tool" && (q.args as { phase?: string }).phase === "run").length, 0, "nothing ran while the boss had not answered");
	answer(pending[0]!, 0);
	await until(() => results(r.session).length === 1, "the first result");
	assert.match(results(r.session)[0]!, /Invite text/);
	const run = srv.requests.find((q) => q.cmd === "run-tool" && (q.args as { phase?: string }).phase === "run")!;
	assert.equal(run.toolCallId, pending[0]!.toolCallId, "the server checks the approval against this call");
	await until(() => pending.length === 2, "the second dialog");
	answer(pending[1]!, 1);
	await until(() => results(r.session).length === 2, "the second result");
	assert.match(results(r.session)[1]!, /declined/);
	assert.ok(srv.requests.some((q) => q.cmd === "run-tool" && (q.args as { phase?: string }).phase === "drop"), "a refused request is withdrawn");
});
