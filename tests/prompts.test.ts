import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PROMPT_DIR } from "./fakes.ts";

// tower.md was 150 words; the rule for opening a main for unowned work (boss_open_main: no asking the boss, what to pass, once, report a failure) took it to 180.
// main.md was 150 words; renaming itself with boss_rename when its work turns to another task took it to 170.
// 0.22.0 to 185 for planning by planning.md before the first dispatch, with the boss's confirmation; 0.31.0 kept 185 when the confirmation gave way to asking only for decisions.
// 0.32.0 added the terse caveman-style rule for text agents read to every role prompt: main 210, tower 205, member 95, member-no-main 105.
// 0.32.1 added that a brief keeps its goal, context, reasons, scope, what others own, and acceptance check, and that an unsure reader restates or asks: +45 each.
// 0.40.0 (tower comms): tower 250 to 330 for tower_list and tower_send, the header every message opens with and what to do with its recipients, reporting back once, and closing the mains it opened;
// main 255 to 290 for reporting to the tower that opened it and waiting to be closed.
// Work board: main 285 to 335 for board_set (when to write, what stays out, it is no report); tower 328 to 360 for board_read and treating remote entries as a peer's report.
// Board auto-fill: main 335 to 350 (the board fills itself from the todo list and the name; board_set overrides it, `auto: true` hands it back).
// Tower comms: tower 360 to 380 for never forwarding a main's board items or todo text to an ally (T2 review F009).
const BUDGETS: Record<string, number> = { "main.md": 350, "tower.md": 380, "member.md": 140, "member-no-main.md": 150 };
const PLACEHOLDERS = new Set(["tab", "workspace", "main", "tower", "head", "dir"]);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test("every role prompt stays within its word budget", () => {
	for (const [file, budget] of Object.entries(BUDGETS)) {
		const count = words(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"));
		assert.ok(count > 10 && count <= budget, `${file} has ${count} words (budget ${budget})`);
	}
});

test("every role prompt writes to agents terse but keeps what flips meaning", () => {
	for (const file of Object.keys(BUDGETS)) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of ["caveman-style", "negations", "quoted decisions verbatim", "full sentences", "what others own", "acceptance check", "reasons with their cause", "restates it or asks"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
});

test("prompts use only known placeholders and are plain English", () => {
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(PLACEHOLDERS.has(name!), `${file} uses {{${name}}}`);
		assert.doesNotMatch(text, /[^\x00-\x7F]/, `${file} has non-ASCII characters`);
	}
});

test("the worker and apps-config prompts moved: apps-config ships unchanged and there is no worker prompt", () => {
	assert.ok(readdirSync(PROMPT_DIR).includes("apps-config.md"));
	assert.ok(!readdirSync(PROMPT_DIR).includes("worker.md"));
	assert.match(readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8"), /^# Apps configuration/);
});

// The main reads planning.md before its first dispatch, as it reads apps-config.md when it splits work: a reference file, not system prompt.
// The boss confirms decisions, not the plan (2026-10-21): an unclear or architecture-contradicting requirement, and merge or deploy authorizations.
test("the main plans from planning.md: graph, todos with owners and blockedBy, shared anchors, and no confirmation of the plan", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	assert.match(main, /\{\{dir\}\}\/planning\.md/);
	assert.doesNotMatch(main, /confirmation/);
	const plan = readFileSync(`${PROMPT_DIR}/planning.md`, "utf8");
	assert.match(plan, /^# Planning work/);
	for (const term of ["single-loop", "fan-out", "orchestrator-worker", "`owner`", "`blockedBy`", "share one checkpoint", "without asking the boss to confirm the plan", "contradicts the architecture"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	assert.doesNotMatch(plan, /Start only on their confirmation/);
	assert.ok(words(plan) <= 650, `planning.md has ${words(plan)} words (budget 650)`);
});
