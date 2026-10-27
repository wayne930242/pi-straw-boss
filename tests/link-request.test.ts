import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { linkRequest, OWNERS, selectDigest } from "../src/owners.ts";
import { createApproval, TERMINAL_DELAY_MS } from "../src/link/approval.ts";
import { encodeInvite } from "../src/link/join.ts";
import { ACTIONS, HERE_ONLY, shapeProblem } from "../src/link/request.ts";
import { until } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { bob, type Computer, computer } from "./link/remote-world.ts";

// `link_request` (docs/specs/2026-10-25-straw-link.md, GUI, Link actions an agent asks for): the tool never runs an action unasked; each request is
// approved on its own through the dialog contract, shows the action, every argument, the reason, and the session that asked; ten minutes of silence
// denies; an approved invite returns its text; a join only opens the join screen; an unattended device refuses it; the holder carries it out.

let root = "";
let relay: FakeRelay;
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-request-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
	rmSync(root, { recursive: true, force: true });
});

type Pending = { version: number; id: string; toolCallId: string; digest: string; select: { title: string; choices: { label: string; hereOnly?: true; note?: string }[] } };

async function rig(o: { requestMs?: number; policy?: Parameters<typeof computer>[3] extends infer T ? (T extends { policy?: infer P } ? P : never) : never } = {}) {
	const c = computer(root, relay, "a", { ui: true, gateMs: o.requestMs ?? 5000, terminalMs: 20, ...(o.policy ? { policy: o.policy } : {}) });
	computers.push(c);
	await c.tower.start();
	await until(() => c.server.service.status().active, "the holder");
	const pending: Pending[] = [], closed: { id: string; by: string }[] = [];
	c.tower.on("straw-link:request:pending", (d) => void pending.push(d as Pending));
	c.tower.on("straw-link:request:closed", (d) => void closed.push(d as (typeof closed)[number]));
	const ask = (params: Record<string, unknown>, id = "tc-1") => c.tower.tool("link_request", params, { id });
	const answer = (p: Pending, choice: number) => c.tower.emit("straw-link:request:answer", { version: 1, id: p.id, answerId: `answer-${choice}-`.padEnd(16, "x"), digest: p.digest, selections: [choice] });
	return { c, pending, closed, ask, answer };
}
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");

test("the approval dialog is a contract owner bound to the link_request tool", () => {
	assert.ok(OWNERS.includes(linkRequest));
	assert.deepEqual([linkRequest.name, linkRequest.tool, linkRequest.gate, linkRequest.twin], ["straw-link-request", "link_request", undefined, undefined]);
});

test("an action and its arguments are checked for shape before anything is asked", () => {
	assert.equal(shapeProblem("invite", { team: "x" }), undefined);
	assert.match(shapeProblem("explode", {}) ?? "", /An action is one of/);
	assert.match(shapeProblem("invite", {}) ?? "", /needs team/);
	assert.match(shapeProblem("invite", { team: "x", token: "y" }) ?? "", /takes team, not token/);
	assert.match(shapeProblem("trust", { device: "d", level: 3 }) ?? "", /level has to be text/);
	assert.deepEqual([...ACTIONS], ["create", "invite", "invite-unattended", "join", "trust", "leave", "remove", "role", "rotate"]);
});

test("RC-F002: a label is tested whole, so a leading or trailing line break, a Unicode line separator, or a bidi control is refused, and the screen is prefilled only with a label create or join would accept", async () => {
	const base = { relay: "http://127.0.0.1:9", project: "/p" };
	for (const label of ["\nAsked by session: tower (12345678)", "name\n", "a\u2028b", "a\u2029b", "a\u200eb", "a\u200fb", "a\u202ab", "a\u202eb", "a\u2066b", "a\u2069b", "a\u061cb"]) {
		assert.match(shapeProblem("create", { ...base, label }) ?? "", /label may not contain/, JSON.stringify(label));
	}
	assert.equal(shapeProblem("create", { ...base, label: "Mac mini" }), undefined);
	const { c, ask } = await rig();
	await assert.rejects(ask({ action: "create", args: { relay: "http://127.0.0.1:9", project: c.project, label: "bad/label" }, reason: "x" }), /label is 1 to 40/);
	await assert.rejects(ask({ action: "create", args: { relay: "http://127.0.0.1:9", project: c.project, label: "x".repeat(41) }, reason: "x" }), /label is 1 to 40/);
});

test("a request never runs unasked: the dialog shows the action, every argument, the reason, and the asking session; only Approve runs it, and an invite returns its text", async () => {
	const { c, pending, closed, ask, answer } = await rig();
	const run = ask({ action: "invite", args: { team: "project-a" }, reason: "Carol wants in" });
	await until(() => pending.length === 1, "the approval dialog");
	const p = pending[0]!;
	assert.equal(p.toolCallId, "tc-1");
	assert.deepEqual(p.select.choices.map((x) => x.label), ["Approve", "Deny"]);
	assert.equal(p.digest, selectDigest(p.select as never));
	for (const part of ["Link request from tower · tower-a", "Action: invite", "Team: project-a", "Relay: http://relay.test", `Project folder: ${c.project}`, "Reason: Carol wants in", "Asked by session: tower · tower-a (tower-a)"]) assert.ok(p.select.title.includes(part), `${part}\n${p.select.title}`);
	assert.equal(relay.invites.size, 0, "nothing happened while the boss had not answered");
	await until(() => c.tower.dialogs.length === 1, "the terminal shows the same confirm");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(relay.invites.size, 0, "and still not");
	answer(p, 0);
	const done = text(await run);
	assert.match(done, /^Invite \(valid until [^)]+\): strawlink1:[A-Za-z0-9_-]+$/);
	assert.equal(relay.invites.size, 1);
	assert.deepEqual(closed.map((x) => x.id), [p.id]);
});

test("Deny and the terminal's No refuse the request, and nothing is done", async () => {
	const { c, pending, ask, answer } = await rig();
	const first = ask({ action: "invite", args: { team: "project-a" }, reason: "x" }, "tc-1");
	await until(() => pending.length === 1, "the dialog");
	answer(pending[0]!, 1);
	await assert.rejects(first, /the boss declined the link request/);
	const second = ask({ action: "invite", args: { team: "project-a" }, reason: "x" }, "tc-2");
	await until(() => pending.length === 2 && c.tower.dialogs.length === 1, "the second dialog (the first was answered before its terminal confirm came up)");
	c.tower.dialogs[0]!.settle(false);
	await assert.rejects(second, /declined/);
	assert.equal(relay.invites.size, 0);
});

test("approval is per request: an earlier approval opens nothing for a second request", async () => {
	const { pending, ask, answer } = await rig();
	const one = ask({ action: "invite", args: { team: "project-a" }, reason: "one" }, "tc-1");
	await until(() => pending.length === 1, "the first dialog");
	answer(pending[0]!, 0);
	await one;
	const two = ask({ action: "invite", args: { team: "project-a" }, reason: "two" }, "tc-2");
	await until(() => pending.length === 2, "a second dialog for a second request");
	assert.equal(relay.invites.size, 1, "the second waits for its own approval");
	answer(pending[1]!, 0);
	await two;
	assert.equal(relay.invites.size, 2);
});

test("ten minutes of silence denies (the wait is shortened here), and the request is gone", async () => {
	const { pending, closed, ask } = await rig({ requestMs: 80 });
	await assert.rejects(ask({ action: "invite", args: { team: "project-a" }, reason: "x" }), /no answer within/);
	assert.equal(relay.invites.size, 0);
	assert.deepEqual(closed.map((x) => x.by), ["timeout"]);
	assert.equal(pending.length, 1);
});

test("a request the holder refuses never reaches the boss: an unknown team, a non-admin action, a bad argument", async () => {
	const { pending, ask } = await rig();
	await assert.rejects(ask({ action: "invite", args: { team: "nowhere" }, reason: "x" }), /No team "nowhere"/);
	await assert.rejects(ask({ action: "invite", args: {}, reason: "x" }), /needs team/);
	await assert.rejects(ask({ action: "trust", args: { device: "carol-pc", level: "dispatch" }, reason: "x" }), /No device "carol-pc"/);
	await assert.rejects(ask({ action: "trust", args: { device: "bob-mac", level: "root" }, reason: "x" }), /reply, forward, or dispatch/);
	assert.equal(pending.length, 0);
});

test("trust names the device by its label and short id in the dialog, and an approval writes config.json's link.trust", async () => {
	const { c, pending, ask, answer } = await rig();
	const run = ask({ action: "trust", args: { device: "bob-mac", level: "forward" }, reason: "Bob is my other laptop" });
	await until(() => pending.length === 1, "the dialog");
	assert.ok(pending[0]!.select.title.includes(`Device: bob-mac (${bob.shortId}) of team project-a`));
	assert.ok(pending[0]!.select.title.includes("Trust level: forward"));
	answer(pending[0]!, 0);
	assert.match(text(await run), /Trust for that device is now forward/);
	const { readFileSync } = await import("node:fs");
	const config = JSON.parse(readFileSync(join(c.world.stateDir, "config.json"), "utf8")) as { link: { trust: Record<string, string> } };
	assert.equal(config.link.trust[bob.id], "forward");
});

test("a join approval only opens the join screen with the invite filled in: nothing is posted to the relay, and the screen is the GUI's to read", async () => {
	const { c, pending, ask, answer } = await rig();
	writeFileSync(join(c.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "tower-a" }));
	await assert.rejects(ask({ action: "join", args: { text: "strawlink1:AAAA" }, reason: "x" }), /not a Straw Link invite/);
	const text = encodeInvite({ relay: "http://127.0.0.1:9", team: Buffer.alloc(16, 7), secret: Buffer.alloc(32, 8), inviterId: bob.id, inviterKeyHash: Buffer.alloc(32, 9), forDevice: "" });
	const run = ask({ action: "join", args: { text, project: c.project, label: "bob-laptop", share: "presence" }, reason: "Bob sent me this" });
	await until(() => pending.length === 1, "the dialog");
	assert.ok(!pending[0]!.select.title.includes(text) && !pending[0]!.select.title.includes("Invite:"), "the invite text is a credential: the dialog, which paired devices read, does not carry it");
	assert.ok(pending[0]!.select.title.includes(`Invited by device: ${bob.shortId}`));
	assert.ok(pending[0]!.select.title.includes("safety words are still compared by you"));
	answer(pending[0]!, 0);
	assert.match(await run.then((r) => r.content.map((x) => (x as { text: string }).text).join("")), /Join screen is open/);
	assert.equal(relay.joined.length, 0, "no join request went to the relay");
	const state = (await c.link.gui("state")) as { ok: boolean; view: { prefill?: { kind: string; text: string; project: string; session: string } } };
	assert.deepEqual([state.view.prefill?.kind, state.view.prefill?.text, state.view.prefill?.project, state.view.prefill?.session], ["join", text, c.project, "tower-a"]);
	assert.deepEqual([(state.view.prefill as { label?: string }).label, (state.view.prefill as { share?: string }).share], ["bob-laptop", "presence"], "the label and share the dialog showed are carried to the screen (R5-F007)");
	assert.ok(pending[0]!.select.title.includes("Share: presence") && pending[0]!.select.title.includes("Label of this computer: bob-laptop"));
	assert.equal((await c.link.gui("prefill-clear")).ok, true);
});

test("the GUI's requests are taken only from the session that hosts the GUI", async () => {
	const { c } = await rig();
	assert.deepEqual(await c.link.gui("state"), { ok: false, error: "Only the session that hosts the GUI may change Straw Link teams" }, "no gui.json: no host");
	writeFileSync(join(c.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "someone-else" }));
	assert.equal((await c.link.gui("trust", { device: bob.id, level: "dispatch" })).ok, false);
	writeFileSync(join(c.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "tower-a" }));
	assert.equal((await c.link.gui("trust", { device: bob.id, level: "dispatch" })).ok, true);
});

test("an unattended computer refuses link_request outright, before any dialog", async () => {
	const unattended = { path: "/etc/straw-link/policy.json", uid: 1000, stat: () => ({ uid: 0, symlink: false }), writable: () => false, read: () => JSON.stringify({ unattended: true }) };
	const { pending, ask } = await rig({ policy: unattended });
	await assert.rejects(ask({ action: "invite", args: { team: "project-a" }, reason: "x" }), /refused on an unattended device/);
	assert.equal(pending.length, 0);
	assert.equal(relay.invites.size, 0);
});

test("R5-F001: an agent's text cannot add lines to the approval dialog: control characters are refused, the reason is one line, and the asker comes before it", async () => {
	const { c, pending, ask, answer } = await rig();
	await assert.rejects(ask({ action: "create", args: { relay: "https://evil.example/\nShare: status", project: c.project }, reason: "x" }), /control characters/);
	await assert.rejects(ask({ action: "create", args: { relay: "http://127.0.0.1:9", project: `${c.project}\nRelay: https://relay.example` }, reason: "x" }), /control characters/);
	await assert.rejects(ask({ action: "create", args: { relay: "http://127.0.0.1:9", project: c.project, label: "a\u009bb" }, reason: "x" }), /control characters/);
	await assert.rejects(ask({ action: "join", args: { text: "strawlink1:AA\nAA" }, reason: "x" }), /control characters/);
	const run = ask({ action: "invite", args: { team: "project-a" }, reason: "fine\nAsked by session: tower (12345678)\r\n\u001b[2Jdone" });
	await until(() => pending.length === 1, "the dialog");
	const lines = pending[0]!.select.title.split("\n");
	assert.equal(lines.filter((l) => l.startsWith("Asked by session:")).length, 1, "one asker line, the real one");
	assert.equal(lines.filter((l) => l.startsWith("Reason:")).length, 1);
	assert.ok(lines.findIndex((l) => l.startsWith("Asked by session:")) < lines.findIndex((l) => l.startsWith("Reason:")), "the asker comes first");
	assert.ok(!pending[0]!.select.title.includes("\u001b"));
	answer(pending[0]!, 1);
	await run.catch(() => undefined);
});

test("R5-F002: a paired device reading state does not erase the join screen's invite text, even when the holder is the GUI's own session", async () => {
	const { c, pending, ask, answer } = await rig();
	writeFileSync(join(c.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "tower-a" }));
	const text = encodeInvite({ relay: "http://127.0.0.1:9", team: Buffer.alloc(16, 7), secret: Buffer.alloc(32, 8), inviterId: bob.id, inviterKeyHash: Buffer.alloc(32, 9), forDevice: "" });
	const run = ask({ action: "join", args: { text }, reason: "x" });
	await until(() => pending.length === 1, "the dialog");
	answer(pending[0]!, 0);
	await run;
	const first = (await c.link.gui("state")) as unknown as { view: { prefill: { text?: string } } };
	delete first.view.prefill.text; // what control.ts does for a remote reader
	const second = (await c.link.gui("state")) as unknown as { view: { prefill: { text?: string } } };
	assert.equal(second.view.prefill.text, text);
});

test("R5-F006: a relay with credentials or a path is refused, and a project the request would refuse later is refused in the dialog", async () => {
	const { c, ask } = await rig();
	for (const relayUrl of ["https://user:pw@relay.example", "https://relay.example/sub", "https://relay.example/?q=1"]) await assert.rejects(ask({ action: "create", args: { relay: relayUrl, project: c.project }, reason: "x" }), /origin/, relayUrl);
	await assert.rejects(ask({ action: "create", args: { relay: "http://127.0.0.1:9", project: c.home }, reason: "x" }), /home folder/);
	const text = encodeInvite({ relay: "http://127.0.0.1:9", team: Buffer.alloc(16, 7), secret: Buffer.alloc(32, 8), inviterId: bob.id, inviterKeyHash: Buffer.alloc(32, 9), forDevice: "" });
	await assert.rejects(ask({ action: "join", args: { text, project: c.home }, reason: "x" }), /home folder/);
	const odd = encodeInvite({ relay: "https://relay.example/sub", team: Buffer.alloc(16, 7), secret: Buffer.alloc(32, 8), inviterId: bob.id, inviterKeyHash: Buffer.alloc(32, 9), forDevice: "" });
	await assert.rejects(ask({ action: "join", args: { text: odd }, reason: "x" }), /not a Straw Link invite/, "an invite's relay is an origin");
});

test("only trust, remove, role, rotate, and leave mark Approve here-only; Deny never is, and every other action stays approvable from a paired device", async () => {
	assert.deepEqual([...HERE_ONLY], ["trust", "remove", "role", "rotate", "leave"]);
	const { pending, ask, answer } = await rig();
	const runs: Promise<unknown>[] = [];
	const marks: Record<string, unknown> = {};
	for (const [action, args] of [["invite", { team: "project-a" }], ["trust", { device: "bob-mac", level: "forward" }], ["rotate", { team: "project-a" }], ["leave", { team: "project-a" }]] as const) {
		const before = pending.length;
		runs.push(ask({ action, args, reason: "x" }, `tc-${action}`).catch(() => undefined));
		await until(() => pending.length === before + 1, `the ${action} dialog`);
		const [approve, deny] = pending[before]!.select.choices;
		marks[action] = [approve!.label, approve!.hereOnly ?? false, deny!.label, deny!.hereOnly ?? false];
		if (approve!.hereOnly) assert.match(approve!.note ?? "", /this computer only/);
		answer(pending[before]!, 1);
	}
	await Promise.all(runs);
	assert.deepEqual(marks, { invite: ["Approve", false, "Deny", false], trust: ["Approve", true, "Deny", false], rotate: ["Approve", true, "Deny", false], leave: ["Approve", true, "Deny", false] });
});

test("RR-F002: a reason's bidi marks and overrides become spaces, so they cannot reorder the lines of the dialog", async () => {
	const { pending, ask } = await rig();
	const run = ask({ action: "invite", args: { team: "project-a" }, reason: "ok\u061c\u202eevil\u200f\u2066x\u2069y\u200ez\u202a" });
	run.catch(() => undefined);
	await until(() => pending.length === 1, "the dialog");
	assert.match(pending[0]!.select.title, /Reason: ok evil x y z$/);
	assert.doesNotMatch(pending[0]!.select.title, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
});

test("RR-F001: the terminal confirm is shown only after a delay (1.5 s by default); the page sees the dialog at once, and an answer before the delay means the terminal never shows it", async () => {
	assert.equal(TERMINAL_DELAY_MS, 1500);
	const handlers = new Map<string, (d: unknown) => void>(), published: { id: string; digest: string }[] = [];
	const bus = { emit: (channel: string, data: unknown) => (channel.endsWith(":pending") && published.push(data as (typeof published)[number]), undefined), on: (channel: string, h: (d: unknown) => void) => (handlers.set(channel, h), () => handlers.delete(channel)) };
	let shown = 0;
	const ui = { confirm: (_t: string, _m: string, o?: { signal?: AbortSignal }) => (shown++, new Promise<boolean>((resolve) => o?.signal?.addEventListener("abort", () => resolve(false)))) };
	const started = Date.now();
	const first = createApproval({ bus }).approve({ toolCallId: "c1", lines: ["Action: trust"], asker: "s", hereOnly: true, ui, signal: AbortSignal.timeout(5000) });
	assert.equal(published.length, 1, "the page's dialog is published at once");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(shown, 0, "no terminal confirm yet");
	await until(() => shown === 1, "the terminal confirm", 3000);
	assert.ok(Date.now() - started >= 1400, `shown after ${Date.now() - started} ms`);
	handlers.get("straw-link:request:answer")!({ version: 1, id: published[0]!.id, answerId: "answer-1-".padEnd(16, "x"), digest: published[0]!.digest, selections: [1] });
	assert.equal((await first).approved, false);
	const second = createApproval({ bus }).approve({ toolCallId: "c2", lines: ["Action: trust"], asker: "s", hereOnly: true, ui, signal: AbortSignal.timeout(5000) });
	handlers.get("straw-link:request:answer")!({ version: 1, id: published[1]!.id, answerId: "answer-1-".padEnd(16, "y"), digest: published[1]!.digest, selections: [1] });
	assert.equal((await second).approved, false);
	await new Promise((r) => setTimeout(r, TERMINAL_DELAY_MS + 200));
	assert.equal(shown, 1, "answered before the delay: the terminal never showed it");
});
