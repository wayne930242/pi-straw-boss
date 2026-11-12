import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBoard } from "../src/boardread.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { netSource } from "../src/net.ts";
import { sliceNet } from "../src/operateslice.ts";
import { trainyardSeam } from "../src/server/trainyard.ts";
import { type Board, type BoardStep, type CarRow, type Writer, writeBoard, writeYard } from "../src/train/board.ts";
import { SHA_A } from "./train-fixtures.ts";

// Task 5 of the train workers (docs/specs/2026-11-07-train-workers.md §11.1, §17 last line): the net reads the trains through a seam of the sb server, the load rides with them, nothing loads with the merge train off,
// and the yards stay on this computer.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-yardnet-"))), dirs.at(-1)!);
const MIN = 60_000, NOW = Date.parse("2026-11-07T10:00:00Z");
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const M = "2026-11-06-m";

const writer = (pid: number, session: string): Writer => ({ session, pane: `p${pid}`, pid, started: "2026-11-07T07:00:00Z" });
const car = (): CarRow => ({ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord", departs: "next", accept: "/r/accept.json", accepted: ["e2e"] });
const step = (id: number, kind: BoardStep["kind"], status: BoardStep["status"], over: Partial<BoardStep> = {}): BoardStep => ({ id, kind, name: `${kind} ${id}`, status, round: 1, ...over });
const board = (over: Partial<Board> = {}): Board => ({ v: 1, project: "acme", app: "web", code: M, writer: writer(4001, "train-1"), updated: iso(MIN), round: 1, cars: [car()], steps: [step(1, "full-check", "in_progress", { load: { max: 30 } })], ...over });
/** The state folder with one running train and a yard whose writer is the project's integrator. */
function trainState() {
	const dir = state();
	writeBoard(dir, board());
	writeYard(dir, { v: 1, project: "acme", writer: writer(4300, "integ-1"), updated: iso(MIN), trains: [{ code: "2026-11-07-a", app: "web", status: "forming", cars: [car()] }] });
	return dir;
}

const ws = (id: string, label: string, tokens: Record<string, string> = {}): Workspace => ({ workspace_id: id, label, tokens });
const pane = (id: string, tab: string, tokens: Record<string, string>): Pane => ({ pane_id: id, tab_id: tab, workspace_id: "wA", tokens });
const session = (id: string, name: string, p: string, tab: string): Session => ({ id, name, status: "idle", herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "Alpha" }, tab: { id: tab, label: tab } } } as Session);
const workspaces = [ws("wA", "Alpha", { tower: "tower-a" })];
const panes = [
	pane("wA:p1", "wA:t1", { sb_role: "main" }), pane("wA:p2", "wA:t2", { sb_role: "train", sb_train: `acme/${M}` }), pane("wA:p5", "wA:t3", { sb_role: "tower" }),
];
const sessions = [session("tower-a", "tower", "wA:p5", "wA:t3"), session("integ-1", "integ acme", "wA:p1", "wA:t1"), session("train-1", "train 1106m", "wA:p2", "wA:t2")];
const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes } : { workspaces } });
const source = (dir: string, over: object = {}, env: NodeJS.ProcessEnv = {}) =>
	netSource({ run: herdr, sessions: async () => sessions, sessionDir: "/s", trainyard: trainyardSeam({ env, stateDir: dir, now: () => NOW, alive: (w) => w.pid === 4001 || w.pid === 4300, load: () => ({ now: 41.96, cores: 14 }), platform: "linux", ...over }) });

test("the net snapshot carries yards with each train's and the integrator's unit key from the net's own panes, and the load with one decimal", async () => {
	const net = await source(trainState()).read();
	const acme = net.yards!.projects[0]!;
	assert.equal(acme.project, "acme");
	assert.deepEqual(acme.trains.map((t) => [t.code, t.key, t.state]), [[M, "train-1", "live"]], "the unit whose pane's sb_train names the train");
	assert.deepEqual(acme.integrator, { key: "integ-1", live: true }, "the main of the net that wrote the yard");
	assert.deepEqual(acme.trains[0]!.steps[0]!.waits, [{ load: { max: 30, now: 42 } }], "the load wait uses the same reading as the header chip");
	assert.deepEqual(net.load, { now: 42, cores: 14 });
	assert.equal(net.bases.length, 1, "the base is the net's own reading as before");
});

test("with no trains and no yard there is no yards and no load in the snapshot: an idle computer's snapshot does not change with its load average", async () => {
	const net = await source(state()).read();
	assert.ok(!("yards" in net) && !("load" in net));
});

test("on Windows the system gives no load average: there is no load in the snapshot and no load wait is made, but the trains are shown", async () => {
	const net = await source(trainState(), { platform: "win32" }).read();
	assert.ok(!("load" in net));
	assert.deepEqual(net.yards!.projects[0]!.trains[0]!.steps[0]!.waits, []);
});

test("a reading of the trains that fails is told in the snapshot instead of failing the net", async () => {
	const seam = trainyardSeam({ env: {}, stateDir: "/nonexistent-state", load: () => { throw new Error("no load at /nonexistent-state"); } });
	const net = await netSource({ run: herdr, sessions: async () => sessions, sessionDir: "/s", trainyard: seam }).read();
	assert.deepEqual(net.yards, { projects: [], problems: ["the trains could not be read: no load at <state>"] });
	assert.equal(net.bases.length, 1);
});

// ---- the switch

test("with the merge train off nothing of it loads: no yards and no load, whether the environment, the config.json of the state folder or the desk says so; turned on, it shows at once", async () => {
	const dir = trainState();
	for (const env of [{ STRAW_BOSS_INTEGRATION: "off" }, { STRAW_BOSS_DESK: "1" }, { STRAW_BOSS_INTEGRATION: "maybe" }]) {
		const net = await source(dir, {}, env).read();
		assert.ok(!("yards" in net) && !("load" in net), JSON.stringify(env));
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	assert.ok(!("yards" in (await source(dir).read())), "config.json off");
	const live = source(dir);
	assert.ok(!("yards" in (await live.read())));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "on" }));
	assert.equal((await live.read()).yards?.projects.length, 1, "turned on while the server runs: shown at the next reading");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	assert.ok(!("yards" in (await live.read())), "turned off again: gone");
});

test("with the switch off the seam does not even look at the trainboard folder", () => {
	const dir = trainState();
	const seam = trainyardSeam({ env: { STRAW_BOSS_INTEGRATION: "off" }, stateDir: dir, load: () => { throw new Error("the load was read"); } });
	assert.equal(seam.yards({ trains: [], mains: new Set(), integrators: new Set() }), undefined);
	assert.equal(seam.load(), undefined);
});

// ---- yards stay on this computer

test("the operate slice shows a controller neither yards nor the load, whatever the net holds", async () => {
	const net = await source(trainState()).read();
	assert.ok(net.yards && net.load, "the net has them");
	const sliced = sliceNet(net, { box: true, has: () => true });
	const text = JSON.stringify(sliced);
	assert.ok(!("yards" in sliced) && !("load" in sliced));
	assert.ok(!text.includes("fix/t-15") && !text.includes("\"steps\"") && !text.includes("integ-1\",\"live\""), "no trace of a train's files");
	assert.equal(sliced.bases.length, 1, "the units are there as before");
});

test("a remote turn's board_read shows the work board only, never a trainboard", async () => {
	const dir = trainState(), boards = mkdtempSync(join(tmpdir(), "sb-yardnet-board-"));
	dirs.push(boards);
	const net = { sessions, ps: panes.map((p) => ({ ...p, cwd: "/p" })) as unknown as Pane[] };
	for (const scope of [undefined, { teams: ["t"], project: "/p" }]) {
		const out = JSON.stringify(await readBoard({ dir: boards, now: NOW, net, link: { boards: async () => [], remoteScope: () => scope }, scope: "all" }));
		assert.ok(!out.includes(M) && !out.includes("fix/t-15") && !out.includes("yards"), `scope ${JSON.stringify(scope)}`);
	}
	assert.ok(readdirSync(join(dir, "trainboard")).length > 0);
});

/** The `.ts` files under `src`, by path relative to it. */
function sources(dir: string, base = dir): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name), base) : e.name.endsWith(".ts") ? [relative(base, join(dir, e.name))] : []));
}
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// server/main.ts only hands the GUI host the test seams of the reading (the load, the clock, the writer check); it reads and carries no yard.
// server/watchops.ts and server/autowatch.ts are the auto watch (issue #16): a reading of the net of its own, whose stuck trains and landed cars go into the notice the head tower of this computer gets; the head forwards to this computer's towers only.
test("only the net, the GUI host and the reader name the yards: the code that builds the board message, a remote turn's reading and the operate wire never mention them", () => {
	const mention = /\.yards\b|\byards\??:|\btrainyard|yardview|readYards|\bYards\b/;
	const holders = sources(SRC).filter((f) => mention.test(readFileSync(join(SRC, f), "utf8")));
	assert.deepEqual(holders.sort(), ["net.ts", "server/autowatch.ts", "server/guihost.ts", "server/main.ts", "server/trainyard.ts", "server/watchops.ts", "train/yardview.ts"], "a new place that reads or carries the yards must be added here on purpose");
	for (const f of sources(SRC).filter((f) => f.startsWith("link/") || ["boardread.ts", "board.ts", "boardauto.ts", "server/towerbrief.ts", "server/runtools.ts", "operateslice.ts", "operateroutes.ts", "remote.ts"].includes(f) || f.startsWith("server/operate")))
		assert.ok(!mention.test(readFileSync(join(SRC, f), "utf8")), `${f} must not know the yards`);
});
