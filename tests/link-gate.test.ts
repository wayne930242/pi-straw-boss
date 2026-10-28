import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { linkGate, OWNERS, selectDigest } from "../src/owners.ts";
import { MAX_ARGS } from "../src/link/gate.ts";
import { until } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { bob, type Computer, computer, remoteMessage } from "./link/remote-world.ts";

// The gate of a remote turn (docs/specs/2026-10-25-straw-link.md, The gate): its own dialog through the dialog contract, keyed by the call, answerable
// from the terminal or a page, whichever is first; deny, silence, and the end of the call block the tool.

let root = "";
let relay: FakeRelay;
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-gate-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
	rmSync(root, { recursive: true, force: true });
});

type Pending = { version: number; id: string; toolCallId: string; digest: string; select: { title: string; choices: { label: string }[] } };
type Blocked = { block?: boolean; reason?: string } | undefined;

/** A tower with a screen, in a remote turn from bob at reply, with listeners on the gate's channels. */
async function turn(o: { gateMs?: number } = {}) {
	const c = computer(root, relay, "a", { ui: true, gateMs: o.gateMs ?? 5000 });
	computers.push(c);
	await c.tower.start();
	const pending: Pending[] = [], closed: { id: string; by: string; answerId?: string; allow?: boolean }[] = [], results: { id: string; answerId: string; accepted: boolean; reason?: string }[] = [];
	c.tower.on("straw-link:gate:pending", (d) => void pending.push(d as Pending));
	c.tower.on("straw-link:gate:closed", (d) => void closed.push(d as (typeof closed)[number]));
	c.tower.on("straw-link:gate:answer-result", (d) => void results.push(d as (typeof results)[number]));
	await c.tower.fire("message_start", { message: remoteMessage(bob, "bob-mac") });
	const call = (toolName: string, input: Record<string, unknown>, toolCallId: string) => c.tower.fireResult("tool_call", { toolName, toolCallId, input }) as Promise<Blocked>;
	const answer = (p: Pending, choice: number, over: Record<string, unknown> = {}) => c.tower.emit("straw-link:gate:answer", { version: 1, id: p.id, answerId: `answer-${choice}-`.padEnd(16, "x"), digest: p.digest, selections: [choice], ...over });
	return { c, pending, closed, results, call, answer };
}

test("the gate is a contract owner registered as a gate, not a twin", () => {
	assert.ok(OWNERS.includes(linkGate));
	assert.deepEqual([linkGate.name, linkGate.gate, linkGate.twin, linkGate.tool], ["straw-link-gate", true, undefined, undefined]);
});

test("the dialog: keyed by the call, the sender's label and short id, the tool, and its full arguments; Allow and Deny; a digest the page must echo", async () => {
	const { c, pending, call, answer } = await turn();
	const held = call("bash", { command: "rm -rf build", cwd: "/tmp" }, "tc-1");
	await until(() => pending.length === 1, "the gate's dialog");
	const p = pending[0]!;
	assert.equal(p.version, 1);
	assert.equal(p.toolCallId, "tc-1");
	assert.match(p.select.title, /^Remote request from bob-mac \(\w{6}\): bash\n\n/);
	assert.ok(p.select.title.includes(JSON.stringify({ command: "rm -rf build", cwd: "/tmp" }, null, 2)), "every argument, in full");
	assert.deepEqual(p.select.choices.map((x) => x.label), ["Allow", "Deny"]);
	assert.equal(p.digest, selectDigest(p.select as never));
	assert.equal(c.tower.dialogs.length, 1, "the terminal shows the same confirm");
	assert.equal(c.tower.dialogs[0]!.kind, "confirm");
	assert.match(c.tower.dialogs[0]!.title, /Remote request from bob-mac/);
	answer(p, 0);
	assert.equal(await held, undefined);
});

test("terminal answer: Allow lets the call run and closes the page's dialog as local; a page answer that comes late hears it is closed", async () => {
	const { c, pending, closed, results, call, answer } = await turn();
	const held = call("bash", { command: "ls" }, "tc-1");
	await until(() => c.tower.dialogs.length === 1 && pending.length === 1, "both dialogs");
	c.tower.dialogs[0]!.settle(true);
	assert.equal(await held, undefined);
	assert.deepEqual(closed.map((x) => [x.id, x.by]), [[pending[0]!.id, "local"]]);
	answer(pending[0]!, 1);
	assert.deepEqual(results.map((r) => [r.accepted, r.reason]), [[false, "closed"]]);
});

test("terminal answer: Deny blocks the call with the boss's reason", async () => {
	const { c, pending, call } = await turn();
	const held = call("bash", { command: "ls" }, "tc-1");
	await until(() => c.tower.dialogs.length === 1 && pending.length === 1, "both dialogs");
	c.tower.dialogs[0]!.settle(false);
	const out = (await held)!;
	assert.equal(out.block, true);
	assert.equal(out.reason, "the boss declined a remote request");
});

test("page answer: the terminal's confirm is aborted and the page hears it was taken; Deny from the page blocks", async () => {
	const { c, pending, closed, results, call, answer } = await turn();
	const held = call("write", { path: "x", content: "y" }, "tc-1");
	await until(() => c.tower.dialogs.length === 1 && pending.length === 1, "both dialogs");
	answer(pending[0]!, 0);
	assert.equal(await held, undefined);
	assert.equal(c.tower.dialogs[0]!.opts?.signal?.aborted, true, "the terminal dialog was closed by the page's answer");
	assert.deepEqual(results.map((r) => r.accepted), [true]);
	assert.deepEqual(closed.map((x) => [x.by, x.answerId]), [["remote", `answer-0-`.padEnd(16, "x")]]);
	const next = call("write", { path: "x2", content: "y" }, "tc-2");
	await until(() => pending.length === 2, "the second dialog");
	answer(pending[1]!, 1);
	assert.match((await next)!.reason!, /declined a remote request/);
});

test("a page answer with the wrong digest, a bad answer id, or a bad selection is refused and the dialog stays open", async () => {
	const { c, pending, results, call, answer } = await turn();
	const held = call("bash", { command: "ls" }, "tc-1");
	await until(() => pending.length === 1, "the dialog");
	const p = pending[0]!;
	answer(p, 0, { digest: "0".repeat(64) });
	answer(p, 0, { answerId: "short" });
	answer(p, 7);
	answer(p, 0, { selections: [0, 1] });
	answer({ ...p, id: "unknown-dialog" }, 0);
	assert.deepEqual(results.map((r) => r.reason), ["digest", "malformed", "malformed", "malformed"], "an answer for an unknown id gets no reply");
	assert.equal(c.tower.dialogs[0]!.settled, false);
	answer(p, 1);
	assert.match((await held)!.reason!, /declined/);
});

test("no answer within the time blocks the call, closes both dialogs as a timeout, and a late answer is refused", async () => {
	const { c, pending, closed, results, call, answer } = await turn({ gateMs: 80 });
	const out = (await call("bash", { command: "ls" }, "tc-1"))!;
	assert.equal(out.block, true);
	assert.match(out.reason!, /declined a remote request: no answer within/);
	assert.equal(c.tower.dialogs[0]!.opts?.signal?.aborted, true);
	assert.deepEqual(closed.map((x) => x.by), ["timeout"]);
	answer(pending[0]!, 0);
	assert.deepEqual(results.map((r) => [r.accepted, r.reason]), [[false, "closed"]]);
});

test("the end of the tool call (its abort signal) blocks it and closes the dialogs", async () => {
	const { c, pending, closed, call } = await turn();
	const ac = new AbortController();
	c.tower.signal = ac.signal;
	const held = call("bash", { command: "ls" }, "tc-1");
	await until(() => pending.length === 1, "the dialog");
	ac.abort();
	assert.match((await held)!.reason!, /aborted/);
	assert.deepEqual(closed.map((x) => x.by), ["abort"]);
	assert.equal(c.tower.dialogs[0]!.opts?.signal?.aborted, true);
});

test("a parallel batch: each call has its own dialog keyed by its toolCallId, answered independently from the page", async () => {
	const { c, pending, call, answer } = await turn();
	const first = call("bash", { command: "one" }, "tc-1"), second = call("edit", { path: "p", edits: [] }, "tc-2");
	await until(() => pending.length === 2, "both dialogs");
	assert.deepEqual(pending.map((p) => p.toolCallId).sort(), ["tc-1", "tc-2"]);
	assert.notEqual(pending[0]!.id, pending[1]!.id);
	assert.equal(c.tower.dialogs.length, 2, "and a terminal confirm each");
	const [a, b] = [pending.find((p) => p.toolCallId === "tc-2")!, pending.find((p) => p.toolCallId === "tc-1")!];
	answer(a, 1);
	assert.match((await second)!.reason!, /declined/);
	answer(b, 0);
	assert.equal(await first, undefined);
});

test("arguments longer than the dialog may show are refused without a dialog, not confirmed in part", async () => {
	const { c, pending, call } = await turn();
	const out = (await call("bash", { command: "x".repeat(MAX_ARGS) }, "tc-1"))!;
	assert.equal(out.block, true);
	assert.match(out.reason!, /cannot be confirmed/);
	assert.equal(pending.length, 0);
	assert.equal(c.tower.dialogs.length, 0);
	const ok = call("bash", { command: "x".repeat(MAX_ARGS - 100) }, "tc-2");
	await until(() => pending.length === 1, "a call that fits opens the gate");
	c.tower.dialogs[0]!.settle(true);
	assert.equal(await ok, undefined);
});

test("a screenless tower can still be answered from a page", async () => {
	const c = computer(root, relay, "a", { ui: false, gateMs: 5000 });
	computers.push(c);
	await c.tower.start();
	const pending: Pending[] = [];
	c.tower.on("straw-link:gate:pending", (d) => void pending.push(d as Pending));
	await c.tower.fire("message_start", { message: remoteMessage(bob, "bob-mac") });
	const held = c.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "tc-1", input: { command: "ls" } }) as Promise<Blocked>;
	await until(() => pending.length === 1, "the dialog");
	assert.equal(c.tower.dialogs.length, 0);
	c.tower.emit("straw-link:gate:answer", { version: 1, id: pending[0]!.id, answerId: "a".repeat(16), digest: pending[0]!.digest, selections: [0] });
	assert.equal(await held, undefined);
});

test("a call the gate let through keeps its whole output; a grep outside the project, once allowed, is not filtered", async () => {
	const { c, pending, call, answer } = await turn();
	const held = call("grep", { pattern: "x", path: "/" }, "tc-1");
	await until(() => pending.length === 1, "the dialog");
	answer(pending[0]!, 0);
	assert.equal(await held, undefined);
	const out = await c.tower.fireResult("tool_result", { toolName: "grep", toolCallId: "tc-1", input: { pattern: "x", path: "/" }, content: [{ type: "text", text: "etc/hosts:1: x" }], isError: false });
	assert.equal(out, undefined, "the boss allowed it");
});

test("the gate's close says whether it ended with an explicit yes, whoever gave it: the page, the terminal, and a deny are told apart (the sb server's Allow check relies on it)", async () => {
	const { c, pending, closed, call, answer } = await turn();
	const page = call("bash", { command: "ls" }, "tc-1");
	await until(() => pending.length === 1, "the gate");
	answer(pending[0]!, 0);
	await page;
	const local = call("bash", { command: "ls" }, "tc-2");
	await until(() => pending.length === 2 && c.tower.dialogs.length === 2, "the terminal confirm");
	c.tower.dialogs.at(-1)!.settle(true);
	await local;
	const denied = call("bash", { command: "ls" }, "tc-3");
	await until(() => pending.length === 3, "the third gate");
	answer(pending[2]!, 1);
	await denied;
	assert.deepEqual(closed.map((x) => [x.by, x.allow]), [["remote", true], ["local", true], ["remote", false]]);
});

test("the gate's close after a timeout says no", async () => {
	const { closed, call } = await turn({ gateMs: 60 });
	await call("bash", { command: "ls" }, "tc-4");
	assert.deepEqual(closed.map((x) => [x.by, x.allow]), [["timeout", false]]);
});
