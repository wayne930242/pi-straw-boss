import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHold } from "../src/bosshold.ts";

// `/boss link hold | release | holds | held [end]` (docs/specs/2026-11-26-device-hold.md, Tools and commands): the parser, as a table. Anything else after `/boss link` is another module's.

test("the hold lines parse, a malformed one is usage, and other link lines are not these", () => {
	const rows: [string, unknown][] = [
		["hold box2", { action: "hold", device: "box2" }],
		['hold "box 2" --main work-on --hours 3', { action: "hold", device: "box 2", main: "work-on", hours: "3" }],
		["hold box2 --hours=1.5", { action: "hold", device: "box2", hours: "1.5" }],
		["hold", "usage"],
		["hold box2 extra", "usage"],
		["hold box2 --main", "usage"],
		["hold box2 --force", "usage"],
		["release box2", { action: "release", device: "box2" }],
		["release", "usage"],
		["holds", { action: "holds" }],
		["holds x", "usage"],
		["held", { action: "held", end: false }],
		["held end", { action: "held", end: true }],
		["held stop", "usage"],
		["status", undefined],
		["stop box2 api", undefined],
		[undefined as unknown as string, undefined],
	];
	for (const [line, want] of rows) assert.deepEqual(parseHold(line), want, String(line));
});
