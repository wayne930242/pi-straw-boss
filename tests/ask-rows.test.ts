import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { registerAskRows } from "../src/askrows.ts";
import { ASK_ROWS_EVENT, type AskRowV1 } from "../src/asktypes.ts";

// `straw-boss:ask-rows:v1` (docs/specs/2026-11-28-boss-asks.md, The probe): the session asks its server for the rows, answers the probe from the last answer synchronously, and prints the same rows for `/boss asks`.

function rig(answer: () => Record<string, unknown> | undefined, lang: "en" | "zh-TW" = "en") {
	const events = new EventEmitter(), asked: Record<string, unknown>[] = [];
	const pi = { on: () => {}, events: { emit: (c: string, d: unknown) => void events.emit(c, d), on: (c: string, h: (d: unknown) => void) => (events.on(c, h), () => void events.off(c, h)) } };
	const tasks = [{ id: 12, subject: "Ship the docs", status: "in_progress" }];
	const rows = registerAskRows({ pi: pi as never, me: () => "main-1", enabled: () => true, call: async (r) => (asked.push(r), answer() as never), branch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 13 } } }], lang: () => lang, now: () => 600_000, every: 0 });
	const probe = () => { const p: { rows?: { version: number; rows: AskRowV1[] } } = {}; events.emit(ASK_ROWS_EVENT, p); return p.rows; };
	return { rows, probe, asked };
}
const ROWS: AskRowV1[] = [
	{ id: "Q3", subject: "Deploy MP-1 now?", asker: "docs-main", where: "Alpha › docs", kind: "boss", since: 300_000, mine: true, item: { session: "main-1", id: 12 } },
	{ id: "Q4", subject: "Approve the key", asker: "box-2", where: "box-2", kind: "link", since: 540_000, mine: false },
	{ id: "Q5", subject: "", asker: "x", where: "", kind: "wait", since: Number.NaN, mine: false } as AskRowV1,
];

test("the probe answers synchronously with the last rows: version 1, a malformed row left out, `{ version: 1, rows: [] }` before any answer", async () => {
	const r = rig(() => ({ ok: true, rows: ROWS }));
	assert.deepEqual(r.probe(), { version: 1, rows: [] });
	await r.rows.refresh();
	assert.deepEqual(r.asked, [{ cmd: "asks-rows", session: "main-1" }]);
	assert.deepEqual(r.probe()?.rows.map((x) => x.id), ["Q3", "Q4"]);
	assert.deepEqual(r.probe()?.rows[0]?.item, { session: "main-1", id: 12 });
});

test("/boss asks prints this session's first, with the time and the todo each blocks; none, and no server, say so", async () => {
	const r = rig(() => ({ ok: true, rows: ROWS }));
	assert.equal(await r.rows.text(), ["Questions waiting on you (2):", "From this session and its subagents:", "  Q3 · 5m · docs-main · Alpha › docs · Deploy MP-1 now?  — blocks #12 Ship the docs", "Elsewhere on this computer:", "  Q4 · 1m · box-2 · Approve the key"].join("\n"));
	assert.equal(await rig(() => ({ ok: true, rows: [] }), "zh-TW").rows.text(), "沒有在等你回答的問題。");
	assert.match(await rig(() => undefined).rows.text(), /^The sb server did not answer/);
});
