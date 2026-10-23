import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

// Every World made a state directory and never removed it: hundreds of /tmp/psb-state-test-* directories per test run.
test("a World removes its state directory when the process that made it exits", () => {
	const fakes = new URL("./fakes.ts", import.meta.url).href;
	const script = `const { World } = await import(${JSON.stringify(fakes)}); const worlds = [new World(), new World()]; console.log(JSON.stringify(worlds.map((w) => w.stateDir)));`;
	const dirs: string[] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
	assert.equal(dirs.length, 2);
	for (const dir of dirs) assert.equal(existsSync(dir), false, `${dir} is gone after the process exited`);
});
