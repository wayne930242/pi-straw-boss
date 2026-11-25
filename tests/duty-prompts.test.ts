import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { strip } from "../src/trainswitch.ts";
import { PROMPT_DIR } from "./fakes.ts";

// D7 (docs/specs/2026-11-09-agent-kinds.md §9): the kind prompts say only what differs from their base. Since 0.83.0 (docs/specs/2026-11-23-lite-main.md §1) the dispatch rules are main.md's own, for every kind,
// and no graph has a prompt: dispatch.md and the two graph addenda are gone.

const read = (name: string) => readFileSync(`${PROMPT_DIR}/${name}.md`, "utf8");
const lines = (text: string) => text.trim().split("\n").length;
const sentences = (text: string) => text.replace(/\{\{\w+\}\}/g, "X").split(/(?<=[.!?:;])\s+|\n+/).map((x) => x.replace(/^[-#\s]+/, "").replace(/\s+/g, " ").trim().toLowerCase()).filter((x) => x.length > 24);
const duplicates = (text: string) => { const seen = new Set<string>(), dup: string[] = []; for (const x of sentences(text)) (seen.has(x) ? dup.push(x) : seen.add(x)); return dup; };
// What a main runs, as briefing.ts composes it: main.md, then the kind addendum.
const compose = (duty: "coordinator" | "integrator" | "standing", off: boolean) => strip(["main", ...(duty === "integrator" ? ["integrator"] : duty === "standing" ? ["duty-standing"] : [])].map(read).join("\n\n"), off);

test("no composed prompt (kind x integration) holds a sentence twice, and main.md and the kind addendum repeat nothing of planning.md", () => {
	const plan = new Set(sentences(read("planning")));
	for (const duty of ["coordinator", "integrator", "standing"] as const) for (const off of [false, true]) assert.deepEqual(duplicates(compose(duty, off)), [], `${duty} off=${off}`);
	for (const name of ["main", "duty-standing"]) assert.deepEqual(sentences(read(name)).filter((x) => plan.has(x)), [], `${name} repeats planning.md`);
});

test("no graph prompt and no dispatch prompt ship", () => {
	for (const name of ["dispatch", "graph-fan-out", "graph-orchestrator-worker"]) assert.ok(!existsSync(`${PROMPT_DIR}/${name}.md`), name);
});

// 2026-11-21 (D14, the boss's delegate, docs/specs/2026-11-21-box-mac-waits.md §15; measured): duty-standing.md 900 to 974 characters: an approval comes to the standing main, which may approve anything and escalates only what the boss should decide.
// 2026-11-24 (capacity, docs/specs/2026-11-24-capacity.md, Prompts, and review prompts-review F003; measured): duty-standing.md 6 to 7 lines and 974 to 1492 characters: capacity notices are the standing main's incidents (`under`, `stale`, `quota`, `device-silent`, and sb's `device-silent-2h` for the boss).
// 2026-11-24 (capacity routing; field, MP Center box 2; measured): 1492 to 1624 characters: a main still under at the standing main's next notice (`under-30m` too) is asked, then escalated with `call_tower`; no timer of its own.
test("size caps: a kind addendum is at most 7 lines and 1624 characters; integrator.md is pinned", () => {
	const standing = read("duty-standing");
	assert.ok(lines(standing) <= 7 && standing.length <= 1624, `duty-standing: ${lines(standing)} lines, ${standing.length} characters`);
	assert.equal(lines(read("integrator")), 13);
});

// 27f86373 held main.md + planning.md in 9,676 characters, and 0.82.1 main.md + dispatch.md + planning.md in 9,673. 2026-11-23 (docs/specs/2026-11-23-lite-main.md §1, measured): dispatch.md folded into
// main.md as two lines, with the cap of 4 workers and the todo before a worker: main.md 28 to 29 lines.
// 2026-11-24 (capacity, docs/specs/2026-11-24-capacity.md, Prompts; measured): 9,687 to 10,095 characters (+408): main.md dispatches up to the device's capacity budget, an idle main takes its next work, a capacity notice is its own; planning.md runs parallel up to the budget and weighs a todo by `metadata.points`.
// 2026-11-24 (capacity routing; field, MP Center box 2; measured): 10,095 to 10,177 (+82): a capacity notice on a main's work: dispatch now, or say why to whoever asked; sb's on its board.
// 2026-11-25 (idle wrap-up + the main asks the boss itself, docs/specs/2026-11-25-idle-wrap-up.md; measured): 10,177 to 10,538 (+361): the done rule ends in a memory entry and `boss_wrap`; a boss-only decision is asked with `ask_user_question`.
// 2026-11-26 (0.91.0, prompts delivered when needed; boss 2026-11-25 「提示詞可以逐步交付」; measured): 10,538 to 10,167 (-371): the wrap-up steps live in the idle nudge and boss_wrap, the boss question in call_tower's `boss` field; main.md's two lines are 0.89.0's again.
test("no growth from the fold: main.md + planning.md stays within 10,167 characters, and main.md has at most 29 lines", () => {
	const sum = read("main").length + read("planning").length;
	assert.ok(sum <= 10167, `the two files hold ${sum} characters`); // D (0.84.0, §2.5; measured): +154 for the reviewed change's one sentence in main.md
	assert.ok(lines(read("main")) <= 29, `main.md has ${lines(read("main"))} lines`);
});

test("{{duty}} renders the kind in the first line", () => {
	assert.match(read("main").split("\n")[0]!, /of kind \{\{duty\}\}/);
});
