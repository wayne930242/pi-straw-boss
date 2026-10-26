import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureTower } from "../src/towertab.ts";
import type { HerdrRun, Workspace } from "../src/herdr.ts";

// The tower's tab (towertab.ts) starts pi in the workspace folder like any other opening, so the same look comes first (trust/settings.ts).

test("a tower is not opened in a folder whose .pi/settings.json pi must not read: no tab is made or claimed, and no pi starts", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-tower-")));
	try {
		mkdirSync(join(dir, ".pi"));
		symlinkSync("/dev/zero", join(dir, ".pi", "settings.json"));
		const ran: string[][] = [];
		const run: HerdrRun = async (args) => {
			ran.push(args);
			const ok = (result: unknown) => JSON.stringify({ result });
			if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "wA", label: "A", tokens: {} }] });
			if (args[0] === "pane" && args[1] === "list") return ok({ panes: [] });
			if (args[0] === "tab" && args[1] === "list") return ok({ tabs: [] });
			return ok({});
		};
		const workspace = { workspace_id: "wA", label: "A", tokens: {} } as unknown as Workspace;
		await assert.rejects(ensureTower({ run, sleep: async () => {}, live: async () => false, moveFirst: async () => {} }, workspace, dir), /pi was not started: .*settings\.json \(a link to \/dev\/zero\) is not a plain file/);
		assert.deepEqual(ran.filter((a) => ["create", "start", "report-metadata", "close"].includes(a[1]!)), [], "nothing was made, written, or started");
		const shell = [{ pane_id: "wA:p9", tab_id: "wA:t9", cwd: dir, tokens: { sb_role: "tower" } }];
		const adopted: string[][] = [];
		const run2: HerdrRun = async (args) => {
			adopted.push(args);
			if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "wB", label: "B", tokens: {} }] } });
			if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: shell } });
			return JSON.stringify({ result: {} });
		};
		await assert.rejects(ensureTower({ run: run2, sleep: async () => {}, live: async () => false, moveFirst: async () => {} }, { workspace_id: "wB", label: "B", tokens: {} } as unknown as Workspace, "/elsewhere"), /pi was not started/);
		assert.deepEqual(adopted.filter((a) => ["start", "report-metadata", "close", "move"].includes(a[1]!)), [], "a leftover tower shell is not started in either");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
