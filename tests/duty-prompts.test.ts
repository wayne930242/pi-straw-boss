import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strip } from "../src/trainswitch.ts";
import { PROMPT_DIR } from "./fakes.ts";

// D7 (docs/specs/2026-11-09-agent-kinds.md §9): the kind prompts say only what differs from their base, and the move of the dispatch rules out of main.md makes no prompt longer in sum.

const read = (name: string) => readFileSync(`${PROMPT_DIR}/${name}.md`, "utf8");
const lines = (text: string) => text.trim().split("\n").length;
const sentences = (text: string) => text.replace(/\{\{\w+\}\}/g, "X").split(/(?<=[.!?:;])\s+|\n+/).map((x) => x.replace(/^[-#\s]+/, "").replace(/\s+/g, " ").trim().toLowerCase()).filter((x) => x.length > 24);
const duplicates = (text: string) => { const seen = new Set<string>(), dup: string[] = []; for (const x of sentences(text)) (seen.has(x) ? dup.push(x) : seen.add(x)); return dup; };
const GRAPH = { "fan-out/fan-in": "graph-fan-out", "orchestrator-worker": "graph-orchestrator-worker" } as const;
// What a main runs, as briefing.ts composes it (on): main.md, the kind addendum, then dispatch.md and a coordinator's graph addendum.
const compose = (duty: "coordinator" | "integrator" | "standing", graph?: keyof typeof GRAPH | "single-loop") => {
	const parts = ["main", ...(duty === "integrator" ? ["integrator"] : duty === "standing" ? ["duty-standing"] : []), ...(duty !== "coordinator" || graph ? ["dispatch"] : []), ...(duty === "coordinator" && graph && graph !== "single-loop" ? [GRAPH[graph]] : [])];
	return strip(parts.map(read).join("\n\n"), false);
};

test("no composed prompt (kind x graph) holds a sentence twice, and the addenda repeat nothing of planning.md", () => {
	const plan = new Set(sentences(read("planning")));
	for (const duty of ["coordinator", "integrator", "standing"] as const)
		for (const graph of [undefined, "single-loop", "fan-out/fan-in", "orchestrator-worker"] as const) assert.deepEqual(duplicates(compose(duty, graph)), [], `${duty} ${graph}`);
	for (const name of ["dispatch", "duty-standing", "graph-fan-out", "graph-orchestrator-worker"]) assert.deepEqual(sentences(read(name)).filter((x) => plan.has(x)), [], `${name} repeats planning.md`);
});

test("size caps: a kind addendum is at most 6 lines and 900 characters, a graph addendum 2 lines and 300; integrator.md and dispatch.md are pinned", () => {
	const standing = read("duty-standing");
	assert.ok(lines(standing) <= 6 && standing.length <= 900, `duty-standing: ${lines(standing)} lines, ${standing.length} characters`);
	for (const name of ["graph-fan-out", "graph-orchestrator-worker"]) assert.ok(lines(read(name)) <= 2 && read(name).length <= 300, name);
	assert.equal(lines(read("integrator")), 13);
	assert.equal(lines(read("dispatch")), 3);
});

test("no growth from the move: main.md + dispatch.md + planning.md is shorter than main.md + planning.md at 27f86373 (9,676 characters), and main.md has at most 28 lines", () => {
	const sum = read("main").length + read("dispatch").length + read("planning").length;
	assert.ok(sum < 9676, `the three files hold ${sum} characters`);
	assert.ok(lines(read("main")) <= 28);
});

test("{{duty}} renders the kind in the first line", () => {
	assert.match(read("main").split("\n")[0]!, /of kind \{\{duty\}\}/);
});
