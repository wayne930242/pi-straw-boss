import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render, type Snapshot, type Tone } from "../src/dashboard.ts";
import { COORDINATOR_DUTIES, type Duty, WORKER_DUTIES } from "../src/duty.ts";
import { ARROW, KIND_MARK, MARK, type Pane, TOWER_LABEL, HEAD_LABEL } from "../src/herdr.ts";
import { subagents } from "../src/netdata.ts";
import { descendants, netTokens } from "../src/order.ts";
import type { Base, Unit } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";
import { World } from "./fakes.ts";

// Todo #152 (docs/specs/2026-11-09-agent-kinds.md D16): a unit's kind shows in its icon, on the page and in Herdr's sidebar. Position icons stay for a unit with no known kind.

sessionGlobals();
overwriteGetLocale(() => "en");
Object.assign(document, { createComment: () => new El("#comment") });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const { baseEl, fillBase, unitIcon } = await import("../gui/render.ts");
const { iconRef } = await import("../gui/icons.ts");
const { fillAllyUnits } = await import("../gui/allyunits.ts");
void page;

const DUTIES = [...COORDINATOR_DUTIES, ...WORKER_DUTIES];
const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
const symbol = (id: string) => new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)</symbol>`).exec(html)?.[1];

test("unitIcon: a unit's kind names its icon, a train keeps the locomotive, and a unit with no kind (or one that is no kind) keeps its position's icon", () => {
	for (const duty of DUTIES) assert.equal(unitIcon(duty === "worker" || duty === "scout" || duty === "planner" || duty === "reviewer" ? "subagent" : "main", duty), duty);
	assert.equal(unitIcon("train", undefined), "train");
	assert.equal(unitIcon("main", undefined), "main");
	assert.equal(unitIcon("member", undefined), "member");
	assert.equal(unitIcon("subagent", undefined), "subagent");
	assert.equal(unitIcon("outside", undefined), "outside");
	for (const bad of ["bogus", "constructor", "toString", "__proto__", ""]) assert.equal(unitIcon("main", bad), "main", bad);
	for (const role of ["tower", "ally", "run", "outpost", "outside"]) assert.equal(unitIcon(role, "worker"), unitIcon(role, undefined), `${role} keeps its own icon`);
	assert.equal(unitIcon("tower", undefined), "tower");
});

test("every kind has a symbol of its own in Standard's sprite, distinct from every other icon (the tower and the head's crown included), in one colour", () => {
	const ids = [...DUTIES, "train", "tower", "crown", "main", "member", "subagent", "outpost", "outside", "user", "doc", "comms"];
	const paths = ids.map((id) => symbol(`i-${id}`));
	for (const [i, path] of paths.entries()) assert.ok(path && path.includes("<path"), `i-${ids[i]} is drawn`);
	assert.equal(new Set(paths).size, ids.length, "no two icons are the same drawing");
	for (const duty of DUTIES) assert.match(html, new RegExp(`<symbol id="i-${duty}" viewBox="0 0 512 512" fill="currentColor"`), duty);
	assert.ok(!/fill="#/.test(DUTIES.map((d) => symbol(`i-${d}`)).join("")), "currentColor only");
	assert.match(html, /game-icons\.net, CC BY 3\.0/, "the credit stays");
	assert.equal(iconRef("scout"), "#i-scout", "Standard's own symbol, which every view falls back to");
});

const unit = (key: string, role: Unit["role"], over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role, mark: "working", note: "thinking", subs: [], ...over });
const base = (units: Unit[]): Base => ({ id: "w1", label: "Harbor", mark: "working", tower: null, tabs: [{ id: "w1:t1", label: "work", units }], outposts: [], outside: [] });
const iconOf = (el: El, name: string) => el.find((x) => x.classes.has("unit") && x.find((y) => y.classes.has("name"))[0]?.textContent === name)[0]!.find((x) => x.tag === "use")[0]!.dataset.icon;

test("the map's cards draw each unit's kind icon: mains by duty, a train, a launched worker by its duty; a unit with no kind keeps its position icon", () => {
	const el = baseEl() as unknown as El;
	const kids = WORKER_DUTIES.map((d) => unit(`k-${d}`, "subagent", { duty: d }));
	fillBase(el as unknown as HTMLElement, base([
		unit("coord", "main", { duty: "coordinator", subs: kids }), unit("integ", "main", { duty: "integrator" }), unit("stand", "main", { duty: "standing" }),
		unit("old", "main"), unit("car", "train"), unit("mem", "member"), unit("plain", "main", { subs: [unit("sub", "subagent")] }),
	]), {});
	assert.deepEqual(["coord", "integ", "stand", "old", "car", "mem"].map((n) => iconOf(el, n)), ["coordinator", "integrator", "standing", "main", "train", "member"]);
	for (const d of WORKER_DUTIES) assert.equal(iconOf(el, `k-${d}`), d);
	assert.equal(iconOf(el, "sub"), "subagent");
});

test("a main's row on an ally card draws its kind icon beside the name: the box's word, a train's locomotive, the position's icon for a main with none or an unknown one", () => {
	const list = new El("ul");
	page.body.replaceChildren(list);
	const mainCard = (name: string, kind?: string) => ({ handle: name.padEnd(16, "0"), team: "t", at: 0, name, state: "running", tone: "working", word: "running", canStop: false, ...(kind ? { kind } : {}) });
	const card = { unit: "Harbor API", state: "running", tone: "working", word: "running", at: Date.now(), stale: false, monitors: [], report: "", team: "t", device: "d1", mains: ["coordinator", "integrator", "standing", "train", "old", "odd"].map((k) => mainCard(k === "old" ? "old" : k, k === "old" ? undefined : k === "odd" ? "<img>" : k)) } as never;
	fillAllyUnits(list as unknown as HTMLElement, [card], false);
	const icons = list.querySelectorAll(".au-main").map((r) => r.querySelector("use")!.dataset.icon);
	assert.deepEqual(icons, ["coordinator", "integrator", "standing", "train", "main", "main"]);
});

test("the sidebar marks: one Nerd Font glyph per kind, each one code point, all different, and the ones checked against Nerd Fonts 3.5.1's glyph names", () => {
	assert.deepEqual(Object.keys(KIND_MARK).sort(), [...DUTIES, "train"].sort());
	for (const [kind, mark] of Object.entries(KIND_MARK)) assert.equal([...mark].length, 1, `${kind} is one glyph`);
	assert.equal(new Set(Object.values(KIND_MARK)).size, Object.keys(KIND_MARK).length, "every kind has its own");
	const taken = [TOWER_LABEL, HEAD_LABEL, MARK.member, MARK.main];
	for (const mark of Object.values(KIND_MARK)) assert.ok(!taken.includes(mark), "not the tower's, the head's, or a member's glyph");
	// glyphnames.json 3.5.1: md-ship_wheel, md-lighthouse, md-wrench, md-binoculars, md-pencil_ruler, md-magnify, md-dog; fa-code_fork, fa-train.
	assert.deepEqual(KIND_MARK, { coordinator: "\u{f0833}", integrator: "\uf126", standing: "\u{f09ff}", train: "\uf238", worker: "\u{f05b7}", scout: "\u{f00a5}", planner: "\u{f1353}", reviewer: "\u{f0349}" });
	assert.equal(MARK.main, "\uf005", "a main with no known kind keeps the star");
});

const scratch = mkdtempSync(join(tmpdir(), "psb-kind-icons-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const pane = (id: string, tab: string, extra: Partial<Pane> = {}): Pane => ({ pane_id: id, tab_id: tab, workspace_id: tab.split(":")[0], agent: "pi", ...extra });
/** A session `parent` that launched `kids` (id, name, the agent role named in the launch script); returns the parent's session file. */
function launch(parent: string, kids: { id: string; name: string; agent?: string }[]) {
	const art = join(scratch, "sessions", "artifacts", parent);
	mkdirSync(join(art, "subagent-activity"), { recursive: true });
	mkdirSync(join(art, "subagent-scripts"), { recursive: true });
	for (const k of kids) {
		writeFileSync(join(art, "subagent-activity", `${k.id}.json`), JSON.stringify({ phase: "active" }));
		writeFileSync(join(art, "subagent-scripts", `${k.name}-${k.id}.sh`), `#!/bin/bash\ncd '/x' && PI_SUBAGENT_NAME='${k.name}' ${k.agent ? `PI_SUBAGENT_AGENT='${k.agent}' ` : ""}PI_SUBAGENT_AUTO_EXIT=1\n`);
	}
	return join(scratch, "sessions", `2026-10-18T00-00-00-000Z_${parent}.jsonl`);
}
const kidFile = (id: string) => join(scratch, "sessions", `2026-10-18T00-00-01-000Z_${id}-1a2b3c4d-5e6f7a8b-9c0d.jsonl`);
const kidPane = (paneId: string, id: string, label: string) => pane(paneId, "wA:t1", { agent_status: "working", label, agent_session: { value: kidFile(id) } });

test("a launched subagent's kind is the agent role its launch script names: a reviewer's visual tester counts as a reviewer, an unknown role, the retired watchdog (0.83.0), or none has no kind", () => {
	const file = launch("kp", [{ id: "k1", name: "aa", agent: "scout" }, { id: "k2", name: "bb", agent: "visual-tester" }, { id: "k3", name: "cc", agent: "nope" }, { id: "k4", name: "dd" }, { id: "k5", name: "ee", agent: "constructor" }, { id: "k6", name: "ff", agent: "watchdog" }]);
	const parent = pane("wA:p0", "wA:t1", { agent_session: { value: file } });
	const ps = [parent, ...["k1", "k2", "k3", "k4", "k5", "k6"].map((id, i) => kidPane(`wA:p${i + 1}`, id, ["aa", "bb", "cc", "dd", "ee", "ff"][i]!))];
	const rows = subagents(parent, ps, Date.now());
	assert.deepEqual(Object.fromEntries(rows.map((r) => [r.text, r.duty])), { aa: "scout", bb: "reviewer", cc: undefined, dd: undefined, ee: undefined, ff: undefined });
});

test("a subagent's sidebar mark is its kind's glyph alone; one with no kind keeps [sub] and its launcher's name; a main's own mark is its kind's", async () => {
	const file = launch("km", [{ id: "m1", name: "aa", agent: "planner" }, { id: "m2", name: "bb" }]);
	const parent = pane("wA:p0", "wA:t1", { agent_session: { value: file } });
	const kids = descendants(parent, "000.0", "Parent", [parent, kidPane("wA:p1", "m1", "aa"), kidPane("wA:p2", "m2", "bb")], Date.now());
	assert.deepEqual(kids.map((k) => [k.name, k.mark]), [["aa", KIND_MARK.planner], ["bb", `${ARROW} Parent`]]);

	const world = new World();
	world.herdr.addPane("wA:p1", "wA:t1");
	const run = world.herdr.runFor("wA:p1"), place = { paneId: "wA:p1", tabId: "wA:t1", workspaceId: "wA" };
	for (const duty of COORDINATOR_DUTIES) assert.equal((await netTokens(run, place, "main", "M", Date.now(), undefined, { integrator: duty === "integrator", duty })).own.sb_mark, KIND_MARK[duty], duty);
	assert.equal((await netTokens(run, place, "main", "M")).own.sb_mark, MARK.main, "no kind, the star");
	await world.stopAll();
});

test("the dashboard's rows carry the kind's glyph before the name, with the role's word in the kind column; a row with no kind keeps the role mark", () => {
	const row = (depth: number, text: string, kind: string, duty?: Duty) => ({ group: "net" as const, depth, mark: "idle" as const, text, kind, ...(duty ? { duty } : {}) });
	const snap: Snapshot = { title: "Alpha", mark: "idle", head: false, rows: [{ group: "net", depth: 0, mark: "unknown", text: "tab t" }, row(1, "Standing One", "main", "standing"), row(1, "Plain", "main"), row(2, "Looker", "subagent", "scout"), row(2, "Nameless", "subagent")] };
	const tagged = (tone: Tone, text: string) => `<${tone}:${text}>`;
	const lines = render(snap, 0, 100, tagged).join("\n");
	assert.ok(lines.includes(`<main:${KIND_MARK.standing}> Standing One`), lines);
	assert.ok(lines.includes(`<main:${MARK.main}> Plain`));
	assert.ok(lines.includes(`<dim:${KIND_MARK.scout}> Looker`));
	assert.ok(lines.includes(`<dim:${ARROW}> Nameless`));
	assert.match(lines, /Looker\s+<muted:subagent/);
});
