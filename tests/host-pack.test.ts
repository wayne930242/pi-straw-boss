import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakePi } from "./host-fake.ts";

// A plain `pi install npm:pi-straw-boss` installs dispatch (the boss: 「我其實希望 npm 就把派工裝起來」). Spike 0a's first tarball shipped without
// config.json.example and its host failed to load; these tests read the file list npm packs and load the host from those files alone.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const packed = (() => {
	let list: string[] | undefined;
	return () => (list ??= (JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path));
})();

test("npm pack lists the host's entry, its child entry at its fixed path, the config example, the notices and the operating skill, and no test or spike", () => {
	const files = packed();
	for (const want of ["src/host/index.ts", "src/host/engine.ts", "src/host/child.ts", "config.json.example", "NOTICE.md", "LICENSE", "skills/pi-straw-boss-subagents/SKILL.md", "package.json"]) assert.ok(files.includes(want), want);
	assert.ok(!files.some((f) => f.startsWith("tests/") || f.startsWith("spike/") || f.startsWith("docs/")), "no tests, spike or docs");
	assert.ok(!files.some((f) => f.includes("herdr-core")), "no Core provider");
});

test("the host loads from the packed files alone and registers its four tools", { timeout: 120_000 }, async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-packed-")));
	try {
		for (const f of packed()) {
			mkdirSync(dirname(join(dir, f)), { recursive: true });
			copyFileSync(join(ROOT, f), join(dir, f));
		}
		// The dependencies npm would install beside it (Maestro, tsx) and the peers pi provides.
		symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
		const { createHost } = (await import(pathToFileURL(join(dir, "src/host/index.ts")).href)) as typeof import("../src/host/index.ts");
		const { hostState } = (await import(pathToFileURL(join(dir, "src/host/state.ts")).href)) as typeof import("../src/host/state.ts");
		const f = fakePi(join(dir, "src/host/index.ts"));
		createHost({ choice: () => ({ host: "sb", from: "default" }), root: dir })(f.pi);
		await f.emit("session_start");
		assert.equal(hostState()?.state, "active", JSON.stringify(hostState()));
		assert.deepEqual([...new Set(f.tools.map((t) => t.name))].sort(), ["subagent", "subagent_cancel", "subagent_resume", "subagents_list"]);
		const stamp = (globalThis as Record<symbol, { wrapperRoot?: string; failed?: string } | undefined>)[Symbol.for("pi-herdr-agents/load-stamp")];
		assert.equal(stamp?.wrapperRoot, dir, "the load stamp names the packed copy");
		assert.equal(stamp?.failed, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
