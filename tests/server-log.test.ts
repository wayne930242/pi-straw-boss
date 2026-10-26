import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createLog, logSize, readFrom, tailLog } from "../src/server/log.ts";

// docs/specs/2026-10-26-sb-backend.md, Seeing and restarting the server: server.log, rotated at 5 MB with three kept, events and facts only, no message text or secrets.

let root = "", file = "";
beforeEach(() => void (file = join((root = mkdtempSync(join(tmpdir(), "psb-server-log-"))), "server.log")));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const T = Date.parse("2026-10-26T08:00:00.000Z");

test("one line per event with its facts, mode 600; a fact with spaces is quoted and newlines never split a line", () => {
	const log = createLog(file, { now: () => T });
	log.line("restart", { reason: "from the GUI", by: "main (id 1)", n: 3, ok: true, none: undefined });
	log.line("error", { text: "line one\nline two\r\n\u2028end" });
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	assert.deepEqual(lines, [
		'2026-10-26T08:00:00.000Z restart reason="from the GUI" by="main (id 1)" n=3 ok=true',
		'2026-10-26T08:00:00.000Z error text="line one line two end"',
	]);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a secret or token the log was told to hide never reaches the file, whatever event carries it", () => {
	const log = createLog(file, { now: () => T });
	log.hide("s3cretvalue1234", "tok-abcdef", undefined);
	log.line("refused", { why: "wrong secret s3cretvalue1234" });
	log.line("url", { path: "/tok-abcdef/events" });
	const text = readFileSync(file, "utf8");
	assert.ok(!text.includes("s3cretvalue1234") && !text.includes("tok-abcdef"));
	assert.match(text, /\[hidden\]/);
});

test("the log rotates at its size and keeps .1 to .3, the oldest dropped", () => {
	const log = createLog(file, { now: () => T, max: 200 });
	for (let i = 0; i < 40; i++) log.line("event", { n: i, pad: "x".repeat(20) });
	assert.ok(existsSync(file) && existsSync(`${file}.1`) && existsSync(`${file}.2`) && existsSync(`${file}.3`));
	assert.ok(!existsSync(`${file}.4`));
	for (const f of [file, `${file}.1`, `${file}.2`, `${file}.3`]) assert.ok(statSync(f).size < 400, f);
	const all = tailLog(file, 1000);
	assert.equal(all.at(-1)?.includes("n=39"), true, "the newest event is last");
	assert.equal(all.some((line) => line.includes("n=0 ")), false, "the oldest were dropped");
	assert.ok(all.every((line, i) => i === 0 || Number(/n=(\d+)/.exec(line)![1]) === Number(/n=(\d+)/.exec(all[i - 1]!)![1]) + 1), "the lines run on across the rotated files");
});

test("tailLog gives the last lines, reaching into the rotated files when the current one is short", () => {
	writeFileSync(file, "a\nb\nc\n");
	writeFileSync(`${file}.1`, "x\ny\nz\n");
	assert.deepEqual(tailLog(file, 2), ["b", "c"]);
	assert.deepEqual(tailLog(file, 4), ["z", "a", "b", "c"]);
	assert.deepEqual(tailLog(file, 200), ["x", "y", "z", "a", "b", "c"]);
	assert.deepEqual(tailLog(join(root, "none.log"), 5), []);
});

test("tailLog of a big file reads from the end and cuts no line in two", () => {
	const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	assert.deepEqual(tailLog(file, 3), lines.slice(-3));
	assert.equal(tailLog(file, 200).length, 200);
	assert.equal(tailLog(file, 200)[0], lines[4800]);
});

test("a follower reads what was appended, and a rotated file from its start", () => {
	const log = createLog(file, { now: () => T, max: 100 });
	log.line("one");
	const first = readFrom(file, 0);
	assert.match(first.text, /one/);
	log.line("two");
	const next = readFrom(file, first.size);
	assert.match(next.text, /two/);
	assert.ok(!next.text.includes("one"));
	for (let i = 0; i < 5; i++) log.line("more", { pad: "y".repeat(30) });
	assert.ok(logSize(file) < next.size + 200);
	assert.match(readFrom(file, 10_000).text, /more/, "a size below the offset means a rotation: read from the start");
	assert.deepEqual(readFrom(join(root, "none.log"), 0), { text: "", size: 0 });
});

test("a log that cannot be written never throws", () => {
	const log = createLog(join(root, "no", "such", "dir", "server.log"), { now: () => T });
	assert.doesNotThrow(() => log.line("event"));
});
