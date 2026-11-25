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
// What a main runs, as briefing.ts composes it: main.md, then the kind addendum; a standing main runs standing.md alone (docs/specs/2026-11-26-standing-prompt.md).
const compose = (duty: "coordinator" | "integrator" | "standing", off: boolean) => strip((duty === "standing" ? ["standing"] : ["main", ...(duty === "integrator" ? ["integrator"] : [])]).map(read).join("\n\n"), off);

test("no composed prompt (kind x integration) holds a sentence twice, and main.md and the kind addendum repeat nothing of planning.md", () => {
	const plan = new Set(sentences(read("planning")));
	for (const duty of ["coordinator", "integrator", "standing"] as const) for (const off of [false, true]) assert.deepEqual(duplicates(compose(duty, off)), [], `${duty} off=${off}`);
	for (const name of ["main", "standing"]) assert.deepEqual(sentences(read(name)).filter((x) => plan.has(x)), [], `${name} repeats planning.md`);
});

test("no graph prompt and no dispatch prompt ship", () => {
	for (const name of ["dispatch", "graph-fan-out", "graph-orchestrator-worker", "duty-standing"]) assert.ok(!existsSync(`${PROMPT_DIR}/${name}.md`), name);
});

// duty-standing.md (2026-11-21 to 2026-11-24: 900 to 1,624 characters, 7 lines) was an addendum to main.md that began by setting main.md's done rule aside. 2026-11-26 (docs/specs/2026-11-26-standing-prompt.md; boss 2026-11-26
// 「無人塔台值守的 prompt 不該是 main 的，應該要量身訂做」; measured): standing.md replaces main.md + duty-standing.md (6,092 characters) for a standing main: 2,169 characters and 12 lines, the same with integration on and off.
// 2,296 characters and 12 lines after the same spec's items 8 and 9 (measured): a note on a wait goes in its thread, and only a main whose Herdr pane is idle is woken or asked.
test("size caps: standing.md renders within 2,500 characters and 12 lines, integration on and off; integrator.md is pinned", () => {
	for (const off of [false, true]) {
		const standing = compose("standing", off).replace(/\{\{tab\}\}/g, "Ops 7");
		assert.ok(lines(standing) <= 12 && standing.length <= 2500, `standing off=${off}: ${lines(standing)} lines, ${standing.length} characters`);
	}
	assert.equal(lines(read("integrator")), 13);
});

test("standing.md carries what every standing turn needs and none of main.md's dispatch, done, car, or pairing rules", () => {
	const standing = read("standing");
	for (const term of ["only the boss closes you", "Your board line names what you mind", "`boss_rename`", "`boss_watch`", "`MonitorCreate`", "never `ask_user_question`", "`call_tower` `why: blocked`", "`linkWait`", "`declined`", "`escalated`", "names no owner here: forward it to the main that owns the work", "a note on a wait goes in its thread (`linkWait` `note`), else name the owner", "`under-30m`", "wake or ask only a main whose Herdr pane is idle", "`stale`", "`quota`", "`resumed`", "`device-silent-2h`", "for a new main", "`boss_handover`"]) assert.ok(standing.includes(term), term);
	for (const term of ["Done when", "do not apply", "apps-config.md", "planning.md", "worktree", "car slip", "boss_pair", "caller_ping", "three points only", "Seam bindings", "Idle with ready todos", "re-arm", "Re-arm"]) assert.ok(!standing.includes(term), `standing.md says nothing of ${term}`);
	assert.ok(!/<!-- (?:\/)?integration -->/.test(standing), "no integration block: a standing main sends no car");
});

// 27f86373 held main.md + planning.md in 9,676 characters, and 0.82.1 main.md + dispatch.md + planning.md in 9,673. 2026-11-23 (docs/specs/2026-11-23-lite-main.md §1, measured): dispatch.md folded into
// main.md as two lines, with the cap of 4 workers and the todo before a worker: main.md 28 to 29 lines.
// 2026-11-24 (capacity, docs/specs/2026-11-24-capacity.md, Prompts; measured): 9,687 to 10,095 characters (+408): main.md dispatches up to the device's capacity budget, an idle main takes its next work, a capacity notice is its own; planning.md runs parallel up to the budget and weighs a todo by `metadata.points`.
// 2026-11-24 (capacity routing; field, MP Center box 2; measured): 10,095 to 10,177 (+82): a capacity notice on a main's work: dispatch now, or say why to whoever asked; sb's on its board.
// 2026-11-25 (idle wrap-up + the main asks the boss itself, docs/specs/2026-11-25-idle-wrap-up.md; measured): 10,177 to 10,538 (+361): the done rule ends in a memory entry and `boss_wrap`; a boss-only decision is asked with `ask_user_question`.
// 2026-11-26 (0.91.0, prompts delivered when needed; boss 2026-11-25 「提示詞可以逐步交付」; measured): 10,538 to 10,167 (-371): the wrap-up steps live in the idle nudge and boss_wrap, the boss question in call_tower's `boss` field; main.md's two lines are 0.89.0's again.
// 2026-11-26 (0.92.0, just-in-time prompts, docs/specs/2026-11-26-just-in-time-prompts.md; boss 2026-11-25 「提示詞可以逐步交付」; measured): 10,167 to 8,521 (-1,646) and main.md 29 to 27 lines: the rules of one moment
// went to the notice, message, tool description, or result of that moment.
// Its review RV-F001 (measured): 8,521 to 8,559 (+38) for "Idle with ready todos: dispatch them.".
test("no growth from the fold: main.md + planning.md stays within 8,559 characters, and main.md has at most 27 lines", () => {
	const sum = read("main").length + read("planning").length;
	assert.ok(sum <= 8559, `the two files hold ${sum} characters`); // D (0.84.0, §2.5; measured): +154 for the reviewed change's one sentence in main.md
	assert.ok(lines(read("main")) <= 27, `main.md has ${lines(read("main"))} lines`);
});

test("{{duty}} renders the kind in the first line", () => {
	assert.match(read("main").split("\n")[0]!, /of kind \{\{duty\}\}/);
});
