import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { World } from "./fakes.ts";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { bob, TEAM_HEX } from "./link/holder-world.ts";

// A main rotates its own session (docs/specs/2026-11-23-tower-revive.md §8): boss_handover opens its successor in a new tab of its workspace through the opener's safe start, with the handoff file as the new pi's
// first prompt and the old main's kind and name. No /new, no boss.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");
const NEW = { tab: "wA:t100", pane: "wA:p101", main: "opened-wA:p101" };

async function main() {
	world.autoMains();
	const m = world.agent({ id: "main-1", name: "box watch", pane: "wA:p1", tab: "wA:t1" });
	m.file = join(mkdtempSync(join(tmpdir(), "psb-handover-s-")), "2026-11-23T00-00-00-000Z_main-1.jsonl");
	await m.start();
	await m.promote();
	await m.tool("boss_duty", { duty: "standing", reason: "it minds the box" });
	const handoff = join(mkdtempSync(join(tmpdir(), "psb-handover-")), "handoff-box-watch.md");
	writeFileSync(handoff, "# Handoff\n- goal: mind the box\n");
	return { m, handoff };
}

test("a main's handover opens one successor tab in its workspace with its name and kind, and the handoff path is the new pi's first prompt", async () => {
	const { m, handoff } = await main();
	const result = await m.tool("boss_handover", { handoff, reason: "pi-session-doctor measured repeated stalls" });
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "box watch", "--cwd", process.cwd(), "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	const [start] = world.herdr.commands("agent", "start");
	assert.deepEqual(start!.slice(-2), ["--name", "box watch"], "the successor takes the old main's name");
	const tokens = world.herdr.calls.find((c) => c[1] === "report-metadata" && c[2] === NEW.pane && c.includes("sb_open_main=1"))!;
	assert.ok(tokens.includes("sb_open_duty=standing"), "and its kind");
	assert.ok(tokens.includes("sb_handover_from=main-1"));
	const successor = world.agents.find((a) => a.id === NEW.main)!;
	assert.equal(successor.tokens.sb_role, "main");
	assert.equal(world.herdr.pane(NEW.pane).tokens.sb_duty, "standing");
	const prompt = world.broker.delivered.filter((d) => d.to === NEW.main);
	assert.equal(prompt.length, 1);
	assert.match(prompt[0]!.message, /main box watch \(session main-1\) opened this tab for you with boss_handover .* its reason: pi-session-doctor measured repeated stalls\./s);
	assert.match(prompt[0]!.message, new RegExp(`Read the handoff file ${handoff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} now`));
	assert.match(prompt[0]!.message, /tell box watch by intercom \(send, to "main-1"\) that you took over/);
	assert.match(textOf(result), /Opened your successor in tab wA:t100 .* give up your role as your rule says: boss_duty coordinator .* boss_rename to "old box watch \(handed over to opened-w\)"/s);
	assert.deepEqual(world.herdr.commands("tab", "focus"), [], "the boss's focus stays where it is");
});

test("RVR-F004: a main that handed over marks its role record, keeps the mark through its step-down, and is never raised as dead or revived", async () => {
	const { m, handoff } = await main();
	const { recordPath } = await import("../src/roles.ts");
	const { readFileSync } = await import("node:fs");
	const record = () => JSON.parse(readFileSync(recordPath(world.stateDir, m.file!), "utf8")) as { role: string; handedOver?: { to: string; at: number } };
	assert.equal(record().handedOver, undefined);
	await m.tool("boss_handover", { handoff, reason: "stalls" });
	assert.equal(record().handedOver?.to, NEW.main, "the record names the successor");
	await m.tool("boss_duty", { duty: "coordinator", reason: "stepping down after the handover" });
	assert.equal(record().role, "main");
	assert.equal(record().handedOver?.to, NEW.main, "a rewrite of the record keeps the mark");
	const { REVIVABLE } = await import("../src/revive.ts");
	assert.ok(!REVIVABLE.includes("handed"));
});

test("a second handover while the successor lives is refused; once its pane is gone another is allowed", async () => {
	const { m, handoff } = await main();
	await m.tool("boss_handover", { handoff, reason: "stalls" });
	await assert.rejects(m.tool("boss_handover", { handoff, reason: "again" }), /Your successor in pane wA:p101 \(tab wA:t100\) is still live: one at a time/);
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== NEW.pane);
	await m.tool("boss_handover", { handoff, reason: "the first one never took over" });
	assert.equal(world.herdr.commands("tab", "create").length, 2);
});

test("RVR-F006: two handovers at once open one successor, and one is refused while Herdr cannot say whether the last successor lives", async () => {
	const { m, handoff } = await main();
	const both = await Promise.allSettled([m.tool("boss_handover", { handoff, reason: "stalls" }), m.tool("boss_handover", { handoff, reason: "stalls too" })]);
	assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.match(String((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /A handover of this main is under way: one at a time/);
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	world.herdr.failPanes = true;
	await assert.rejects(m.tool("boss_handover", { handoff, reason: "again" }), /Herdr cannot say whether your successor in pane wA:p101 \(tab wA:t100\) is still live/);
	world.herdr.failPanes = false;
	assert.equal(world.herdr.commands("tab", "create").length, 1);
});

test("a member, a missing handoff file, and a tower are refused; nothing opens", async () => {
	const { handoff } = await main();
	const member = world.agent({ id: "member-1", name: "helper", pane: "wA:p2", tab: "wA:t1" });
	await member.start();
	await assert.rejects(member.tool("boss_handover", { handoff, reason: "x" }), /Only a tab's main agent hands over; a member has no role to pass on/);
	const m = world.agents.find((a) => a.id === "main-1")!;
	await assert.rejects(m.tool("boss_handover", { handoff: "/nowhere/handoff.md", reason: "x" }), /does not exist .*: write it first/);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	assert.ok(!tower.tools.has("boss_handover"), "a tower has no such tool: it hands over by itself");
	assert.equal(world.herdr.commands("tab", "create").length, 0);
	const { RUN_TOWER_TOOLS } = await import("../src/runallow.ts");
	assert.ok(!(RUN_TOWER_TOOLS as readonly string[]).includes("boss_handover"), "nor does a tower run");
});

test("RVR-F002: a main opened for a teammate's device does not hand over: its successor would run outside the device's revoke and signed stop", async () => {
	world.autoMains();
	world.herdr.addTab("wA:t5", "peer work");
	world.herdr.addPane("wA:p5", "wA:t5").tokens = { sb_open_main: "1", sb_opened_by: "link:DEVICE01" };
	const m = world.agent({ id: "peer-main", name: "peer work", pane: "wA:p5", tab: "wA:t5", env: { STRAW_BOSS_ROLE: "main" } });
	await m.start();
	assert.equal(m.tokens.sb_opened_by, "link:DEVICE01", "the claim took the device's mark");
	const handoff = join(mkdtempSync(join(tmpdir(), "psb-handover-")), "handoff-peer.md");
	writeFileSync(handoff, "# Handoff\n");
	await assert.rejects(m.tool("boss_handover", { handoff, reason: "stalls" }), /A main opened for a teammate's device \(link:DEVICE01\) does not hand over: .*the device asks again/);
	assert.equal(world.herdr.commands("tab", "create").length, 0);
});

test("a remote turn cannot open a successor, whatever its sender's level", async () => {
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const root = mkdtempSync(join(tmpdir(), "psb-handover-remote-"));
	const pi = { events: { on: () => () => {}, emit: () => {} }, on: (t: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(t, h) } as unknown as ExtensionAPI;
	createRemoteTurns({
		pi, now: Date.now, config: () => ({ teams: new Map([[TEAM_HEX, { project: root, share: "status" as const, name: "t" }]]), trust: new Map([[bob.id, "dispatch" as const]]), problems: [] }),
		policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: root, agentDir: root, linkDir: root, gateMs: 40,
		setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "none" }),
	});
	const call = () => handlers.get("tool_call")!({ toolName: "boss_handover", toolCallId: "c", input: { handoff: "/x", reason: "a peer asks" } }, { cwd: root, hasUI: false });
	assert.equal(await call(), undefined, "a local turn is let through to the tool's own checks");
	handlers.get("message_start")!({ message: { role: "custom", customType: MESSAGE_TYPE, details: { id: bob.id.padStart(32, "0"), team: TEAM_HEX, from: bob.id, label: "bob", short: bob.id.slice(0, 6) } } }, {});
	const blocked = (await call()) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(String(blocked.reason), /a remote turn cannot open a successor of this main/);
});
