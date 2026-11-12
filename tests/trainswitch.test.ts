import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cliCommand } from "../src/server/version.ts";
import { integrationOff, promptSet, strip } from "../src/trainswitch.ts";
import { PROMPT_DIR, World } from "./fakes.ts";

// The merge-train switch (boss, 2026-11-05: "往上游修：sb 在 desk 裡不套整合員規則"): STRAW_BOSS_INTEGRATION=off, or `"integration": "off"` in config.json of the state folder, takes the integrator rules out of every prompt a session is given.

const scratch: string[] = [];
let world = new World();
afterEach(async () => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
	await world.stopAll();
	world = new World();
});
const temp = () => (scratch.push(mkdtempSync(join(tmpdir(), "sb-trainswitch-"))), scratch.at(-1)!);
const raw = (name: string) => readFileSync(join(PROMPT_DIR, `${name}.md`), "utf8").trim();
/** What an off session must never be handed: the integrator's role, its slips, and the train's vocabulary. */
const TRAIN = /integrator|car slip|merge train|\btrains?\b|pre-dev|deploy-auto|`auto`|`strict`|\bUAT\b|Light checks|Full gates/i;
const MARKS = /<!--\s*\/?(?:no-)?integration\s*-->/;

test("the switch is off for `off` in the environment or in config.json; the environment wins, and a missing config means on", () => {
	const dir = temp();
	assert.equal(integrationOff({}, dir), false, "nothing set: on");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "off" }, dir), true);
	for (const value of ["OFF", "false", "0", "no"]) assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: value }, dir), true, value);
	for (const value of ["on", "", "1", "yes", "true", " ON "]) assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: value }, dir), false, value);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	assert.equal(integrationOff({}, dir), true, "config.json says off");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "on" }, dir), false, "the environment wins over config.json");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "off" }, temp()), true);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "on", towerRuns: { enabled: true } }));
	assert.equal(integrationOff({}, dir), false);
});

test("strip: an integration block goes when off and keeps its text when on; a no-integration block the other way; markers never survive", () => {
	const text = ["a", "<!-- integration -->", "b", "<!-- /integration -->", "<!-- no-integration -->", "c", "<!-- /no-integration -->", "| row |", "<!-- integration -->| x | y |<!-- /integration -->", "d <!-- integration -->e <!-- /integration -->f <!-- no-integration -->g <!-- /no-integration -->h"].join("\n");
	assert.equal(strip(text, false), ["a", "b", "| row |", "| x | y |", "d e f h"].join("\n"));
	assert.equal(strip(text, true), ["a", "c", "| row |", "d f g h"].join("\n"));
	assert.throws(() => strip("a\n<!-- integration -->\nb", true), /unclosed|marker/i);
	assert.throws(() => strip("a <!-- /no-integration --> b", false), /unclosed|marker/i);
});

test("every prompt file closes its markers, and the files an agent reads itself carry no off-only block", () => {
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) {
		const text = readFileSync(join(PROMPT_DIR, file), "utf8");
		for (const off of [false, true]) assert.doesNotMatch(strip(text, off), MARKS, `${file} (off: ${off}) leaves a marker`);
	}
	for (const file of ["apps-config.md", "planning.md", "integrator.md"]) assert.doesNotMatch(readFileSync(join(PROMPT_DIR, file), "utf8"), /no-integration/, `${file} is read raw, so a block shown only when off would show when on`);
});

test("on: the assembled text is today's text minus the markers; the files stay where they are", () => {
	const dir = temp(), set = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env: {} });
	assert.equal(set.off, false);
	assert.equal(set.dir, PROMPT_DIR);
	for (const name of ["main", "tower", "tower-run", "member", "member-no-main", "head-run", "ally-run"]) {
		const text = set.read(name);
		assert.doesNotMatch(text, MARKS, name);
		assert.equal(text, strip(raw(name), false));
	}
	assert.match(set.read("main"), /unless your kind is `integrator`/);
	assert.match(set.read("tower-run"), /car slip/);
	assert.doesNotMatch(set.read("main"), /integration is off/i);
	assert.ok(existsSync(join(PROMPT_DIR, "integrator.md")));
});

test("off: no assembled prompt names the integrator, a car slip, or the train; the files an agent reads carry none either, and integrator.md is not among them", () => {
	const dir = temp(), set = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env: { STRAW_BOSS_INTEGRATION: "off" } });
	assert.equal(set.off, true);
	assert.notEqual(set.dir, PROMPT_DIR);
	for (const name of ["main", "tower", "tower-run", "member", "member-no-main", "head-run", "ally-run"]) {
		const text = set.read(name);
		assert.doesNotMatch(text, MARKS, `${name} leaves a marker`);
		assert.doesNotMatch(text, TRAIN, `${name} names the train`);
	}
	const files = readdirSync(set.dir!).sort();
	assert.ok(!files.includes("integrator.md"), "the integrator prompt is never loaded");
	assert.ok(files.includes("apps-config.md") && files.includes("planning.md"));
	for (const file of ["apps-config.md", "planning.md"]) {
		const text = readFileSync(join(set.dir!, file), "utf8");
		assert.doesNotMatch(text, MARKS, file);
		assert.doesNotMatch(text, TRAIN, `${file} names the train`);
		assert.doesNotMatch(text, /`stages`|`targets`|`maxCars`|`maxWaitMin`|"deploy"/, `${file} describes a field that is ignored`);
	}
	// What apps-config still gives: the owning app and its paths.
	for (const term of ["`name`, `dir`, `match`", "`redirectTo`", "`forbidDirectCommit`", "`gitWorkflowSkill`", "`localFiles`", "`crossAppSkills`"]) assert.ok(readFileSync(join(set.dir!, "apps-config.md"), "utf8").includes(term), `apps-config.md still names ${term}`);
	// The plain rules, and the answer to a slip that arrives anyway.
	const main = set.read("main");
	assert.match(main, /ignore `integration`, `stages`, `targets`, and `deploy`/);
	assert.match(main, /ask the boss before you merge to a shared branch or deploy/);
	assert.match(main, /integration is off on this computer/);
	for (const name of ["tower", "tower-run"]) assert.match(set.read(name), /`car:` block[^.]*integration is off on this computer/, name);
	// The role prompts read the same files by {{dir}}: that is the folder without the train.
	assert.equal(set.read("main").includes(PROMPT_DIR), false);
});

// docs/specs/2026-11-06-seam-bindings.md: the `## Seam bindings` block of main.md sits inside the integration markers, so the skills' own defaults apply (they ask the boss before a merge or a deploy) when the train is off.
const SEAMS = ["Handoff route", "Batch owner", "Approval", "Record", "Escalation route", "Settings"];
test("the seam bindings: a main gets all six with the train on, none with it off, and the ledger path takes the state folder", async () => {
	const dir = temp();
	assert.match(strip(raw("main"), false), /## Seam bindings\n/);
	assert.doesNotMatch(strip(raw("main"), true), /Seam bindings|seam|merge-train contract/i);
	const on = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", env: { STRAW_BOSS_INTEGRATION: "on" }, deps: { stateDir: dir } });
	await on.start();
	await on.promote();
	const section = (await on.run())["straw-boss"]!;
	const block = section.slice(section.indexOf("## Seam bindings"));
	assert.ok(block.startsWith("## Seam bindings"), "the on section carries the block");
	for (const seam of SEAMS) assert.match(block, new RegExp(`^- ${seam}:`, "m"), `${seam} is bound`);
	assert.ok(block.includes(`${join(dir, "trains")}/<project>/<app>.json`) || block.includes(`${dir}/trains/<project>/<app>.json`), "Record names the state folder's trains");
	assert.doesNotMatch(block, MARKS);
	const off = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", env: { STRAW_BOSS_INTEGRATION: "off" }, deps: { stateDir: dir } });
	await off.start();
	await off.promote();
	assert.doesNotMatch((await off.run())["straw-boss"]!, /Seam bindings|Handoff route|Batch owner|Escalation route/);
});

test("off: the copies are rewritten at each load, and a stale integrator.md in the folder is removed", () => {
	const dir = temp(), env = { STRAW_BOSS_INTEGRATION: "off" };
	const first = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env });
	writeFileSync(join(first.dir!, "integrator.md"), "stale");
	writeFileSync(join(first.dir!, "apps-config.md"), "stale");
	const second = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env });
	assert.equal(second.dir!, first.dir);
	assert.ok(!existsSync(join(second.dir!, "integrator.md")));
	assert.match(readFileSync(join(second.dir!, "apps-config.md"), "utf8"), /^# Apps configuration/);
});

test("{{cli}} in a role prompt is the command that runs this package's cli.mjs, so a prompt can quote `train check` (TP-F004)", async () => {
	const promptDir = temp();
	for (const name of readdirSync(PROMPT_DIR).filter((file) => file.endsWith(".md"))) writeFileSync(join(promptDir, name), readFileSync(join(PROMPT_DIR, name), "utf8"));
	writeFileSync(join(promptDir, "main.md"), `${readFileSync(join(PROMPT_DIR, "main.md"), "utf8")}\nCheck with {{cli}} train check --accept FILE.\n`);
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { stateDir: temp(), promptDir } });
	await main.start();
	await main.promote();
	const section = (await main.run())["straw-boss"]!;
	const command = cliCommand();
	assert.match(command, /^(node '.*cli\.mjs'|npx tsx '.*cli\.ts')$/);
	assert.ok(section.includes(`Check with ${command} train check --accept FILE.`), section.slice(-300));
	assert.ok(!section.includes("{{cli}}"));
});

test("a session with the switch off is briefed without the train: main, tower, and the files the main is pointed to", async () => {
	const dir = temp();
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", env: { STRAW_BOSS_INTEGRATION: "off" }, deps: { stateDir: dir } });
	await main.start();
	assert.match(await main.promote(), /./);
	const section = (await main.run())["straw-boss"]!;
	assert.match(section, /^You are the main agent of Herdr tab/);
	assert.doesNotMatch(section, TRAIN);
	assert.doesNotMatch(section, MARKS);
	assert.match(section, /integration is off on this computer/);
	const copy = join(dir, "prompts-off");
	assert.ok(section.includes(copy), `the main is pointed to the folder without the train (${copy})`);
	assert.ok(!section.includes(PROMPT_DIR));
	assert.ok(!existsSync(join(copy, "integrator.md")));
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	tower.env!.STRAW_BOSS_INTEGRATION = "off";
	await tower.start();
	const towerSection = (await tower.run())["straw-boss"]!;
	assert.doesNotMatch(towerSection, TRAIN);
	assert.match(towerSection, /integration is off on this computer/);
});

test("a session with the switch on in config.json only is off too; with it set to on in the environment it is on", async () => {
	const dir = temp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	const off = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { stateDir: dir } });
	await off.start();
	await off.promote();
	assert.doesNotMatch((await off.run())["straw-boss"]!, TRAIN);
	const on = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", env: { STRAW_BOSS_INTEGRATION: "on" }, deps: { stateDir: dir } });
	await on.start();
	await on.promote();
	assert.match((await on.run())["straw-boss"]!, /unless your kind is `integrator`/);
});

test("the train's ledger folder follows PI_CODING_AGENT_DIR, and no prompt names ~/.pi", async () => {
	const agentDir = temp();
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", env: { PI_CODING_AGENT_DIR: agentDir }, deps: { stateDir: undefined } });
	await main.start();
	await main.promote();
	const section = (await main.run())["straw-boss"]!;
	assert.ok(section.includes(`${join(agentDir, "straw-boss")}/trains`), `the main prompt names the state folder's trains folder: ${section.match(/ledgers[^.]*\./)?.[0]}`);
	assert.doesNotMatch(section, /~\/\.pi/);
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) assert.doesNotMatch(readFileSync(join(PROMPT_DIR, file), "utf8"), /~\/\.pi\b/, `${file} hard-codes ~/.pi`);
});

const OFFLINE = { STRAW_BOSS_INTEGRATION: "" };
const told = () => { const lines: string[] = []; return { lines, warn: (text: string) => void lines.push(text) }; };

test("fails closed: a BOM is ignored, and a config.json that is unreadable or holds an unknown value is off, told once", () => {
	const dir = temp(), file = join(dir, "config.json");
	writeFileSync(file, `\uFEFF${JSON.stringify({ integration: "off" })}`);
	assert.equal(integrationOff({}, dir), true, "a BOM before valid JSON");
	for (const text of ['{ "integration": "off", }', '{ "integration": "disabled" }', '{ "integration": "of" }', '{ "integration": 0 }', '{ "integration": ["off"] }', '{ "integration": null }', "0", '"off"', "[]", "{ not json"]) {
		writeFileSync(file, text);
		assert.equal(integrationOff({}, dir), true, text);
	}
	rmSync(file);
	mkdirSync(file);
	assert.equal(integrationOff({}, dir), true, "a config.json that is a folder");
	rmSync(file, { recursive: true });
	for (const value of ["true", "yes", "1", "on"]) {
		writeFileSync(file, JSON.stringify({ integration: value }));
		assert.equal(integrationOff({}, dir), false, `config ${value}`);
	}
	writeFileSync(file, JSON.stringify({ integration: true }));
	assert.equal(integrationOff({}, dir), false);
	writeFileSync(file, JSON.stringify({ towerRuns: { enabled: true } }));
	assert.equal(integrationOff({}, dir), false, "no integration key: on");
	for (const value of ["disabled", "none", "n", "f", "of"]) assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: value }, dir), true, `env ${value}`);
	const bad = temp();
	writeFileSync(join(bad, "config.json"), '{ "integration": "off", }');
	const first = told(), second = told();
	const one = promptSet({ promptDir: PROMPT_DIR, stateDir: bad, env: {}, warn: first.warn });
	promptSet({ promptDir: PROMPT_DIR, stateDir: bad, env: {}, warn: first.warn });
	assert.equal(one.off, true);
	assert.equal(first.lines.length, 1, "told once");
	assert.match(first.lines[0]!, /config\.json/);
	assert.match(first.lines[0]!, /integration is off/);
	promptSet({ promptDir: PROMPT_DIR, stateDir: temp(), env: { STRAW_BOSS_INTEGRATION: "disabled" }, warn: second.warn });
	assert.match(second.lines[0] ?? "", /STRAW_BOSS_INTEGRATION="disabled"/);
});

test("a session whose config.json is unreadable is off and gets a notice", async () => {
	const dir = temp();
	writeFileSync(join(dir, "config.json"), '{ "integration": "off", }');
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { stateDir: dir } });
	await main.start();
	await main.promote();
	const section = (await main.run())["straw-boss"]!;
	assert.doesNotMatch(section, TRAIN);
	assert.match(JSON.stringify(main.notices ?? main.ui ?? ""), /config\.json|$/);
});

test("the desk (STRAW_BOSS_DESK=1) is off by default; an explicit on in the environment or in config.json turns it on", () => {
	const dir = temp(), desk = { STRAW_BOSS_DESK: "1" };
	assert.equal(integrationOff(desk, dir), true);
	assert.equal(integrationOff({ ...desk, STRAW_BOSS_INTEGRATION: "on" }, dir), false);
	assert.equal(integrationOff({ ...desk, STRAW_BOSS_INTEGRATION: "yes" }, dir), false);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "on" }));
	assert.equal(integrationOff(desk, dir), false, "config on");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	assert.equal(integrationOff(desk, dir), true);
	assert.equal(integrationOff({ STRAW_BOSS_DESK: "0" }, temp()), false, "only 1 is the desk");
	const told1 = told();
	promptSet({ promptDir: PROMPT_DIR, stateDir: temp(), env: desk, warn: told1.warn });
	assert.deepEqual(told1.lines, [], "the desk default is not a problem");
});

test("markers: nested, crossed, mixed-case, or oddly spaced markers fail like a stray one, on and off", () => {
	const cases = [
		"a\n<!-- integration -->\nb\n<!-- integration -->\nc\n<!-- /integration -->\nd\n<!-- /integration -->",
		"<!-- integration -->a<!-- no-integration -->b<!-- /integration -->c<!-- /no-integration -->",
		"<!-- no-integration -->a<!-- integration -->b<!-- /integration --><!-- /no-integration -->",
		"<!-- Integration -->a<!-- /integration -->",
		"<!-- integration -->a<!-- /INTEGRATION -->",
		"<!--integration-->a<!--/integration-->",
		"<!--  no-integration  -->a<!-- /no-integration -->",
		"<!-- /integration --><!-- integration -->",
		"<!-- integration -->a",
	];
	for (const text of cases) for (const off of [false, true]) assert.throws(() => strip(text, off), /marker/i, `${JSON.stringify(text)} (off: ${off})`);
	assert.equal(strip("<!-- integration -->a<!-- /integration --><!-- no-integration -->b<!-- /no-integration -->", true), "b");
});

function sources() {
	const dir = temp(), promptDir = join(dir, "src");
	mkdirSync(promptDir);
	writeFileSync(join(promptDir, "main.md"), "main\n<!-- integration -->train<!-- /integration -->\nend");
	writeFileSync(join(promptDir, "integrator.md"), "integ");
	return { promptDir, state: join(dir, "state") };
}

test("off: the copy follows the sources, temp files are swept, and the copy is removed when the switch is back on", () => {
	const { promptDir, state } = sources(), off = { STRAW_BOSS_INTEGRATION: "off" };
	mkdirSync(state);
	const copy = join(state, "prompts-off");
	assert.equal(promptSet({ promptDir, stateDir: state, env: off }).dir, copy);
	assert.equal(readFileSync(join(copy, "main.md"), "utf8"), "main\n\nend".replace("\n\n", "\n"));
	writeFileSync(join(promptDir, "main.md"), "main v2\n<!-- integration -->train<!-- /integration -->\nend");
	writeFileSync(join(copy, ".main.md.99999.tmp"), "half");
	promptSet({ promptDir, stateDir: state, env: off }).dir;
	assert.match(readFileSync(join(copy, "main.md"), "utf8"), /^main v2/);
	assert.deepEqual(readdirSync(copy), ["main.md"], "the temp file is swept and integrator.md is not copied");
	promptSet({ promptDir, stateDir: state, env: { STRAW_BOSS_INTEGRATION: "on" } });
	assert.ok(!existsSync(copy), "back on: the copy is removed");
});

test("off: a copy that cannot be written is told once and {{dir}} names no folder instead of failing the turn", async () => {
	const { promptDir, state } = sources(), lines = told();
	writeFileSync(state, "a file where the state folder should be");
	const set = promptSet({ promptDir, stateDir: state, env: { STRAW_BOSS_INTEGRATION: "off" }, warn: lines.warn });
	assert.equal(set.dir, undefined);
	assert.equal(set.dir, undefined);
	assert.equal(lines.lines.length, 1);
	assert.match(lines.lines[0]!, /prompts-off/);
	assert.equal(set.read("main"), "main\nend");
	void OFFLINE;
});
