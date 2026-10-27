import assert from "node:assert/strict";
import { test } from "node:test";
import { ageOf, BRIEF_MAX, type BriefInput, buildBrief, LOCAL_TOOLS } from "../src/server/towerbrief.ts";

// The brief of a local run (docs/specs/2026-10-26-sb-backend.md, The brief): plain text with a hard cap, a cap per section, and a note on what a cut section left out.

const base = (): BriefInput => ({
	label: "Alpha", workspace: "wA", head: "Alpha", woken: "09:41", counts: { intercom: 2, boss: 1 }, identity: "sb-tower-wa", mains: [], obligations: [], digest: [], flags: [], tools: LOCAL_TOOLS,
});

test("the sections come in the spec's order: who, mains, obligations, digest, note, tools, flags", () => {
	const text = buildBrief({
		...base(), mains: [{ tab: "work", main: { name: "docs-main", id: "abcdef123456", state: "working", openedBy: "tower · Alpha", now: "writing the spec", open: 2 }, members: 3 }, { tab: "idle", members: 0 }],
		obligations: ["main docs-main was opened for x"], digest: ["09:00 a joined tab work"], note: { text: "- left the thing half done", age: "2h 5m" }, flags: ["1 event was possibly handled by a run that crashed: check before acting."],
	});
	const order = ["You are a run of the tower of workspace Alpha (wA); head tower: Alpha. Woken 09:41 by: 2 intercom, 1 boss.", "Mains you supervise:", "Open obligations:", "Since your last run:", "Handoff note from the last run (2h 5m ago):", "Tools:", "A run ends after 20 minutes."];
	let at = -1;
	for (const part of order) {
		const found = text.indexOf(part);
		assert.ok(found > at, `${part} comes after the one before`);
		at = found;
	}
	assert.match(text, /work: main docs-main \(abcdef12\) working, opened by tower · Alpha; now: writing the spec \(2 open\); 3 members/);
	assert.match(text, /idle: no main/);
	assert.match(text, /Your identity for replies is sb-tower-wa; everything you send leaves under it\./);
	assert.match(text, /Call tower_done with a handoff note when nothing is left for you\./);
});

test("the total is capped at 6,000 characters, with the mains cut to what the rest leaves and the cut counted", () => {
	const mains = Array.from({ length: 60 }, (_, n) => ({ tab: `tab ${n}`, main: { name: `main-with-a-long-name-${n}-${"x".repeat(100)}`, id: `id${n}`.padEnd(12, "0"), state: "working", now: "y".repeat(150), open: 3 }, members: 2 }));
	const text = buildBrief({ ...base(), mains, obligations: Array.from({ length: 30 }, (_, n) => `obligation ${n} ${"z".repeat(300)}`), digest: Array.from({ length: 40 }, (_, n) => `line ${n} ${"d".repeat(200)}`), note: { text: "n".repeat(5000), age: "1m" } });
	assert.ok(text.length <= BRIEF_MAX, `${text.length}`);
	assert.match(text, /\(\+\d+ more\)/);
	assert.match(text, /\(\+20 older lines left out\)/);
	assert.equal(text.match(/^- obligation/gm)!.length <= 10, true);
});

test("a section has its own cap: 20 digest lines of 80 characters, a note of 1,200, 10 obligations of 200, 24 mains of 200", () => {
	const text = buildBrief({ ...base(), digest: Array.from({ length: 25 }, (_, n) => `${n} ${"d".repeat(200)}`), note: { text: "n".repeat(3000), age: "1m" }, obligations: Array.from({ length: 12 }, (_, n) => `${n} ${"o".repeat(400)}`) });
	const digest = text.split("Since your last run:\n")[1]!.split("\n\n")[0]!.split("\n").filter((l) => l.startsWith("- "));
	assert.equal(digest.length, 20);
	assert.ok(digest.every((l) => Array.from(l.slice(2)).length <= 80));
	assert.match(text, /\(\+5 older lines left out\)/);
	assert.ok(text.split("Handoff note from the last run (1m ago):\n")[1]!.split("\n\n")[0]!.length <= 1200);
	const obligations = text.split("Open obligations:\n")[1]!.split("\n\n")[0]!.split("\n");
	assert.equal(obligations.filter((l) => l.startsWith("- ")).length, 10);
	assert.ok(obligations.filter((l) => l.startsWith("- ")).every((l) => Array.from(l.slice(2)).length <= 200));
	assert.ok(obligations.includes("(+2 more)"));
});

test("a tab with no join says so, and ages read as minutes, hours, days", () => {
	assert.match(buildBrief(base()), /- none: no tab of this workspace has joined/);
	assert.deepEqual([0, 59 * 60_000, 3 * 3600_000 + 5 * 60_000, 26 * 3600_000].map(ageOf), ["0m", "59m", "3h 5m", "1d 2h"]);
});
