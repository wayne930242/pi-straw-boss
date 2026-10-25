import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { bob, carol, TEAM_HEX } from "./link/holder-world.ts";

// R4-F002: a run that carries senders of two teams reads and searches only inside the project of every one of those teams.

test("senders of two teams with different projects: a read inside one project is put to the gate, not allowed", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-link-teams-")));
	try {
		const [one, two] = [join(root, "one"), join(root, "two")];
		for (const p of [one, two]) mkdirSync(p);
		writeFileSync(join(one, "a.ts"), "export const a = 1;\n");
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", one, "init", "-q"]);
		execFileSync("git", ["-C", one, "add", "a.ts"]);
		const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
		const pi = { events: { on: () => () => {}, emit: () => {} }, on: (t: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(t, h) } as unknown as ExtensionAPI;
		const other = "9".repeat(32);
		const run = (teams: Record<string, string>) => {
			handlers.clear();
			createRemoteTurns({
				pi, now: Date.now, config: () => ({ teams: new Map(Object.entries(teams).map(([id, project]) => [id, { project, share: "status" as const, name: id }])), trust: new Map(), problems: [] }),
				policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: join(root, "home"), agentDir: join(root, "agent"), linkDir: join(root, "agent", "link"), gateMs: 40,
				setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "none" }),
			});
			for (const [team, from] of [[TEAM_HEX, bob.id], [other, carol.id]] as const) handlers.get("message_start")!({ message: { role: "custom", customType: MESSAGE_TYPE, details: { id: from.padStart(32, "0"), team, from, label: "x", short: from.slice(0, 6) } } }, {});
			return handlers.get("tool_call")!({ toolName: "read", toolCallId: "c", input: { path: join(one, "a.ts") } }, { cwd: one, hasUI: false });
		};
		assert.equal(await run({ [TEAM_HEX]: one, [other]: one }), undefined, "the same project for both teams: allowed");
		assert.match(String(((await run({ [TEAM_HEX]: one, [other]: two })) as { reason?: string })?.reason), /declined a remote request/, "two projects: the call is gated");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
