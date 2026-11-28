import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createWorked, workedOf } from "../src/server/worked.ts";

// The main's own last move (src/server/worked.ts, docs/specs/2026-11-28-stale-snooze.md, review r2-F003): the newest entry of its session file that is not the server's stale notice or the main's
// text-only answer to it.

const SERVER = "sb-server-1", T = Date.parse("2026-11-28T10:00:00Z");
const at = (s: number) => new Date(T + s * 1000).toISOString();
const notice = (s: number, from = SERVER, body = "capacity stale · main \"api\" · 1 open todo unanswered") => ({ type: "custom_message", customType: "intercom_message", timestamp: at(s), content: "x", details: { from: { id: from }, bodyText: `[straw net from="straw boss" id=${from} role=session kind=capacity_notice scope=session to=api reply=none] ${body}` } });
const said = (s: number, text = "Still waiting on CI.") => ({ type: "message", timestamp: at(s), message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (s: number) => ({ type: "message", timestamp: at(s), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } });
const user = (s: number, text: string) => ({ type: "message", timestamp: at(s), message: { role: "user", content: text } });
const lines = (...e: unknown[]) => e.map((x) => JSON.stringify(x));

test("workedOf: the notice and a text-only answer are no move; a tool call in its turn, or any later input, is", () => {
	assert.equal(workedOf(lines(said(0), notice(60), user(61, "New intercom message above."), said(70), { type: "custom", customType: "todo/v1", timestamp: at(71) }), SERVER), T, "taking the notice moved nothing");
	assert.equal(workedOf(lines(said(0), notice(60), said(70), tool(80), said(90)), SERVER), T + 90_000, "it went to work in that turn");
	assert.equal(workedOf(lines(said(0), notice(60), said(70), user(120, "deploy it"), said(130)), SERVER), T + 130_000, "the boss asked for work after it");
	assert.equal(workedOf(lines(said(0), notice(60, "someone-else"), said(70)), SERVER), T + 70_000, "a message of another sender is no notice of the server");
	assert.equal(workedOf(lines(said(0), notice(60, SERVER, "capacity under · main \"api\""), said(70)), SERVER), T + 70_000, "another flag is no stale notice");
	assert.equal(workedOf(["{ broken", ...lines(said(0))], SERVER), T);
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("createWorked reads the file's tail once per write", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-worked-")), file = join(dir, "s.jsonl");
	dirs.push(dir);
	writeFileSync(file, `${lines(said(0), notice(60), said(70)).join("\n")}\n`);
	utimesSync(file, new Date(T + 70_000), new Date(T + 70_000));
	const worked = createWorked(SERVER);
	assert.equal(worked(file, T + 70_000), T);
	writeFileSync(file, `${lines(said(0), notice(60), said(70), tool(80)).join("\n")}\n`);
	assert.equal(worked(file, T + 70_000), T + 80_000, "a new write of another size is read again, even at the same time (snooze-r3 performance)");
	assert.equal(worked(file, T + 80_000), T + 80_000, "a new time is read again");
	assert.equal(worked(join(dir, "none.jsonl"), T), undefined, "no file: none, and the caller keeps its file time");
});
