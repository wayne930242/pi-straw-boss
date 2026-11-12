import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { type CarState, validateStateFields } from "../src/train/cars.ts";
import { acceptanceWord, KINDS } from "../src/train/spec.ts";
import { strip } from "../src/trainswitch.ts";
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
// Merge of call timing (D19) and board auto-fill: main 458 (three call_tower points beside the board line), tower 380.
// Board clearing: main 458 to 484 (clear the board before stopping when work ends or is shelved; `board_set { clear: true }`; Done-when includes it).
// 2026-11-02 (a main edited prompts itself and stalled its chain): main dispatches work independent of its chain; +14 words, 13 cut from the board and rename lines (the tool states the 16-character limit), main stays 483 of 484.
// 2026-11-04 (hand-made worktrees scattered under ~/.local/share and hung children on the trust prompt): main names the worktree root; 484 to 500.
// 2026-11-05 (merge-train switch, src/trainswitch.ts): the budgets count the text a session gets, markers dropped, with the switch on and with it off. On, main gains the ledger folder ({{state}}/trains): 497 to 500; off it is 481.
// 2026-11-06 (seam bindings, docs/specs/2026-11-06-seam-bindings.md): with the train on, main.md carries the `## Seam bindings` block for pi-anchorloop's `integrating` and `deploying` skills, 500 to 680 (off it stays 481);
// tower.md 380 to 390 for "the integrator answers the coordinator itself" (off it stays 371). A role that has its own on-budget is listed in ON_BUDGETS.
// 2026-11-07 (wait cards, docs/specs/2026-11-07-wait-cards.md, Prompts; shortened in the GUI review, GR-F012): tower.md +31 for "the boss is not an agent: write a wait for them in plain full sentences" (off 371 to 402, on 393 to 424); main.md +20 for the `wait_card` message and `secret_drop` (off 481 to 501, on 695 to 715). Budgets = measured.
const BUDGETS: Record<string, number> = { "main.md": 501, "tower.md": 402, "member.md": 140, "member-no-main.md": 150 };
// Its review fixes (SB-F001, F003, F005: the Approval line quotes words already given and asks only when they are missing, the tower reports nothing back on a forwarded slip): main.md 680 to 700, tower.md 390 to 395, integrator.md 320 to 340 (SB-F002 and F006: the deploy gate before `Merge`, a subagent briefed for one step).
// Train workers (docs/specs/2026-11-07-train-workers.md §13.1, task 8): tower.md on 424 to 471 (forward with `forward`, open a train with `role: "train"`, a car notice's `blocked`; off stays 402); main.md on 715 to 720 (Batch owner, Handoff route, Record and Approval say who schedules, who departs, who notifies, and where the boss's nod is quoted); integrator.md 340 to 380 and train.md ~450 have their own budgets below.
// Fix round of task 8 (prompts-review.md, TP-F001 to F018): budgets = measured: main.md on 720 to 725, tower.md on 471 to 469 (the resident tower forwards nothing), planning.md on 670 to 681 (the check command), integrator.md 380 to 412 (todo lifecycle, legacy trains), train.md 450 to 511 (holds, load and lock, the Record file, the metadata.sb keys).
// Fix round 2 (prompts-rereview.md TP2-F001 to F004): measured: main.md on 725 to 743 ({{cli}} check line), planning.md on 681 to 693, integrator.md 412 to 453 (todo fields and result, --accept none), train.md 511 to 520 (status, trainboard folder).
// Whole-batch fix round (batch-review.md TB-F001 to F009): measured: planning.md on 693 to 699 (absolute evidence paths), integrator.md 453 to 509 (sb reads apps.json and refuses, the todo goes in_progress before the call, the code's form, a car with no forward), train.md 520 to 542 (the version refusal, evidence short of the app's requirement, `round` of dropped).
const ON_BUDGETS: Record<string, number> = { "main.md": 743, "tower.md": 469 };
// 2026-11-08 (todo #125 task 5, TP-F004): `{{cli}}` is the command that runs cli.mjs.
const PLACEHOLDERS = new Set(["tab", "workspace", "main", "tower", "head", "dir", "state", "cli", "duty"]);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test("every role prompt stays within its word budget", () => {
	for (const [file, budget] of Object.entries(BUDGETS)) {
		for (const off of [false, true]) {
			const count = words(strip(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"), off)), limit = off ? budget : (ON_BUDGETS[file] ?? budget);
			assert.ok(count > 10 && count <= limit, `${file} has ${count} words with integration ${off ? "off" : "on"} (budget ${limit})`);
		}
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
	// 2026-11-02 audit (a coordinator offered the boss a page-local design that the app's rules forbade, and a single-loop task opened no anchor loop): +45 words, 20 cut, budget 650 to 670.
	for (const term of ["Its plan is one todo whose `metadata.anchor` names its check", "read the owning app's instructions", "quote the rule that settles the design in the brief"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	for (const off of [false, true]) assert.ok(words(strip(plan, off)) <= (off ? 670 : 699), `planning.md has ${words(strip(plan, off))} words with integration ${off ? "off" : "on"} (budget ${off ? 670 : 699})`);
});

// D18 and D19 (docs/specs/2026-10-26-sb-backend.md, Decisions): coordination goes through the tower, and a main calls it at three points only. main.md goes from 332 to about 425 words for that rule; the "who owns it" clause of `blocked` takes it to about 445.
// 2026-11-02 audit: a worker that read "ask first" in its app's rules built the thing anyway; the brief's closing line now sends that case to caller_ping. The boss_status/boss_broadcast line went (the tools describe themselves) to keep main.md within 484.
test("the main's brief closing line covers a rule that says to ask first", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	assert.ok(main.includes("or a rule you follow says to ask first, call `caller_ping` and stop"));
});

test("D19: the main calls the tower at three points only, routine progress stays on the board, and a milestone goes without a reply", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["`call_tower`", "three points only", "`milestone`", "`shared`", "`blocked`", "reply: false", "never call the tower to report", "10 minutes"]) assert.ok(main.includes(term), `main.md names ${term}`);
	assert.doesNotMatch(main, /call_tower reaches the tower \(report coordination friction there\)/);
	for (const file of ["member.md", "member-no-main.md"]) assert.match(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"), /`call_tower` and `why: blocked`/, `${file} reports friction as blocked`);
});

test("D19: the tower run reads why= from the header: milestone updates obligations, shared is answered go or wait with the owner named, blocked is routed, and nobody is asked for progress", () => {
	const run = readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8");
	for (const term of ["`why=`", "`milestone`", "`shared`", "`blocked`", "go or wait", "owner", "Never ask mains for progress", "board_read"]) assert.ok(run.includes(term), `tower-run.md names ${term}`);
});

// Merge train, phase 1 (docs/specs/2026-10-30-merge-train.md): prompt-only. Budgets are unchanged; the new text displaced other words.
test("merge train: apps-config names the integration fields and points to the skill contract; the integrator follows the anchorloop skills and keeps only what is Straw Boss's", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`integration`", "`maxCars`", "`maxWaitMin`", "`base`", "`integrating`'s Project skill contract", "## Light checks", "## Load", "`why=blocked`"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	assert.match(integrator, /^# Integrator/);
	for (const term of ["`integrating` skill", "`deploying` skill", "Seam bindings in your role prompt", "naming pi-anchorloop", "`why=blocked`", "`why=milestone`", "{{dir}}/apps-config.md", "`<project>/<app>.json` in the `trains` folder your role prompt names", "integ <project>", "never rename again", "`coordinator` is a session id", "`reviewer` role"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(!integrator.includes("<state dir>") && !integrator.includes("reserve") && !integrator.includes("~/.pi"), "integrator.md has no placeholder, undefined path, hard-coded agent folder, or reserve");
	assert.match(readFileSync(`${PROMPT_DIR}/main.md`, "utf8"), /Record: `\{\{state\}\}\/trains\/<project>\/<app>\.json`/, "the role prompt names the ledger file");
	// The procedure (slip block, checks, departure, assembly, review, red handling, urgent lane, deploy, UAT) moved to pi-anchorloop's `integrating` and `deploying` skills (docs/specs/2026-11-06-seam-bindings.md maps every old line):
	// integrator.md went from 1200 to 289 words, and a rule that is back here is duplication.
	for (const gone of ["tested-on", "`train/<code>`", "nothing is force pushed", "`maxCars`", "fix-forward", "One train at a time per target", "a blank box means accepted", "(applied to a DB: no|<which>)"]) assert.ok(!integrator.includes(gone), `integrator.md no longer repeats ${gone}`);
	// 0.75.3 raised 510 to 530 (measured): the rule that a forward with `origin=remote:` covers only `strict` targets its device's boss granted, else blocked (R151-F006, boss 2026-11-12).
	assert.ok(words(integrator) <= 530, `integrator.md has ${words(integrator)} words`);
});

// Train stages (docs/specs/2026-11-05-train-stages.md, boss form 2026-11-05): one integrator carries a train through merge, deploy, and UAT; Straw Boss names the flow, never an environment.
test("train stages: apps-config declares stages and targets, the integrator verifies and announces through the bound seams, and the docs name the stage headings", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`stages`", "`merge` (the default, always first)", "`integration.maxTrains`", "`targets` maps a deploy target to `auto`", "only the boss sets it"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	for (const term of ["merge-triggered deploys need no `shared` call", "calls `shared` naming the target"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8").includes("a deploy it starts names its target"));
	for (const file of ["integrator.md", "apps-config.md", "planning.md", "main.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		assert.ok(!/\b(staging|production|prod)\b/i.test(text), `${file} names no environment`);
	}
	// The docs state the same contract and drift silently otherwise (review RV-F009).
	const docs = readFileSync(new URL("../docs/how-it-works.md", import.meta.url), "utf8");
	const spec = readFileSync(new URL("../docs/specs/2026-11-05-train-stages.md", import.meta.url), "utf8");
	for (const term of ["## Deploy", "## Deploy verify", "## Acceptance", "`integration.stages`", "`auto` target", "Seam bindings"]) assert.ok(docs.includes(term), `how-it-works.md names ${term}`);
	for (const term of ["deploy: <targets or none> | uat: <checkpoints path or none>", "## Deploy", "## Deploy verify", "## UAT", "`auto` or `strict`"]) assert.ok(spec.includes(term), `the spec names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/planning.md`, "utf8").includes("a `human` anchor is this acceptance, not the train's"));
});

test("merge train: main hands integration cars over with why shared, planning states the principle, and the tower forwards a shared merge request to the one integrator", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["`integration`", "unless your kind is `integrator`", "never merge to its base or claim a pre-dev branch", "`why: shared`", "waits for sb's car notice", "the done report still goes to whoever asked", "paths outside the project"]) assert.ok(main.includes(term), `main.md names ${term}`);
	const plan = readFileSync(`${PROMPT_DIR}/planning.md`, "utf8");
	for (const term of ["`Light checks`", "once, by the integrator", "`integrating`'s Principle"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	for (const file of ["tower.md", "tower-run.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of file === "tower.md" ? ["`integration`", "integrator", "boss_open_main"] : ["`integration`", "integrator", "boss_open_main", "integrator.md"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
	for (const off of [false, true]) assert.ok(words(strip(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8"), off)) <= (off ? 402 : 469)); // wait cards: +31, see BUDGETS
	assert.ok(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8").includes("finding with evidence"));
});

test("merge train: the integrator needs no shared call for its own merges, and the tower answers its shared request instead of forwarding it back", () => {
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	assert.ok(integrator.includes("your own merges and merge-triggered deploys need no `shared` call"));
	assert.ok(readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8").includes("from the integrator itself, answer go or wait"));
	assert.ok(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8").includes("the integrator's own: go/wait"));
});

// 2026-11-02: a main carried a side task itself under the single-loop rule "carry bounded work in the session" and stalled its own chain.
test("the main dispatches work independent of its chain to a subagent in parallel", () => {
	// Dispatch rules follow the plan (docs/specs/2026-11-09-agent-kinds.md §2a): the line moved from main.md to the two graph addenda.
	for (const file of ["graph-fan-out.md", "graph-orchestrator-worker.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of ["Dispatch work independent of your chain to a subagent in parallel", "binds a single loop, not you"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
});

// docs/specs/2026-11-06-seam-bindings.md: pi-anchorloop's `integrating` and `deploying` leave six seams open (references/seams.md) and read one `## Seam bindings` block from the session's instructions.
// The block lives in main.md, the system prompt of every main (a coordinator and the integrator alike, so a session holds one block), inside the integration markers; the tower runs no skill and holds none.
const SEAMS = ["Handoff route", "Batch owner", "Approval", "Record", "Escalation route", "Settings"];
test("seam bindings: main.md binds all six seams of pi-anchorloop's integrating skill, in one block that only the train-on prompt carries", () => {
	const raw = readFileSync(`${PROMPT_DIR}/main.md`, "utf8"), on = strip(raw, false), off = strip(raw, true);
	assert.equal(raw.match(/^## Seam bindings$/gm)?.length, 1, "main.md holds one Seam bindings heading");
	const block = on.slice(on.indexOf("## Seam bindings")), lines = block.split("\n").filter((line) => line.startsWith("- "));
	assert.deepEqual(lines.map((line) => line.slice(2, line.indexOf(":"))), SEAMS, "one line per seam, in the order of seams.md");
	for (const [seam, mechanism] of [["Handoff route", "`call_tower` `why: shared`"], ["Batch owner", "~/.herdr/worktrees/<repo>/train-<code>"], ["Approval", "the boss"], ["Record", "{{state}}/trains/<project>/<app>.json"], ["Escalation route", "`why=blocked`"], ["Settings", "apps.json `integration`"]]) {
		assert.ok(lines.find((line) => line.startsWith(`- ${seam}:`))?.includes(mechanism!), `${seam} names ${mechanism}`);
	}
	assert.ok(on.includes("`integrating` and `deploying` skills") && on.includes("naming pi-anchorloop"), "main.md names the skills and blocks without them");
	assert.ok(!off.includes("Seam bindings") && !off.includes("pi-anchorloop") && !off.includes("train-<code>"), "with the train off no binding is left");
	// The block is the last text of the integration part: nothing of the always-on text may follow it inside the markers.
	assert.match(raw, /## Seam bindings\n(?:- .*\n){6}<!-- \/integration -->/);
	// Review SB-F001/F003: the coordinator quotes words already given and asks only when they are missing (an overnight train must not stall on a question); the integrator groups cars by the strict targets their auth covers and asks no one (TP-F008).
	const approval = lines.find((line) => line.startsWith("- Approval:"))!;
	assert.ok(approval.includes("lacking them, it asks") && approval.includes("groups cars by the `strict` targets their `auth` covers and asks no one") && !approval.includes("no car names"), "Approval asks only when the words are missing");
	// SB-F002 is fixed upstream (pi-anchorloop 2.10.1, train step 4 gates `Merge` on the deploy steps), which the README requires; SB-F006: a subagent is briefed for one step.
	assert.ok(readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8").includes("never the skill"), "integrator.md keeps the skill from subagents");
	for (const readme of ["README.md", "README.zh-TW.md"]) assert.ok(readFileSync(readme, "utf8").includes("pi-anchorloop) 2.11.0"), `${readme} requires pi-anchorloop 2.11.0 (train workers; 2.10.1 already gated Merge on the deploy steps)`);
	// SB-F004: only the headings `integrating` requires stop a departure.
	assert.ok(readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8").includes("When a required one is missing"), "apps-config.md requires only the required headings");
	for (const file of ["tower.md", "tower-run.md", "planning.md", "integrator.md", "apps-config.md"]) assert.ok(!readFileSync(`${PROMPT_DIR}/${file}`, "utf8").includes("## Seam bindings"), `${file} holds no second block`);
});

// docs/specs/2026-11-07-wait-cards.md, Prompts: a wait for the boss is a card the boss reads, not a terse line an agent reads.
test("wait cards: tower.md says the boss is not an agent, and the card's words are plain, full sentences in the language the brief names", () => {
	const tower = strip(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8"), true);
	for (const term of ["The boss is not an agent: write a wait for them in plain full sentences, in the language your brief names, no shorthand, a ticket id only beside what it is."]) assert.ok(tower.includes(term), `tower.md names ${term}`);
	assert.ok(tower.indexOf("The boss is not an agent:") > tower.indexOf("caveman-style"), "after the terse line");
});

test("wait cards: tower-run.md records a boss wait as a card (fields, language, refusals, the press, legacy, no double notice), with the fonstar example, and the one-line rule is gone", () => {
	const run = readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8");
	assert.ok(!run.includes("write what they have to do in one line they can act on"), "the old one-line rule is replaced");
	for (const term of ["Record a wait for the boss as a card", "`type` (action", "choice when they pick", "secret when a session needs a secret from them", "`happened`", "`do`", "`url` or `command`", "`after`", "`options`", "`secret.name`", "never the value", "`from`", "the `[intercom from ...]` line", "or `self`", "the language the brief's Memory section names (sb's locale)", "who has not followed the work", "A refusal lists what to fix. Fix every line and call again.", "The boss pressed", "chose", "declined", "A declined wait is over: tell the raiser what happens instead", "old free-text wait", "`restates`", "Do not send the raiser the same news yourself", "fonstar-staging", "tailscale"]) assert.ok(run.toLowerCase().includes(term.toLowerCase()), `tower-run.md names ${term}`);
});

test("wait cards: head-run.md and main.md say the same in their words", () => {
	const head = readFileSync(`${PROMPT_DIR}/head-run.md`, "utf8"), main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["as a card", "in the language your brief names", "`from` is the tower's session id", "`restates`"]) assert.ok(head.includes(term), `head-run.md names ${term}`);
	for (const term of ["A `wait_card` message is the boss's answer to your wait: act on it; it says when to call `secret_drop`."]) assert.ok(main.includes(term), `main.md names ${term}`);
});

// docs/specs/2026-11-07-train-workers.md §13.1 and §15 row 8: the train is a worker of its own, acceptance happens before loading, and the sb server sends every car notice.
const SEAMS7 = [...SEAMS, "Step runner"];
const read = (file: string) => readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
const D13_WORD = acceptanceWord({ car: "<ticket>", what: "<what>", where: "<where>" });
// train.md: ~450 words on (it is the train's system prompt, whole inside the integration markers), nothing off (the role is refused at the open); integrator.md 340 to 412.
test("train workers: train.md and integrator.md stay within their budgets, on and off", () => {
	const train = read("train.md");
	assert.ok(words(strip(train, false)) > 300 && words(strip(train, false)) <= 543, `train.md has ${words(strip(train, false))} words on`);
	assert.equal(words(strip(train, true)), 0, "train.md is empty with the train off");
	assert.ok(words(read("integrator.md")) > 300 && words(read("integrator.md")) <= 530, `integrator.md has ${words(read("integrator.md"))} words`);
});

test("train workers: train.md ends with its own block of the seven seams in the order of seams.md, and main.md keeps six", () => {
	const train = strip(read("train.md"), false);
	assert.equal(train.match(/^## Seam bindings$/gm)?.length, 1);
	const block = train.slice(train.indexOf("## Seam bindings")), lines = block.split("\n").filter((line) => line.startsWith("- "));
	assert.deepEqual(lines.map((line) => line.slice(2, line.indexOf(":"))), SEAMS7);
	assert.match(train.trimEnd(), /## Seam bindings\n(?:- .*\n){6}- [^\n]*$/, "the seven lines are the end of the prompt");
	for (const [seam, mechanism] of [["Handoff route", "`train_car`"], ["Batch owner", "~/.herdr/worktrees/<repo>/train-<code>"], ["Escalation route", "`call_tower`"], ["Settings", "`train:`"], ["Step runner", "`MonitorCreate` described `train <code> #<id> <kind>`"]]) assert.ok(lines.find((line) => line.startsWith(`- ${seam}:`))?.includes(mechanism!), `${seam} names ${mechanism}`);
	const main = strip(read("main.md"), false), mainLines = main.slice(main.indexOf("## Seam bindings")).split("\n").filter((line) => line.startsWith("- "));
	assert.equal(mainLines.length, 6);
	const at = (seam: string) => mainLines.find((line) => line.startsWith(`- ${seam}:`))!;
	assert.ok(at("Batch owner").includes("the project's one integrator main schedules trains; each departed train runs in a `train` session the tower opens"));
	assert.ok(at("Record").includes("{{state}}/trains/<project>/<app>.json") && at("Record").includes("{{state}}/trains/<project>/<app>/<code>.json"), "Record names the index and the per-train files, both under trains/");
	assert.ok(at("Handoff route").includes("the sb server sends every car notice (received, returned, dropped, landed) to the slip's `coordinator` by session id") && at("Handoff route").includes("the slip's `coordinator` is the session that sent it"));
	assert.ok(at("Approval").includes("quoted in `accept`"), "the boss's nod on acceptance is quoted in accept");
});

test("train workers: train.md names every kind of the closed set, the checks before push, merge and deploy, and the way a step runs", () => {
	const train = read("train.md");
	for (const kind of KINDS) assert.ok(train.includes(`\`${kind}\``) || new RegExp(`\\b${kind}\\b`).test(train), `train.md names ${kind}`);
	assert.doesNotMatch(train, /\b(e2e|uat)\b[^.]*\bkind\b/i);
	assert.ok(train.includes(`Kinds only classify: ${KINDS.map((kind) => `\`${kind}\``).join(", ")}.`), "train.md lists exactly the closed set of kinds");
	for (const term of ["metadata.sb", "`integrating`", "`deploying`", "`MonitorCreate`", "train <code> #<id> <kind>", "round", "void", "rollback", "never wait on a person", "`land`", "`blocked`", "`shared`", "`milestone`", "never renamed", "`reviewer`"]) assert.ok(train.includes(term), `train.md names ${term}`);
	assert.match(train, /declares `holds` \(`lane: <app>` from `assemble` to `merge`; `target: <name>` from `deploy` to `deploy-verify`\) and, on a `run` check, `load` and `lock` as `## Load` says/, "a step declares holds, load and lock");
	for (const key of ["`v`: 1", "`project`", "`app`", "`train`", "`round`", "`kind`", "`name`", "`spec`"]) assert.ok(train.includes(key), `train.md lists the metadata.sb key ${key}`);
	for (const term of ["`blocked` with reply false for what needs a person, then end", "delivered or escalated", "{{state}}/trains/<project>/<app>/<code>.json", "`car-<n>.json`"]) assert.ok(train.includes(term), `train.md names ${term}`);
	assert.ok(train.includes("2.11.0 or newer") && read("integrator.md").includes("2.11.0 or newer"), "both name pi-anchorloop 2.11.0 in their blocked line");
});

test("train workers: no uat stage and no UAT page in the integrator or the train; both state D13's refusal with its word; neither tells a coordinator a car's fate, both set it with train_car", () => {
	for (const file of ["integrator.md", "train.md"]) {
		const text = read(file).replace(/- A train in your ledger with no trainboard[^\n]*/, "");
		assert.doesNotMatch(text, /`uat`|UAT page|accepted in UAT|\bshow_doc\b/, `${file} has no uat stage or page`);
		const bare = text.replace(D13_WORD, "").replace("A car that asks it for UAT, e2e, or any acceptance", "").replace("You never wait on a person and run no UAT, e2e, or acceptance.", "").replace("still list the old uat stage", "");
		assert.doesNotMatch(bare, /\buat\b/i, `${file} runs no uat stage, backticked or not`);
		assert.doesNotMatch(text, /tower_reply|tower_send|tell (?:the|a|each) coordinator|notify (?:the|a|each) coordinator/i, `${file} has no way to tell a coordinator by itself`);
		assert.ok(text.includes(D13_WORD), `${file} states D13's word`);
		assert.ok(text.includes("`train_car`"), `${file} names train_car`);
		assert.ok(text.includes("never send a slip's sender a notice yourself"), `${file} sends no notice`);
		assert.doesNotMatch(text, /\bintercom\b/i, `${file} answers no coordinator by intercom`);
	}
	const integrator = read("integrator.md");
	assert.ok(integrator.includes("equal the forward's `fwd-from`"), "the coordinator is the forward's fwd-from, not the header's sender");
	assert.ok(integrator.includes("One `train` todo per forming train (`metadata.sb`, `v`: 1") && integrator.includes("`in_progress` first (sb holds it until each `received` notice is told) and only then the manifest's call, `completed` on the tower's answer with `result`"), "the train todo's lifecycle");
	assert.match(integrator, /legacy: finish it as before \(merge, deploy, UAT page, intercom/, "legacy trains are finished the old way");
	for (const term of ["`received`", "`returned`", "`train check`", "`--accept <evidence>`", "`departs`", "`integration.maxTrains`", "`strict`", "`train:`", "`why: shared`", "`metadata.sb`", "you do not supervise it", "idle"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	for (const state of ["`landed`", "`dropped`", "`returned`"]) assert.ok(read("train.md").includes(state), `train.md names ${state}`);
});

test("train workers: planning, apps-config, main and the tower prompts say the new flow", () => {
	const plan = read("planning.md"), cfg = read("apps-config.md"), main = read("main.md");
	for (const term of ["`integration.accept`", "`## Acceptance`", "the boss's nod", "`--accept <file> --app-accept <integration.accept> --slip <slip>`", "a `human` anchor is this acceptance, not the train's"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	assert.doesNotMatch(plan, /train's UAT|checkpoints file/);
	for (const term of ["`integration.maxTrains`", "default 3", "`integration.accept`", "then optionally `deploy`"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	assert.doesNotMatch(cfg, /"uat"|`uat`/, "apps-config.md has no uat stage");
	assert.doesNotMatch(main, /\bUAT\b/);
	for (const file of ["tower.md", "tower-run.md"]) {
		const text = read(file);
		for (const term of ["`role: \"train\"`", "manifest", "`train:` block", "`blocked`"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
	// A car slip reaches the integrator only as a stamped forward, and since 0.74.0 (todo #151) by one door: boss_open_main with role integrator, in the run that took the slip; the code finds or opens the project's one integrator and forwards.
	// A run is shown no event id, so the prompt names none (`forward: <event id>` could not be followed).
	const run = read("tower-run.md");
	assert.ok(run.includes("Send it there with `boss_open_main` and `role: \"integrator\"`: the slip as it came as the request, and its sender, in the run that took it"), "tower-run.md sends a slip through the integrator's door");
	assert.ok(run.includes("opens it as your own main (kind integrator, outside the two opened mains and the sender's one; a project never has two)"), "the integrator is the tower's own main, and a project has one");
	assert.ok(run.includes("nothing you send without that stamp reaches one as a slip") && !/`forward: <event id>`|boss_duty/.test(run), "tower-run.md leaves the kind to the code and names no event id of its own");
	// A project that already runs integrators of its own (0.73: the boss's, one per app) keeps the forward of 0.73: the door opens nothing and gives the event id, and the run forwards with tower_reply to the one that runs the app's trains.
	assert.ok(run.includes("Where the project already runs integrators of its own (the boss's, one per app, such as `integ FE2` and `integ v3`), the door opens nothing and answers with their names and the slip's event id"), "tower-run.md keeps the boss's own integrators");
	assert.ok(run.includes("forward the slip to the one that runs that app's trains with `tower_reply` (`to`: that integrator, `message`: the slip as it came, `forward`: that event id), in the same run") && run.includes("open no main for it. `tower_send` cannot reach an integrator"), "tower-run.md forwards with tower_reply and the door's event id, never with tower_send");
	// An ally run has the same door for a slip of a main it opened, and no other way to an integrator.
	const ally = read("ally-run.md");
	assert.ok(ally.includes("A car slip from a main you opened") && ally.includes("`role: \"integrator\"`") && ally.includes("A request to open an integrator gets none"), "ally-run.md sends a slip of its main through the door and opens no integrator otherwise");
	assert.ok(run.includes("answer the integrator with `tower_reply`: the train's session id, or the refusal"), "the integrator hears the train's open");
	assert.ok(read("tower.md").includes("needs the tower runs (`towerRuns.enabled`)") && !read("tower.md").includes("`forward:"), "the resident tower forwards nothing");
	assert.ok(read("tower-run.md").includes("once per code") && read("tower-run.md").includes("two opened mains"), "tower-run.md opens one train per code, outside the two");
	assert.ok(read("tower-run.md").includes("a car notice") && read("tower-run.md").includes("coordinator that is gone"), "tower-run.md routes the sb server's blocked about a car notice");
	// Issue #13: the integrator's session hands the tower a `returned` notice the sb server lost (carwait.ts), and the run passes it on.
	assert.ok(read("tower-run.md").includes("One from an integrator about a `returned` notice sb cannot confirm carries the notice: when that coordinator is live, send it the notice with `tower_reply` (`to`: its session id)"), "tower-run.md passes on a returned notice the integrator hands it");
});

test("train workers: no prompt of the train flow names an environment", () => {
	for (const file of ["integrator.md", "train.md", "tower.md", "apps-config.md", "planning.md", "main.md"]) assert.ok(!/\b(staging|production|prod)\b/i.test(read(file)), `${file} names no environment`);
	const run = read("tower-run.md"), blocks = [...run.matchAll(/<!-- integration -->([\s\S]*?)<!-- \/integration -->/g)].map((m) => m[1]).join("\n");
	assert.ok(!/\b(staging|production|prod)\b/i.test(blocks), "the integration text of tower-run.md names no environment");
});

test("train workers: the train todo's fields and result, the cli placeholder, the receipt's none, and the trainboard folder (TP2-F001, F003, F004)", () => {
	const integrator = read("integrator.md"), train = read("train.md"), main = read("main.md"), planning = read("planning.md");
	for (const key of ["`v`: 1", "`project`", "`app`", "`train`", "`spec.cars`", "`result`", "`outcome: passed`", "`session`", "`refusal`"]) assert.ok(integrator.includes(key), `integrator.md names ${key} of the train todo`);
	assert.ok(main.includes("{{cli}} train check") && main.includes("{{cli}} train status"), "main.md runs train check and status through {{cli}}");
	assert.ok(train.includes("{{cli}} train status"), "train.md runs train status through {{cli}}");
	assert.ok(!/\{\{cli\}\}/.test(integrator) && !/\{\{cli\}\}/.test(planning), "raw-read prompts carry no placeholder");
	assert.ok(/main prompt/.test(integrator) && /main prompt/.test(planning), "integrator and planning point to the main prompt's command");
	assert.ok(integrator.includes("`none`") && integrator.includes("accept: none"), "integrator's receipt covers --accept none");
	assert.ok(train.includes("{{state}}/trainboard/<project>/<code>/"), "train.md names its trainboard folder");
});

// TB-F006: the fields a prompt names for a car state are the fields `train_car` requires (a prompt that left out `round` of `dropped` sent a model into a refusal it could not foresee).
test("train workers: every state a prompt names with fields names exactly the fields validateStateFields requires", () => {
	const seen = new Set<string>();
	for (const file of ["train.md", "integrator.md"]) {
		for (const [, state, list] of read(file).matchAll(/`(received|returned|dropped|landed)` \(((?:`[a-z]+`(?:, )?)+)\)/g)) {
			const named = [...list!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!).sort();
			const needed = validateStateFields(state as CarState, {}).map((r) => /needs (\w+)$/.exec(r)![1]!).sort();
			assert.deepEqual(named, needed, `${file}: ${state} names ${named.join(", ")}, train_car requires ${needed.join(", ")}`);
			seen.add(`${file} ${state}`);
		}
	}
	assert.deepEqual([...seen].sort(), ["integrator.md received", "train.md dropped", "train.md landed"]);
});

test("TB-F006, F008, F009: the prompts give the code's form, the todo order, absolute evidence paths, the version refusal and the car with no forward", () => {
	const integrator = read("integrator.md"), train = read("train.md");
	for (const term of ["`YYYY-MM-DD-<letters>`", "`in_progress` first", "(absolute paths)", "sb refuses your `train` todos when the installed pi-anchorloop is older than 2.11.0", "A slip with no tower forward (queued before 0.65.0) cannot be received"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(train.includes("sb refuses your `todo` and `MonitorCreate` calls when the installed pi-anchorloop is older than 2.11.0"), "train.md says the version is sb's check, not the model's");
	assert.ok(strip(read("planning.md"), false).includes("absolute paths in `accept:` and `evidence`"), "the coordinator writes absolute paths");
});
