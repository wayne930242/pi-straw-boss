import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "../src/board.ts";
import type { Derived } from "../src/boardauto.ts";
import { BOARD_ENTRY, seedBoard, withdrawnKey } from "../src/boardseed.ts";

const text = { now: "api: next a", items: [{ t: "a", done: false }] };
const live: Derived = { text, count: { done: 0, total: 1 } };
const done: Derived = { text: { now: "api: done (2/2)", items: [{ t: "x", done: true }] }, count: { done: 2, total: 2 } };
const entry = (over: Partial<Entry>): Entry => ({ v: 1, session: "s", updated: 5, src: "todo", ...text, ...over });
const K = (d: Derived | undefined) => JSON.stringify(d ?? null);

test("seedBoard: table", () => {
	const rows: [string, Parameters<typeof seedBoard>[0], ReturnType<typeof seedBoard>][] = [
		["board_set line stands", { own: entry({ src: "set" }), derived: live, key: K(live), withdrawn: undefined }, { last: K(live) }],
		["same auto line kept", { own: entry({}), derived: live, key: K(live), withdrawn: undefined }, { last: K(live) }],
		["same finished line keeps its age", { own: entry({ ...done.text, count: done.count! }), derived: done, key: K(done), withdrawn: undefined }, { last: K(done), doneAt: 5 }],
		["different auto line is rewritten", { own: entry({ now: "old" }), derived: live, key: K(live), withdrawn: undefined }, {}],
		["withdrawn key, no line", { own: undefined, derived: live, key: K(live), withdrawn: K(live) }, { last: K(live) }],
		["withdrawn for another key, no line", { own: undefined, derived: live, key: K(live), withdrawn: K(done) }, {}],
		["finished list, no line, at a start (purged): not rewritten", { own: undefined, derived: done, key: K(done), withdrawn: undefined, atStart: true }, { last: K(done) }],
		["finished list, no line, later: written", { own: undefined, derived: done, key: K(done), withdrawn: undefined }, {}],
		["unfinished list, no line: written", { own: undefined, derived: live, key: K(live), withdrawn: undefined }, {}],
		["nothing derivable, no line", { own: undefined, derived: undefined, key: K(undefined), withdrawn: undefined }, {}],
	];
	for (const [name, input, want] of rows) assert.deepEqual(seedBoard(input), want, name);
});

test("withdrawnKey: the newest withdrawal of the branch", () => {
	const w = (cleared: unknown) => ({ type: "custom", customType: BOARD_ENTRY, data: { cleared } });
	assert.equal(withdrawnKey([]), undefined);
	assert.equal(withdrawnKey([w("a"), { type: "message" }, w("b"), w(3)]), "b");
});
