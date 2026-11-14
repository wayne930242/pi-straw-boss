import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
	// RD0801-F003: the worktree checks the submodule out itself. Its git dir is under the repository's `.git/worktrees/<name>/modules`, and both checkouts of the app answer.
	git(wt, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
	assert.match(readFileSync(join(wt, "apps", "web", ".git"), "utf8"), /^gitdir: .*\/worktrees\/wt\/modules\/apps\/web\s*$/);
	assert.deepEqual(carRepos(wt, "web"), [realpathSync(join(wt, "apps", "web")), realpathSync(p.web.dir)]);
	assert.deepEqual(await go(wt, good, slipFile("slip-wt-own", { head: p.web.head, accept: good })), { code: 0, ok: true, refusals: [] });
});

test("RD0801-F001: a project whose own git dir is outside its folder (a submodule of another repository, a clone with --separate-git-dir) still has its submodule app answer", () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	// The project as a submodule of another repository: the app's git dir is under `<super>/.git/modules/proj/modules`, outside the project's folder and inside its git dir.
	const above = join(r.root, "super"), inSuper = join(above, "proj");
	mkdirSync(above);
	git(above, "init", "-q", "-b", "main");
	git(above, "-c", "protocol.file.allow=always", "submodule", "add", "-q", r.cwd, "proj");
	git(inSuper, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
	assert.match(readFileSync(join(inSuper, "apps", "web", ".git"), "utf8"), /^gitdir: .*\/modules\/proj\/modules\/apps\/web\s*$/);
	assert.deepEqual(carRepos(inSuper, "web", "/before"), [realpathSync(join(inSuper, "apps", "web"))]);
	assert.deepEqual(carRepos(inSuper, "api", "/before"), ["/before"], "a plain folder of that project is still the project's");
	// A clone that keeps its git dir elsewhere: the app's git dir is under that one.
	const apart = join(r.root, "apart"), gitDir = join(r.root, "apart-git");
	git(r.root, "clone", "-q", "--separate-git-dir", gitDir, r.cwd, apart);
	git(apart, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
	assert.equal(readFileSync(join(apart, "apps", "web", ".git"), "utf8").trim(), "gitdir: ../../../apart-git/modules/apps/web");
	assert.deepEqual(carRepos(apart, "web", "/before"), [realpathSync(join(apart, "apps", "web"))]);
	assert.equal(git(carRepos(apart, "web")[0]!, "rev-parse", "HEAD"), p.web.head, "git answers there with the app's commits");
});

test("R0801-F002: an app whose dir is a folder inside a submodule is asked in that submodule, the nearest repository above it; a folder inside a plain folder stays the project's", async () => {
	const apps = JSON.stringify({ apps: [...(JSON.parse(APPS) as { apps: unknown[] }).apps, { name: "pkg", dir: "apps/web/packages/ui", integration: { base: "develop", stages: ["merge"], accept: ["e2e"] } }, { name: "deep", dir: "services/api/src", integration: { base: "main", stages: ["merge"], accept: ["e2e"] } }] });
	const r = rig({ main: true, train: false, apps }), p = project(r);
	mkdirSync(join(p.web.dir, "packages", "ui"), { recursive: true });
	mkdirSync(join(r.cwd, "services", "api", "src"));
	assert.deepEqual(carRepos(r.cwd, "pkg", "/before"), [realpathSync(p.web.dir)]);
	assert.deepEqual(carRepos(r.cwd, "deep", "/before"), ["/before"]);
	await ok(r.create(trainTodo("pkg", p.web.head, evidenceFile(r, "good", "pkg", p.web.head, p.web.base))));
	await refused(r.create(trainTodo("pkg", p.web.head, evidenceFile(r, "side", "pkg", p.web.head, p.web.side))), /^sb: evidence entry 1: on\.head is not the car's head$/);
});

test("RD0801-F002: a replace ref in the app's repository does not make a commit an ancestor: the guard and train check ask git with replace refs off", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	// The graft gives the car's head the side commit as its parent; with replace refs read, git answers that `side` is an ancestor of the head.
	git(p.web.dir, "replace", "--graft", p.web.head, p.web.side);
	assert.doesNotThrow(() => git(p.web.dir, "merge-base", "--is-ancestor", p.web.side, p.web.head), "the graft is in place");
	const side = evidenceFile(r, "side", "web", p.web.head, p.web.side);
	await refused(r.create(trainTodo("web", p.web.head, side)), /^sb: evidence entry 1: on\.head is not the car's head$/);
	const slip = join(r.root, "slip.txt"), out: string[] = [];
	writeFileSync(slip, slipBlock({ head: p.web.head, accept: side }));
	assert.equal(await run(["train", "check", "--accept", side, "--slip", slip], { out: (t) => out.push(t), err: () => {}, stateDir: r.stateDir, train: { cwd: r.cwd } }), 2);
	assert.deepEqual((JSON.parse(out.join("")) as { refusals: string[] }).refusals, ["sb: evidence entry 1: on.head is not the car's head"]);
	await ok(r.create(trainTodo("web", p.web.head, evidenceFile(r, "good", "web", p.web.head, p.web.base))));
});

test("carRepos names no folder outside the project's root, and only the folder asked before for an app the file does not name or gives no dir", () => {
	const r = rig({ main: true, train: false, apps: JSON.stringify({ apps: [{ name: "out", dir: "../web-origin", integration: { base: "develop" } }, { name: "abs", dir: join("/", "tmp"), integration: { base: "develop" } }, { name: "nodir", integration: { base: "develop" } }, { name: "link", dir: "apps/link", integration: { base: "develop" } }, { name: "ptr", dir: "apps/ptr", integration: { base: "develop" } }] }) });
	mkdirSync(join(r.root, "web-origin"));
	git(join(r.root, "web-origin"), "init", "-q");
	git(r.cwd, "init", "-q");
	// R0801-F001/F003: a symlink out of the project, and a folder whose `.git` file points at a repository outside it.
	mkdirSync(join(r.cwd, "apps", "ptr"), { recursive: true });
	symlinkSync(join(r.root, "web-origin"), join(r.cwd, "apps", "link"));
	writeFileSync(join(r.cwd, "apps", "ptr", ".git"), `gitdir: ${join(r.root, "web-origin", ".git")}\n`);
	for (const app of ["out", "abs", "nodir", "link", "ptr", "unnamed", undefined]) assert.deepEqual(carRepos(r.cwd, app, "/before"), ["/before"], String(app));
});

test("RD0801-F002: a `.git` that is a symlink out of the project, a git dir outside it, and a git dir whose commondir leads out of it are not used; the same pointer with a common dir inside the project is, and so is a clone inside it", () => {
	const named = (name: string) => ({ name, dir: `apps/${name}`, integration: { base: "develop" } });
	const r = rig({ main: true, train: false, apps: JSON.stringify({ apps: ["dotlink", "chain", "away", "kept", "clone"].map(named) }) });
	const outside = join(r.root, "web-origin"), app = (name: string) => (mkdirSync(join(r.cwd, "apps", name), { recursive: true }), join(r.cwd, "apps", name));
	mkdirSync(outside);
	git(outside, "init", "-q");
	git(r.cwd, "init", "-q");
	// `.git` is a symlink to the git dir of a repository outside: git would read that repository in the app's folder.
	symlinkSync(join(outside, ".git"), join(app("dotlink"), ".git"));
	// A git dir of plain files inside the project (a commit can carry them) whose `commondir` names the outside repository's: git reads its objects and refs there.
	const gitDirOf = (folder: string, common: string) => { mkdirSync(join(r.cwd, folder)); writeFileSync(join(r.cwd, folder, "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(r.cwd, folder, "commondir"), `${common}\n`); };
	gitDirOf("fake", join(outside, ".git"));
	writeFileSync(join(app("chain"), ".git"), "gitdir: ../../fake\n");
	// A git dir outside the project that names the project's own as its common dir: git still reads that folder's HEAD and configuration.
	mkdirSync(join(r.root, "away"));
	writeFileSync(join(r.root, "away", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(r.root, "away", "commondir"), `${join(r.cwd, ".git")}\n`);
	writeFileSync(join(app("away"), ".git"), `gitdir: ${join(r.root, "away")}\n`);
	git(app("clone"), "init", "-q");
	gitDirOf("held", "../apps/clone/.git");
	writeFileSync(join(app("kept"), ".git"), "gitdir: ../../held\n");
	for (const name of ["dotlink", "chain", "away"]) assert.deepEqual(carRepos(r.cwd, name, "/before"), ["/before"], name);
	for (const name of ["kept", "clone"]) assert.deepEqual(carRepos(r.cwd, name, "/before"), [join(r.cwd, "apps", name)], name);
});

test("R0802-F004: a `.git` that is no git dir, and a git dir whose common dir is the project's own (a linked worktree of the project inside it), are no repository of the app's own: its commits and its remote are the project's", () => {
	const named = (name: string, dir = `apps/${name}`) => ({ name, dir, integration: { base: "develop" } });
	const r = rig({ main: true, train: false, apps: JSON.stringify({ apps: [named("junk"), named("nest", "apps/nestwt/sub"), named("ptr")] }) });
	git(r.cwd, "init", "-q", "-b", "main");
	git(r.cwd, "commit", "-q", "--allow-empty", "-m", "project");
	// An empty `.git` folder: git walks past it and answers with the project's repository.
	mkdirSync(join(r.cwd, "apps", "junk", ".git"), { recursive: true });
	git(r.cwd, "worktree", "add", "-q", join(r.cwd, "apps", "nestwt"), "-b", "nested");
	mkdirSync(join(r.cwd, "apps", "nestwt", "sub"));
	assert.match(readFileSync(join(r.cwd, "apps", "nestwt", ".git"), "utf8"), /^gitdir: .*\/\.git\/worktrees\/nestwt\s*$/);
	// A git dir of plain files with a `HEAD`, whose `commondir` names the project's own.
	mkdirSync(join(r.cwd, "held"));
	writeFileSync(join(r.cwd, "held", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(r.cwd, "held", "commondir"), "../.git\n");
	mkdirSync(join(r.cwd, "apps", "ptr"));
	writeFileSync(join(r.cwd, "apps", "ptr", ".git"), "gitdir: ../../held\n");
	for (const name of ["junk", "nest", "ptr"]) assert.deepEqual(carRepos(r.cwd, name, "/before"), ["/before"], name);
});

test("R0802-F003: a graft file in the app's repository does not make a commit an ancestor: the guard and train check ask git with no graft file", async () => {
	const r = rig({ main: true, train: false, apps: APPS }), p = project(r);
	// `info/grafts` gives the car's head the side commit as a second parent; `--no-replace-objects` does not turn it off.
	const gitDir = git(p.web.dir, "rev-parse", "--absolute-git-dir");
	mkdirSync(join(gitDir, "info"), { recursive: true });
	writeFileSync(join(gitDir, "info", "grafts"), `${p.web.head} ${p.web.base} ${p.web.side}\n`);
	assert.doesNotThrow(() => git(p.web.dir, "--no-replace-objects", "merge-base", "--is-ancestor", p.web.side, p.web.head), "the graft is in place");
	const side = evidenceFile(r, "side", "web", p.web.head, p.web.side);
	await refused(r.create(trainTodo("web", p.web.head, side)), /^sb: evidence entry 1: on\.head is not the car's head$/);
	const slip = join(r.root, "slip.txt"), out: string[] = [];
	writeFileSync(slip, slipBlock({ head: p.web.head, accept: side }));
	assert.equal(await run(["train", "check", "--accept", side, "--slip", slip], { out: (t) => out.push(t), err: () => {}, stateDir: r.stateDir, train: { cwd: r.cwd } }), 2);
	assert.deepEqual((JSON.parse(out.join("")) as { refusals: string[] }).refusals, ["sb: evidence entry 1: on.head is not the car's head"]);
	await ok(r.create(trainTodo("web", p.web.head, evidenceFile(r, "good", "web", p.web.head, p.web.base))));
});
