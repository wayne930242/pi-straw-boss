import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/server/cli.ts";

// `cli.mjs watch` is retired in 0.83.0 (docs/specs/2026-11-23-lite-b2-d-e-f.md §3, boss decision e_cli=retire): one way to watch, `boss_watch`, which the server owns. A monitor that still starts it fails at once and says where to go.

test("the retired `watch` command exits 2 and points to boss_watch", async () => {
	for (const argv of [["watch", "u1"], ["watch", "u1", "--idle", "20m"], ["watch"]]) {
		let out = "", err = "";
		const code = await run(argv, { out: (t) => void (out += t), err: (t) => void (err += t) });
		assert.equal(code, 2, argv.join(" "));
		assert.equal(out, "");
		assert.match(err, /`watch` is retired in 0\.83\.0/);
		assert.match(err, /boss_watch/);
	}
});
