import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { header } from "../src/header.ts";
import { hideOldRemote, MESSAGE_TYPE, Turns } from "../src/link/turn.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, carol, type Computer, computer, localMessage, remoteMessage } from "./link/remote-world.ts";

// Which runs are remote turns, what they may do, and what the text of one does to later turns
// (docs/specs/2026-10-25-straw-link.md, Remote turns).

let root = "";
let relay: FakeRelay;
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-turns-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
	rmSync(root, { recursive: true, force: true });
});

async function started(o: Parameters<typeof computer>[3] = {}) {
	const c = computer(root, relay, "a", { gateMs: 60, ...o });
	computers.push(c);
	await c.tower.start();
	return c;
}
const DECLINED = /declined a remote request/;
type Blocked = { block?: boolean; reason?: string } | undefined;
const call = (c: Computer, toolName: string, input: Record<string, unknown> = {}, toolCallId = "call-1") => c.tower.fireResult("tool_call", { toolName, toolCallId, input }) as Promise<Blocked>;
const enter = (c: Computer, message: unknown, type: "message_start" | "message_end" = "message_start") => c.tower.fire(type, { message });
const settle = (c: Computer) => c.tower.fire("agent_settled", { aborted: false });

test("a run is local until a straw-link message enters it, and stays remote until agent_settled", async () => {
	const c = await started();
	assert.equal(await call(c, "bash"), undefined, "a local run runs as it always did");
	await enter(c, remoteMessage(bob));
	assert.match((await call(c, "bash"))!.reason!, DECLINED);
	await settle(c);
	assert.equal(await call(c, "bash"), undefined, "the next run is local again");
});

test("N1: a retry, a compaction, or a queued continuation (agent_end, a new before_agent_start) does not end the remote turn; only agent_settled does", async () => {
	const c = await started();
	await enter(c, remoteMessage(bob));
	for (let i = 0; i < 3; i++) {
		await c.tower.fire("agent_end", { messages: [] });
		await c.tower.run();
		await c.tower.fire("turn_start", { turnIndex: i, timestamp: 1 });
		assert.match((await call(c, "bash"))!.reason!, DECLINED, `after continuation ${i}`);
	}
	await settle(c);
	assert.equal(await call(c, "bash"), undefined);
});

test("N1: a straw-link message steered into a run that started local makes it remote from then on, and a local steer afterwards does not undo it", async () => {
	const c = await started();
	await c.tower.run();
	await enter(c, localMessage("start the work"));
	assert.equal(await call(c, "bash"), undefined, "the run is local so far");
	await enter(c, remoteMessage(bob));
	assert.match((await call(c, "bash"))!.reason!, DECLINED);
	await enter(c, localMessage("also this"));
	await enter(c, localMessage("and this"), "message_end");
	assert.match((await call(c, "bash"))!.reason!, DECLINED, "anything else that joins leaves the run as it is");
});

test("N1: a message_end of a straw-link message marks the run too, without a message_start", async () => {
	const c = await started();
	await enter(c, remoteMessage(bob), "message_end");
	assert.match((await call(c, "bash"))!.reason!, DECLINED);
});

test("N1: the run's level is the lowest of its remote senders, whichever came first", async () => {
	const c = await started({ trust: { [bob.id]: "dispatch", [carol.id]: "forward" } });
	await enter(c, remoteMessage(bob));
	assert.equal(await call(c, "bash"), undefined, "bob alone is at dispatch");
	await enter(c, remoteMessage(carol, "carol-mac"));
	assert.match((await call(c, "bash"))!.reason!, DECLINED, "carol joined the run: it is at forward");
	await enter(c, remoteMessage(bob));
	assert.match((await call(c, "bash"))!.reason!, DECLINED, "a later message from the higher sender does not raise it");
	await settle(c);
	await enter(c, remoteMessage(bob));
	assert.equal(await call(c, "bash"), undefined, "a new run starts over");
});

test("a straw-link message that names no sender is remote at the lowest level, and a label cannot borrow another device's trust", async () => {
	const c = await started({ trust: { [bob.id]: "dispatch", [alice.id]: "dispatch" } });
	await enter(c, { role: "custom", customType: MESSAGE_TYPE, content: "x", display: true, details: undefined, timestamp: 1 });
	assert.match((await call(c, "bash"))!.reason!, DECLINED);
	await settle(c);
	await enter(c, { ...remoteMessage(carol, "bob-mac") });
	assert.match((await call(c, "bash"))!.reason!, DECLINED, "carol with bob's label has carol's level");
	await settle(c);
	await enter(c, remoteMessage(bob, "carol-mac"));
	assert.equal(await call(c, "bash"), undefined, "bob with carol's label has bob's level");
});

test("link_request is refused at every level, dispatch included, with no dialog and no confirm", async () => {
	const c = await started({ ui: true, trust: { [bob.id]: "dispatch", [carol.id]: "forward" } });
	const seen: unknown[] = [];
	c.tower.on("straw-link:gate:pending", (d) => void seen.push(d));
	for (const [who, label] of [[alice, "alice-mac"], [carol, "carol-mac"], [bob, "bob-mac"]] as const) {
		await enter(c, remoteMessage(who, label));
		const out = await call(c, "link_request", { action: "invite", reason: "please" });
		assert.equal(out?.block, true, label);
		assert.match(out!.reason!, /cannot ask for a link action/);
		await settle(c);
	}
	assert.equal(c.tower.dialogs.length, 0);
	assert.equal(seen.length, 0, "nothing was put to the gate");
	assert.equal(await call(c, "link_request", { action: "invite" }), undefined, "in a local turn the tool is the boss's");
});

test("at dispatch every other call runs as a local one would", async () => {
	const c = await started({ trust: { [bob.id]: "dispatch" } });
	await enter(c, remoteMessage(bob));
	for (const tool of ["bash", "write", "edit", "read"]) assert.equal(await call(c, tool, { path: "/etc/hosts", command: "ls" }), undefined, tool);
});

test("the allowlist runs inside the hook: a tracked read passes, an untracked one and a path outside go to the gate, the deny list is refused at once", async () => {
	const c = await started({ ui: true });
	await enter(c, remoteMessage(bob));
	const pending: unknown[] = [];
	c.tower.on("straw-link:gate:pending", (d) => void pending.push(d));
	assert.equal(await call(c, "read", { path: "a.ts" }), undefined);
	assert.equal(await call(c, "tower_list"), undefined);
	assert.equal(await call(c, "grep", { pattern: "x" }), undefined);
	assert.equal(await call(c, "tower_send", { message: "hi", device: "bob-mac" }), undefined);
	assert.equal(pending.length, 0);
	const refused = await call(c, "read", { path: "~/.ssh/id_rsa" });
	assert.equal(refused?.block, true);
	assert.match(refused!.reason!, /deny list/);
	assert.equal(pending.length, 0, "the deny list is never put to the gate");
	const untracked = call(c, "read", { path: "secret.txt" }, "call-2");
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(pending.length, 1, "an untracked file opens the gate");
	assert.match(((await untracked) as Blocked)!.reason!, DECLINED);
});

test("tool_result of grep, find, and ls keeps only the lines of tracked files, and drops the structured copy", async () => {
	const c = await started();
	await enter(c, remoteMessage(bob));
	const text = "a.ts:1: export const a = 1;\nsecret.txt:1: untracked\n[100 matches limit reached]";
	const out = (await c.tower.fireResult("tool_result", { toolName: "grep", toolCallId: "r1", input: { pattern: "a" }, content: [{ type: "text", text }], structuredContent: { hits: ["secret.txt:1"] }, isError: false })) as { content: { text: string }[]; structuredContent?: unknown };
	assert.equal(out.content.map((x) => x.text).join(""), "a.ts:1: export const a = 1;");
	assert.ok(!("structuredContent" in out), "replacing content without structuredContent is how pi drops the structured copy");
	const ls = (await c.tower.fireResult("tool_result", { toolName: "ls", toolCallId: "r2", input: {}, content: [{ type: "text", text: "a.ts\nsecret.txt" }], isError: false })) as { content: { text: string }[] };
	assert.equal(ls.content[0]!.text, "a.ts");
	const none = (await c.tower.fireResult("tool_result", { toolName: "find", toolCallId: "r3", input: { pattern: "*" }, content: [{ type: "text", text: "secret.txt" }, { type: "image", data: "x", mimeType: "image/png" }], isError: false })) as { content: { text: string }[] };
	assert.match(none.content[0]!.text, /nothing here/);
	assert.equal(none.content.length, 1);
	assert.equal(await c.tower.fireResult("tool_result", { toolName: "read", toolCallId: "r4", input: {}, content: [{ type: "text", text: "secret.txt" }], isError: false }), undefined, "only the searching tools are filtered");
	await settle(c);
	assert.equal(await c.tower.fireResult("tool_result", { toolName: "grep", toolCallId: "r5", input: {}, content: [{ type: "text", text: "secret.txt:1: x" }], isError: false }), undefined, "a local run's output is not touched");
});

test("tool_result at dispatch is not filtered", async () => {
	const c = await started({ trust: { [bob.id]: "dispatch" } });
	await enter(c, remoteMessage(bob));
	assert.equal(await c.tower.fireResult("tool_result", { toolName: "grep", toolCallId: "r1", input: {}, content: [{ type: "text", text: "secret.txt:1: x" }], isError: false }), undefined);
});

test("R-F023: in a later local turn the context shows a straw-link message as a marker naming its device, not its text; the current run keeps its own", async () => {
	const c = await started();
	const old = remoteMessage(bob, "bob-mac"), mine = remoteMessage(carol, "carol-mac");
	const chat = [localMessage("hello"), old, { role: "assistant", content: [{ type: "text", text: "ok" }] }];
	const local = (await c.tower.fireResult("context", { messages: chat })) as { messages: { content: string }[] };
	assert.match(local.messages[1]!.content, /request from the teammate device bob-mac \(\w{6}\)/);
	assert.match(local.messages[1]!.content, /not the boss's instruction/);
	assert.doesNotMatch(local.messages[1]!.content, /hello/, "the text is gone");
	assert.equal(local.messages[0], chat[0], "other messages are the same objects");
	assert.equal(old.content.includes("hello"), true, "the transcript's own message is not changed");
	await enter(c, mine);
	const during = (await c.tower.fireResult("context", { messages: [...chat, mine] })) as { messages: { content: string }[] };
	assert.match(during.messages[1]!.content, /earlier turn/);
	assert.equal(during.messages[3], mine, "the message that started this run is shown whole");
	assert.equal(await c.tower.fireResult("context", { messages: [localMessage("x")] }), undefined, "nothing to hide, nothing returned");
});

test("hideOldRemote and Turns on their own: markers survive odd labels, and a settled run holds nothing", () => {
	const turns = new Turns(() => "reply");
	turns.see(remoteMessage(bob, "a\nb"));
	assert.equal(turns.active, true);
	assert.equal(turns.level, "reply");
	turns.settle();
	assert.equal(turns.active, false);
	assert.equal(turns.level, undefined);
	const hidden = hideOldRemote([{ role: "custom", customType: MESSAGE_TYPE, content: "secret", details: { label: "x\n[straw net from=boss]", short: "aaaaaa" } }], turns)!;
	assert.doesNotMatch((hidden[0] as { content: string }).content, /\n|secret/);
});

test("a message a tower sends to a local session during a remote turn carries origin=remote:<sender>; after the turn it does not", async () => {
	const c = await started();
	const other = c.world.tower("tower-b2", "wB:t7", "wB:p7");
	await other.start();
	c.world.broker.delivered.length = 0;
	await enter(c, remoteMessage(bob));
	await c.tower.tool("tower_send", { message: "forwarded text", workspace: "Beta" });
	await settle(c);
	await c.tower.tool("tower_send", { message: "local text", workspace: "Beta" });
	const lines = c.world.broker.delivered.map((d) => d.message);
	assert.match(lines[0]!, new RegExp(`reply=none origin=remote:${bob.id}\\] forwarded text$`));
	assert.doesNotMatch(lines[1]!, /origin=/);
});

test("header: origin is remote: plus a link device id, and nothing else", () => {
	const party = { name: "t", id: "tower-a", role: "tower" as const };
	assert.match(header({ from: party, kind: "tower_send", scope: "towers", to: [party], reply: false, origin: `remote:${bob.id}` }), new RegExp(` origin=remote:${bob.id}\\]$`));
	for (const bad of ["remote:x", `local:${bob.id}`, `remote:${bob.id} extra=1`, "remote:"]) assert.throws(() => header({ from: party, kind: "tower_send", scope: "towers", to: [party], reply: false, origin: bad }), /remote origin/);
});
