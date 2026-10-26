import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// sb server B1 on Windows: `cli.mjs up` and the detached server exited 13 ("unsettled top-level await") because the start-time read awaits a PowerShell child whose child
// process, pipes, and timers are all unref'd, so nothing kept the event loop alive. macOS and Linux read the start time synchronously and never showed it. These run a
// script in a child node process (an unsettled top-level await is a property of a whole process) with the Windows path of createStartOf and the real reader (spawnQuietly) on a child that answers after 300 ms.

const startof = pathToFileURL(new URL("../src/startof.ts", import.meta.url).pathname).href;
const READER = `
import { createStartOf, spawnQuietly } from ${JSON.stringify(startof)};
const answer = "2026-10-26T04:21:53.000Z";
// The real reader (spawnQuietly: the child, its pipes, and its timeout timer never hold the process open), pointed at a node child that answers after 300 ms instead of PowerShell.
// (The real call runs from System32 by its absolute path; the stand-in child has neither.)
const launch = (_file, _args, { cwd: _cwd, ...options }, done) => spawnQuietly(process.execPath, ["-e", "setTimeout(() => console.log('" + answer + "'), 300)"], options, done);
const { startedLater, startOf } = createStartOf({ platform: "win32", launch, wait: async () => {} });
`;
const run = (body: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `${READER}\n${body}`], { encoding: "utf8", timeout: 20_000 });

test("an awaited start time keeps the process alive until the unref'd PowerShell child answers (it used to exit 13)", () => {
	const result = run(`console.log("got " + await startedLater(process.pid));`);
	assert.equal(result.stderr, "", result.stderr);
	assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
	assert.equal(result.stdout.trim(), "got 2026-10-26T04:21:53.000Z");
});

test("the hold ends with the answer: a read that fails does not keep the process alive either", () => {
	const result = run(`const { startedLater: failing } = (await import(${JSON.stringify(startof)})).createStartOf({ platform: "win32", wait: async () => {}, launch: (_f, _a, _o, done) => { const t = setTimeout(() => done(new Error("timed out"), ""), 200); t.unref(); } });
console.log("got " + await failing(process.pid));`);
	assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
	assert.equal(result.stdout.trim(), "got undefined");
});

test("a start time read for a record in the background does not hold the process open: pi may leave with a read still pending", () => {
	const result = run(`void startedLater(process.pid, { hold: false }); startOf(process.pid); console.log("left");`);
	assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
	assert.equal(result.stdout.trim(), "left");
});

test("cli.ts run as a script holds a timer while `run` is awaited, and still ends at once with its exit code (status of a state directory with no server: gone, exit 0)", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-hold-"));
	try {
		const cli = new URL("../src/server/cli.ts", import.meta.url).pathname;
		const result = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), HERDR_SOCKET_PATH: join(dir, "herdr.sock") } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal((JSON.parse(result.stdout) as { state: string }).state, "gone");
		assert.ok(readFileSync(cli, "utf8").includes("setInterval(() => {}, 2 ** 30);"), "the hold is in the script's entry");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
