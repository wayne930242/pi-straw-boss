import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { NAMESPACE } from "../src/link/wire.ts";
import { until } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, type Computer, computer, TEAM_HEX } from "./link/remote-world.ts";

// A reply for a main (docs/specs/2026-10-26-sb-backend.md, Replies for a main (D4)), the whole way between two computers: the asking computer's tower answers an ask by `inReplyTo`, the other computer's holder takes
// the `tower-reply` against an open ask and offers it to the main that asked, and the main puts it into its session as a peer's data under the verified header and `kind=link_reply`.

let root = "";
let relay: FakeRelay;
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-reply-main-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
	rmSync(root, { recursive: true, force: true });
});
const ASK = "9".repeat(32);
const listening = (c: Computer, id: string) => c.world.broker.registrations.some((r) => r.id === id && r.namespace === NAMESPACE);

test("the reply to an ask goes to the main that asked, as a straw-link message with kind=link_reply and for=<tower>, once; the tower and other mains get nothing", async () => {
	const open = new Map<string, { main: string; mainName: string; tower: string; workspace: string }>();
	// B asks (its tower made the ask for its main, which the server keeps); A answers.
	const b = computer(root, relay, "b", { gateMs: 60, tower: { asks: { take: (q) => (q.ask === ASK && q.device === alice.id ? (() => { const hit = open.get(ASK); open.delete(ASK); return hit; })() : undefined) } } });
	const a = computer(root, relay, "a", { gateMs: 60 });
	computers.push(a, b);
	const main = b.world.agent({ id: "main-b", name: "api main", pane: "wB:p1", tab: "wB:t1", deps: b.deps }), other = b.world.agent({ id: "main-other", name: "other main", pane: "wB:p2", tab: "wB:t2", deps: b.deps });
	for (const m of [main, other]) b.world.herdr.pane(m.pane).cwd = b.project;
	await Promise.all([a.tower.start(), b.tower.start(), main.start(), other.start()]);
	await main.promote();
	await other.promote();
	open.set(ASK, { main: "main-b", mainName: "api main", tower: "tower-b", workspace: "Beta" });
	await until(() => a.server.service.holder?.capsFor(TEAM_HEX, bob.id).includes("tower-reply"), "A to know B takes replies");
	// The server's offer goes only to the sessions on the link channel then, and is not made again for `offerAgainMs`: a promoted main is on it at once.
	assert.ok(listening(b, main.id) && listening(b, other.id), "both mains to be on the link channel as they are promoted");
	const sent = await a.server.ask({ op: "send", device: "bob-mac", text: "yes, the deploy is green", reply: false, inReplyTo: ASK }, a.tower.id);
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal((sent.details as { as: string }).as, "tower-reply");
	await until(() => main.sent.length === 1, "the main to get the reply", 8000);
	const message = main.sent[0]!;
	assert.equal(message.customType, "straw-link");
	assert.equal(message.triggerTurn, true);
	assert.match(message.content, /^\[straw net from=alice-mac id=link:[a-z2-7]{26} role=tower .*verified=yes kind=link_reply scope=session to="api main \(main of /);
	assert.match(message.content, / for=tower-b\] yes, the deploy is green$/);
	assert.equal((message.details as { from: string }).from, alice.id, "the main's remote-turn hooks see the device");
	await until(() => b.server.service.store.inboxIds().length === 0, "the inbox to be empty");
	assert.equal(other.sent.length, 0, "another main gets nothing");
	assert.equal(b.tower.sent.length, 0, "and neither does the tower");
	assert.equal(open.size, 0, "the ask is used");
});

test("a reply is not taken by a main it was not offered for, nor by the tower", async () => {
	const a = computer(root, relay, "a", { gateMs: 60 });
	const b = computer(root, relay, "b", { gateMs: 60, tower: { asks: { take: () => ({ main: "main-b", mainName: "api main", tower: "tower-b", workspace: "Beta" }) } } });
	computers.push(a, b);
	const wrong = b.world.agent({ id: "main-wrong", name: "wrong main", pane: "wB:p1", tab: "wB:t1", deps: b.deps });
	b.world.herdr.pane(wrong.pane).cwd = b.project;
	await Promise.all([a.tower.start(), b.tower.start(), wrong.start()]);
	await wrong.promote();
	await until(() => a.server.service.holder?.capsFor(TEAM_HEX, bob.id).includes("tower-reply"), "caps");
	await a.server.ask({ op: "send", device: "bob-mac", text: "for a main that is gone", reply: false, inReplyTo: ASK }, a.tower.id);
	// The main named is not live, so the holder hands it to an ally run: nobody of this computer's sessions takes it.
	await until(() => b.server.service.store.inboxIds().length === 1 && b.server.service.store.readInbox(b.server.service.store.inboxIds()[0]!)?.askedBy === "api main", "the fallback");
	// Nothing more is coming: the main is on the channel (so an offer to it would have been taken) and the inbox holds the message for the ally run, not for it.
	await until(() => listening(b, wrong.id), "the main to be on the link channel");
	assert.equal(b.server.service.store.inboxIds().length, 1);
	assert.equal(wrong.sent.length, 0);
});

test("a session that becomes main is on the link channel at once, not at its next tick", async () => {
	const b = computer(root, relay, "b", { gateMs: 60 });
	computers.push(b);
	const slow = { ...b.deps, link: { ...b.deps.link, tickMs: 600_000 } };
	const main = b.world.agent({ id: "main-slow", name: "slow main", pane: "wB:p1", tab: "wB:t1", deps: slow });
	b.world.herdr.pane(main.pane).cwd = b.project;
	await Promise.all([b.tower.start(), main.start()]);
	assert.equal(listening(b, main.id), false, "a member is not on the channel");
	await main.promote();
	assert.equal(listening(b, main.id), true);
});
