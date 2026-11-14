import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { run } from "../src/server/cli.ts";
import { carRepos } from "../src/train/appsconfig.ts";
import { cleanup, git, handoffOf, MANIFEST_HEADER, type Reply, rig, type Rig, slipBlock } from "./train-guard-rig.ts";
import { CODE, result, sb } from "./train-fixtures.ts";

// 0.80.1: an app that is a git submodule of its project (moldplan-center's apps/moldplan-frontend-2). The commits of its cars are in the submodule's repository, not in the project's, so what the train code asks git about a car's
// commits (a delta's `on.head` is an ancestor of the car's head) has to be asked in the app's own checkout. Every case builds a real project with a real submodule and goes through the real guard and the real `train check`, with real git.

afterEach(cleanup);
const APPS = JSON.stringify({ apps: [
	{ name: "web", dir: "apps/web", integration: { base: "develop", stages: ["merge"], accept: ["e2e"] } },
	{ name: "api", dir: "services/api", integration: { base: "main", stages: ["merge"], accept: ["e2e"] } },
	{ name: "site", dir: ".", integration: { base: "main", stages: ["merge"], accept: ["e2e"] } },
] });
const ok = async (promise: Promise<Reply>) => { const reply = await promise; assert.equal(reply.ok, true, reply.reason ?? ""); };
const refused = async (promise: Promise<Reply>, pattern: RegExp) => { const reply = await promise; assert.equal(reply.ok, false, "the call was blocked"); assert.match(reply.reason!, pattern); };

interface Project { /** The submodule's commits: `base` is an ancestor of `head`, `side` is not. */ web: { dir: string; base: string; head: string; side: string }; /** The project's own commits: `first` is an ancestor of `tip`. */ own: { first: string; tip: string } }
/** A project in the rig's work folder: two commits of its own, a plain folder `services/api`, and the submodule `apps/web` added from a repository beside it. */
function project(r: Rig): Project {
	const origin = join(r.root, "web-origin");
	const commit = (cwd: string, name: string) => (writeFileSync(join(cwd, name), name), git(cwd, "add", name), git(cwd, "commit", "-qm", name), git(cwd, "rev-parse", "HEAD"));
	mkdirSync(origin);
	git(origin, "init", "-q", "-b", "develop");
	const base = commit(origin, "one");
	git(origin, "checkout", "-q", "-b", "side");
	const side = commit(origin, "aside");
	git(origin, "checkout", "-q", "develop");
	const head = commit(origin, "two");
	git(r.cwd, "init", "-q", "-b", "main");
	mkdirSync(join(r.cwd, "services", "api"), { recursive: true });
	writeFileSync(join(r.cwd, "services", "api", "main.txt"), "api");
	git(r.cwd, "add", ".");
	git(r.cwd, "commit", "-qm", "project");
	const first = git(r.cwd, "rev-parse", "HEAD");
	git(r.cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "apps/web");
	git(r.cwd, "commit", "-qm", "the web app, a submodule");
	const web = join(r.cwd, "apps", "web");
	assert.match(readFileSync(join(web, ".git"), "utf8"), /^gitdir: /, "the app's checkout is a submodule: its .git is a file naming the git dir inside the project's");
	return { web: { dir: web, base, head, side }, own: { first, tip: git(r.cwd, "rev-parse", "HEAD") } };
}
/** An evidence file of a car of `app` at `head` whose one entry was accepted on `on`, with the delta since. */
function evidenceFile(r: Rig, name: string, app: string, head: string, on: string): string {
	const log = join(r.root, "e2e.log"), delta = join(r.root, "delta.md"), file = join(r.root, `${name}.json`);
	writeFileSync(log, "ok");
	writeFileSync(delta, "what changed since the accepted head");
	writeFileSync(file, JSON.stringify({ v: 1, car: { app, tickets: ["T-15"], branch: "fix/t-15", head }, accepted: [{ kind: "e2e", what: "checkout flow, browser run", on: { head: on }, delta, result: "passed", evidence: log, at: "2026-11-07T07:10:00Z", nod: "looks right, go" }] }));
	return file;
}
const trainTodo = (app: string, head: string, accept: string, code = CODE) => ({ v: 1, project: "acme", app, train: code, kind: "train", spec: { cars: [{ tickets: ["T-15"], branch: "fix/t-15", head, coordinator: "sess-coord-1", departs: "next", accept }] } });
const yardOf = (r: Rig) => JSON.parse(readFileSync(r.yardFile, "utf8")) as { trains: { code: string; cars: { accepted?: string[]; unverified?: true }[] }[] };

test("the integrator's train todo takes a submodule app's car whose delta names an ancestor of its head: git is asked in the app's own checkout, not in the project's root", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	await ok(r.create(trainTodo("web", p.web.head, evidenceFile(r, "good", "web", p.web.head, p.web.base))));
	await refused(r.create(trainTodo("web", p.web.head, evidenceFile(r, "side", "web", p.web.head, p.web.side))), /^sb: evidence entry 1: on\.head is not the car's head$/);
	// The project's own commits are not the app's: the same pair that passes for an app of the project's repository is refused for the submodule app.
	await refused(r.create(trainTodo("web", p.own.tip, evidenceFile(r, "own", "web", p.own.tip, p.own.first))), /^sb: evidence entry 1: on\.head is not the car's head$/);
	assert.equal(r.list.tasks.length, 1);
});

test("the yard shows a submodule app's delta car as accepted, from the same reading in the app's checkout", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	await ok(r.create(trainTodo("web", p.web.head, evidenceFile(r, "good", "web", p.web.head, p.web.base))));
	assert.deepEqual(yardOf(r).trains[0]!.cars[0]!.accepted, ["e2e"]);
	assert.equal(yardOf(r).trains[0]!.cars[0]!.unverified, undefined);
});

test("an app in the project's own repository is checked where it was: at the root (dir .) and in a plain folder, with the project's commits", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	for (const [app, code] of [["site", "2026-11-06-n"], ["api", "2026-11-06-o"]] as const) {
		assert.deepEqual(carRepos(r.cwd, app), [r.cwd], `${app} is no repository of its own`);
		await ok(r.create(trainTodo(app, p.own.tip, evidenceFile(r, `${app}-good`, app, p.own.tip, p.own.first), code)));
		await refused(r.create(trainTodo(app, p.own.first, evidenceFile(r, `${app}-back`, app, p.own.first, p.own.tip))), /on\.head is not the car's head/);
		await refused(r.create(trainTodo(app, p.web.head, evidenceFile(r, `${app}-web`, app, p.web.head, p.web.base))), /on\.head is not the car's head/);
	}
	assert.deepEqual(yardOf(r).trains.map((t) => t.cars[0]!.accepted), [["e2e"], ["e2e"]]);
});

test("a train's board shows a submodule app's delta car as accepted, and its git check passes in the app's checkout", async () => {
	const r = rig({ apps: APPS }), p = project(r);
	const file = evidenceFile(r, "good", "web", p.web.head, p.web.base);
	r.entries.push({ type: "custom_message", customType: "straw-tower", content: handoffOf([MANIFEST_HEADER, slipBlock({ head: p.web.head, accept: file }), ""].join("\n")), timestamp: r.iso() });
	const id = await r.begin(sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: p.web.dir, contains: [p.web.base] }, on: { head: p.web.head }, cars: ["T-15"] }));
	const board = JSON.parse(readFileSync(r.boardFile, "utf8")) as { cars: { accepted?: string[]; unverified?: true }[] };
	assert.deepEqual(board.cars[0]!.accepted, ["e2e"]);
	assert.equal(board.cars[0]!.unverified, undefined);
	// A step's git check names its own folder (`check.cwd`): the app's checkout answers for the app's commits, and the project's root does not hold them.
	await ok(r.complete(id, result({ head: p.web.head })));
	const atRoot = await r.begin(sb({ kind: "assemble", name: "at the root", round: 2 }, { check: { type: "git", cwd: r.cwd, contains: [p.web.base] }, on: { head: p.own.tip } }));
	await refused(r.complete(atRoot, result({ head: p.own.tip })), /git check: [0-9a-f]{12} is not an ancestor of HEAD/);
});

test("train check --accept in the project's root, and in a linked worktree of the project where the submodule is not checked out, asks the submodule app's repository", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	const slipFile = (name: string, over: Record<string, string>) => (writeFileSync(join(r.root, `${name}.txt`), slipBlock(over)), join(r.root, `${name}.txt`));
	const go = async (cwd: string, accept: string, slip: string) => {
		const out: string[] = [];
		const code = await run(["train", "check", "--accept", accept, "--slip", slip], { out: (t) => out.push(t), err: () => {}, stateDir: r.stateDir, train: { cwd } });
		return { code, ...(JSON.parse(out.join("")) as { ok: boolean; refusals: string[] }) };
	};
	const good = evidenceFile(r, "good", "web", p.web.head, p.web.base), side = evidenceFile(r, "side", "web", p.web.head, p.web.side);
	assert.deepEqual(await go(r.cwd, good, slipFile("slip-good", { head: p.web.head, accept: good })), { code: 0, ok: true, refusals: [] });
	assert.deepEqual(await go(r.cwd, side, slipFile("slip-side", { head: p.web.head, accept: side })), { code: 2, ok: false, refusals: ["sb: evidence entry 1: on.head is not the car's head"] });
	const site = evidenceFile(r, "site", "site", p.own.tip, p.own.first);
	assert.deepEqual(await go(r.cwd, site, slipFile("slip-site", { car: "site", head: p.own.tip, accept: site })), { code: 0, ok: true, refusals: [] }, "an app of the project's repository, as before");
	// A linked worktree of the project (its apps.json is tracked): apps/web is an empty folder there, so the app's repository is the main checkout's.
	const wt = join(r.root, "wt");
	git(r.cwd, "worktree", "add", "-q", wt, "-b", "coord");
	assert.deepEqual(carRepos(wt, "web"), [realpathSync(p.web.dir)]);
	assert.deepEqual(carRepos(r.cwd, "web"), [realpathSync(p.web.dir)]);
	assert.deepEqual(await go(wt, good, slipFile("slip-wt", { head: p.web.head, accept: good })), { code: 0, ok: true, refusals: [] });
	assert.equal((await go(wt, side, slipFile("slip-wt-side", { head: p.web.head, accept: side }))).code, 2);
});

test("carRepos names no folder outside the project's root, and only the folder asked before for an app the file does not name or gives no dir", () => {
	const r = rig({ main: true, train: false, apps: JSON.stringify({ apps: [{ name: "out", dir: "../web-origin", integration: { base: "develop" } }, { name: "abs", dir: join("/", "tmp"), integration: { base: "develop" } }, { name: "nodir", integration: { base: "develop" } }] }) });
	mkdirSync(join(r.root, "web-origin"));
	git(join(r.root, "web-origin"), "init", "-q");
	git(r.cwd, "init", "-q");
	for (const app of ["out", "abs", "nodir", "unnamed", undefined]) assert.deepEqual(carRepos(r.cwd, app, "/before"), ["/before"], String(app));
});
