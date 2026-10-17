import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PROMPT_DIR } from "./fakes.ts";

const BUDGETS: Record<string, number> = { "main.md": 150, "tower.md": 150, "member.md": 50, "reminder.md": 70 };
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
