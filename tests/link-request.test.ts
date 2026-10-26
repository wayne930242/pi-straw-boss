import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { linkRequest, OWNERS, selectDigest } from "../src/owners.ts";
import { encodeInvite } from "../src/link/join.ts";
import { ACTIONS, shapeProblem } from "../src/link/request.ts";
import { LinkStore } from "../src/link/store.ts";
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

type Pending = { version: number; id: string; toolCallId: string; digest: string; select: { title: string; choices: { label: string }[] } };

async function rig(o: { requestMs?: number; policy?: Parameters<typeof computer>[3] extends infer T ? (T extends { policy?: infer P } ? P : never) : never } = {}) {
	const c = computer(root, relay, "a", { ui: true, gateMs: o.requestMs ?? 5000, ...(o.policy ? { policy: o.policy } : {}) });
	computers.push(c);
	await c.tower.start();
	await until(() => new LinkStore(c.dir).readHolder()?.session === "tower-a", "the holder");
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
	assert.equal(c.tower.dialogs.length, 1, "the terminal shows the same confirm");
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
	await until(() => pending.length === 2 && c.tower.dialogs.length === 2, "the second dialog");
	c.tower.dialogs[1]!.settle(false);
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
	const run = ask({ action: "join", args: { text, project: c.project }, reason: "Bob sent me this" });
	await until(() => pending.length === 1, "the dialog");
	assert.ok(pending[0]!.select.title.includes(`Invite: ${text}`), "the whole invite, as the agent gave it");
	assert.ok(pending[0]!.select.title.includes(`Invited by device: ${bob.shortId}`));
	assert.ok(pending[0]!.select.title.includes("safety words are still compared by you"));
	answer(pending[0]!, 0);
	assert.match(await run.then((r) => r.content.map((x) => (x as { text: string }).text).join("")), /Join screen is open/);
	assert.equal(relay.joined.length, 0, "no join request went to the relay");
	const state = (await c.link.gui("state")) as { ok: boolean; view: { prefill?: { kind: string; text: string; project: string; session: string } } };
	assert.deepEqual([state.view.prefill?.kind, state.view.prefill?.text, state.view.prefill?.project, state.view.prefill?.session], ["join", text, c.project, "tower-a"]);
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
