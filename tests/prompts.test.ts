import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PROMPT_DIR } from "./fakes.ts";

// tower.md was 150 words; the rule for opening a main for unowned work (boss_open_main: no asking the boss, what to pass, once, report a failure) took it to 180.
// main.md was 150 words; renaming itself with boss_rename when its work turns to another task took it to 170.
// 0.22.0 to 185 for planning by planning.md before the first dispatch, with the boss's confirmation; 0.31.0 kept 185 when the confirmation gave way to asking only for decisions.
const BUDGETS: Record<string, number> = { "main.md": 185, "tower.md": 180, "member.md": 80, "member-no-main.md": 80 };
const PLACEHOLDERS = new Set(["tab", "workspace", "main", "tower", "head", "dir"]);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test("every role prompt stays within its word budget", () => {
	for (const [file, budget] of Object.entries(BUDGETS)) {
		const count = words(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"));
		assert.ok(count > 10 && count <= budget, `${file} has ${count} words (budget ${budget})`);
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
