import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, test } from "node:test";
import { readRecord } from "../src/handover.ts";
import { listDirs, pickable } from "../src/spawn.ts";
import { until, World } from "./fakes.ts";

// The opening API (spawn.ts): a folder picker held inside home, a new base with its first member, a new member in a base without a tower, and a new
// main in a base with one, through a GUI a session started. The page never opens a tower: a member that promotes itself does.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-spawn-test-")));
const home = join(scratch, "home"), outside = join(scratch, "outside"), bundle = join(scratch, "bundle");
for (const dir of [join(home, "projects", "alpha"), join(home, "beta"), join(home, ".secret", "keys"), outside, bundle]) mkdirSync(dir, { recursive: true });
writeFileSync(join(home, "notes.txt"), "");
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");
symlinkSync(join(home, "projects"), join(home, "work"));
symlinkSync(join(home, ".secret"), join(home, "hidden-link"));
symlinkSync(outside, join(home, "out-link"));
const realHome = process.env.HOME;
process.env.HOME = home; // createSpawn reads the home folder from os.homedir(), which follows HOME
process.on("exit", () => ((process.env.HOME = realHome), rmSync(scratch, { recursive: true, force: true })));

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

test("the picker lists only visible folders inside home, follows a symlink only to a pickable folder, and refuses any other path", async () => {
	assert.deepEqual(await listDirs(home, home), { path: home, home, sep, parent: null, dirs: ["beta", "projects", "work"], truncated: false });
	assert.deepEqual((await listDirs(join(home, "projects"), home)).parent, home);
	assert.equal(await pickable(join(home, "work"), home), join(home, "projects"), "a symlink resolves to where it leads");
	for (const refused of [join(home, ".secret"), join(home, ".secret", "keys"), join(home, "hidden-link"), join(home, "out-link"), outside, scratch, "/", join(home, "notes.txt"), join(home, "missing"), "projects", join(home, "..")])
		assert.equal(await pickable(refused, home), undefined, refused);
});

async function gui(hook?: (method: string) => Promise<void>) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const call = async (method: string, params: Record<string, unknown>) => (calls.push({ method, params }), void (await hook?.(method)));
	const viewer = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps: { bundle, call, openUrl: async () => {} } });
	await viewer.start();
	await viewer.command("gui");
	const r = readRecord(world.stateDir)!;
	const post = (path: string, body: Record<string, unknown>) =>
		new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
			const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, "content-type": "application/json", "x-sb-csrf": r.csrf! } }, (res) => {
				let text = "";
				res.on("data", (c) => (text += c)).on("end", () => done({ status: res.statusCode!, body: JSON.parse(text) }));
			});
			req.on("error", fail).end(JSON.stringify(body));
		});
	return { post, calls };
}

test("the picker starts in the base's own folder, and in home when that folder is not pickable", async () => {
	const { post } = await gui();
	world.herdr.workspace("wA").worktree = { checkout_path: join(home, "projects", "alpha") };
	assert.equal((await post("dirs", { workspace: "wA" })).body.path, join(home, "projects", "alpha"));
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha" };
	assert.equal((await post("dirs", { workspace: "wA" })).body.path, home);
	assert.deepEqual((await post("dirs", { path: join(home, "beta") })).body, { path: join(home, "beta"), home, sep, parent: home, dirs: [], truncated: false });
	assert.deepEqual([(await post("dirs", { path: outside })).status, (await post("dirs", { path: join(home, ".secret") })).body.error], [400, "not_allowed"]);
});

/** Gives wA a live tower: the viewer's own session stands in for it. */
const tower = () => (world.herdr.workspace("wA").tokens.tower = "viewer-a");

test("a new base opens as a workspace in the picked folder with one member and no tower, and gets the first message typed in", async () => {
	world.autoMains();
	const { post, calls } = await gui();
	const dir = join(home, "beta");
	const answer = await post("open/base", { dir, label: "", prompt: "Look around" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(world.herdr.commands("workspace", "create"), [["workspace", "create", "--cwd", dir, "--label", "beta", "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]]);
	const ws = answer.body.workspace as string, pane = answer.body.pane as string;
	assert.deepEqual(world.herdr.panes.filter((p) => p.workspace_id === ws).map((p) => [p.pane_id, p.tokens.sb_role]), [[pane, "member"]]);
	assert.equal(world.herdr.workspace(ws).tokens.tower, undefined, "no tower opens with the base");
	assert.deepEqual(world.herdr.commands("tab", "create"), [], "no tower tab either");
	assert.deepEqual(calls.filter((c) => c.method === "agent.prompt"), [{ method: "agent.prompt", params: { target: pane, text: "Look around" } }]);
	assert.deepEqual((await post("open/base", { dir, label: "x".repeat(65) })).body.error, "bad_request");
	assert.equal((await post("open/tower", { dir, label: "" })).status, 404, "the page cannot open a tower");
});

test("a base without a tower takes a member beside a tab's main in its folder, or in a new tab in the picked folder, and no main", async () => {
	world.autoMains();
	const { post } = await gui();
	const dir = join(home, "projects", "alpha");
	world.herdr.addPane("wA:p7", "wA:t2", "shell");
	world.herdr.addPane("wA:p8", "wA:t2");
	Object.assign(world.herdr.pane("wA:p8"), { cwd: dir, tokens: { sb_role: "main" } });
	assert.equal((await post("dirs", { workspace: "wA", tab: "wA:t2" })).body.path, dir, "the picker starts in the squad's folder");
	assert.equal((await post("open/member", { workspace: "wA", tab: "wA:t2", dir: outside })).body.error, "not_allowed");
	const beside = await post("open/member", { workspace: "wA", tab: "wA:t2", prompt: "" });
	assert.equal(beside.status, 200, JSON.stringify(beside.body));
	assert.deepEqual(world.herdr.commands("pane", "split"), [["pane", "split", "wA:p8", "--direction", "right", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]], "without a pick, the main's folder");
	assert.deepEqual([beside.body.tab, world.herdr.pane(beside.body.pane as string).tokens.sb_role], ["wA:t2", "member"]);
	const picked = await post("open/member", { workspace: "wA", tab: "wA:t2", dir: join(home, "beta") });
	assert.equal(picked.status, 200, JSON.stringify(picked.body));
	assert.equal(world.herdr.commands("pane", "split").at(-1)![6], join(home, "beta"), "a picked folder is used in the squad");
	const fresh = await post("open/member", { workspace: "wA", dir: join(home, "beta") });
	assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "beta", "--cwd", join(home, "beta"), "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]]);
	assert.equal(world.herdr.pane(fresh.body.pane as string).tokens.sb_role, "member");
	assert.deepEqual([(await post("open/main", { workspace: "wA", dir })).status, (await post("open/main", { workspace: "wA", dir })).body.error], [409, "no_tower"]);
	assert.equal((await post("open/member", { workspace: "wA", tab: "wA:t99" })).status, 404);
});

test("a base with a tower takes a new main in an unfocused tab of the picked folder, which promotes itself and is named in the answer, and no member", async () => {
	world.autoMains();
	const { post, calls } = await gui();
	tower();
	const dir = join(home, "projects", "alpha");
	const answer = await post("open/main", { workspace: "wA", dir, prompt: "Read the README" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "alpha", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	const pane = answer.body.pane as string;
	assert.equal(world.herdr.pane(pane).tokens.sb_role, "main");
	assert.equal(answer.body.session, `opened-${pane}`, "the answer names the new session, so the page goes to it");
	assert.deepEqual(world.herdr.commands("agent", "start")[0]?.slice(-2), ["--name", "main · alpha"]);
	assert.deepEqual(calls.filter((c) => c.method === "agent.prompt"), [{ method: "agent.prompt", params: { target: pane, text: "Read the README" } }]);
	const empty = await post("open/main", { workspace: "wA", dir: join(home, "beta"), prompt: "  " });
	assert.equal(empty.status, 200);
	assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1, "a blank first message types nothing");
	assert.equal((await post("open/member", { workspace: "wA", dir })).body.error, "has_tower");
	world.herdr.workspace("wA").tokens.tower = "gone-tower";
	assert.equal((await post("open/member", { workspace: "wA", dir })).status, 200, "a token its tower left behind is no tower");
});

test("an opening is refused outside home or for a missing base, and one that fails closes what it created", async () => {
	const { post } = await gui();
	assert.equal((await post("open/member", { workspace: "wA", dir: outside })).body.error, "not_allowed");
	assert.equal((await post("open/base", { dir: join(home, ".secret") })).body.error, "not_allowed");
	assert.equal((await post("open/member", { workspace: "wZ", dir: home })).status, 404);
	world.herdr.busy = 99; // every agent start fails: nothing new ever gets its pi
	const failed = await post("open/member", { workspace: "wA", dir: home });
	assert.deepEqual([failed.status, failed.body.error], [502, "open_failed"]);
	const created = world.herdr.commands("tab", "create").at(-1)!;
	await until(() => world.herdr.closed.length > 0, "the tab closed");
	assert.equal(world.herdr.tabs.some((t) => t.label === "home" || t.tab_id === created[2]), false);
	world.herdr.addPane("wA:p7", "wA:t2", "shell");
	assert.equal((await post("open/member", { workspace: "wA", tab: "wA:t2" })).status, 502);
	assert.deepEqual(world.herdr.panes.filter((p) => p.tab_id === "wA:t2").map((p) => p.pane_id), ["wA:p7"], "the split pane is closed again");
	const base = await post("open/base", { dir: home, label: "Home" });
	assert.equal(base.status, 502);
	assert.deepEqual(world.herdr.workspaces.map((w) => w.workspace_id).filter((id) => !["wA", "wB"].includes(id)), [], "the workspace it created is closed again: no base is left empty");
});

test("an opening reports its progress step by step while it runs, only the steps it has, and names the step that failed", async () => {
	world.autoMains();
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	const { post } = await gui(async (method) => void (method === "agent.prompt" && (await gate)));
	const steps = async (id: string) => ((await post("open/progress", { id })).body as { steps?: { id: string; state: string }[] }).steps?.map((s) => `${s.id}:${s.state}`) ?? [];
	const dir = join(home, "projects", "alpha");
	const running = post("open/base", { dir, label: "Alpha", prompt: "Hello", deploy: "deploy-aaaa-1" });
	await until(async () => (await steps("deploy-aaaa-1")).includes("deliver:active"), "the first message is being delivered");
	assert.deepEqual(await steps("deploy-aaaa-1"), ["create:done", "start:done", "join:done", "deliver:active"]);
	release();
	assert.equal((await running).status, 200);
	const done = (await post("open/progress", { id: "deploy-aaaa-1" })).body as { finished: boolean; steps: { state: string }[]; failed?: unknown };
	assert.deepEqual([done.finished, done.steps.map((s) => s.state), done.failed], [true, ["done", "done", "done", "done"], undefined]);
	assert.equal((await post("open/base", { dir, label: "Plain", deploy: "deploy-aaaa-2" })).status, 200);
	assert.deepEqual(await steps("deploy-aaaa-2"), ["create:done", "start:done", "join:done"], "no first message, no delivery step");
	world.herdr.busy = 99; // pi never starts
	const failed = await post("open/member", { workspace: "wA", dir: home, deploy: "deploy-aaaa-3" });
	assert.deepEqual([failed.status, failed.body.step], [502, "start"], "the refusal names the step");
	const seen = (await post("open/progress", { id: "deploy-aaaa-3" })).body as { finished: boolean; failed: { step: string; reason: string } };
	assert.equal(seen.finished, false);
	assert.deepEqual([seen.failed.step, seen.failed.reason], ["start", failed.body.reason]);
	assert.deepEqual(await steps("deploy-aaaa-3"), ["create:done", "start:failed", "join:pending"]);
	assert.equal((await post("open/progress", { id: "deploy-nobody" })).status, 404);
	assert.equal((await post("open/base", { dir, deploy: "x" })).body.error, "bad_request", "an id that is too short is refused");
});

test("a first message that does not arrive fails the delivery step, and a refusal before any step fails the first", async () => {
	world.autoMains();
	const { post } = await gui(async (method) => {
		if (method === "agent.prompt") throw new Error("pane gone");
	});
	const lost = await post("open/base", { dir: join(home, "beta"), label: "Beta", prompt: "Hello", deploy: "deploy-bbbb-1" });
	assert.deepEqual([lost.status, lost.body.error, lost.body.step], [502, "prompt_failed", "deliver"]);
	assert.match(String(lost.body.reason), /pane gone/);
	const none = await post("open/member", { workspace: "wZ", dir: home, deploy: "deploy-bbbb-2" });
	assert.deepEqual([none.status, none.body.step], [404, "create"]);
});

test("a new folder is made in a pickable folder under a plain visible name, and one that is already there is answered as it is", async () => {
	const { post } = await gui();
	const parent = join(home, "projects");
	const made = await post("dirs/new", { path: parent, name: "  hello-test2 " });
	assert.deepEqual([made.status, made.body], [200, { path: join(parent, "hello-test2"), created: true }]);
	assert.ok(statSync(join(parent, "hello-test2")).isDirectory());
	const again = await post("dirs/new", { path: parent, name: "hello-test2" });
	assert.deepEqual([again.status, again.body], [200, { path: join(parent, "hello-test2"), created: false }], "an existing folder is simply selected");
	assert.equal((await post("dirs/new", { path: parent, name: "中文專案" })).status, 200, "a CJK name is fine");
	assert.equal((await post("dirs/new", { path: parent, name: "專".repeat(85) })).status, 200, "255 bytes is the limit");
	assert.equal((await post("dirs/new", { path: parent, name: "console" })).status, 200, "a name that only starts like a reserved one is fine");
	const listed = await post("dirs", { path: parent });
	assert.deepEqual((listed.body.dirs as string[]).includes("hello-test2"), true, "the picker lists it");
	for (const name of ["", "   ", "..", ".", "../escape", "a/b", "a\\b", ".hidden", "name.", "bad:name", "q?", "x\u0000y", "x".repeat(300), "專".repeat(86), "con", "NUL.txt", "Com1", "lpt9.log", "a\u200Bb", 7, undefined]) {
		const refused = await post("dirs/new", { path: parent, name });
		assert.deepEqual([refused.status, refused.body.error], [400, "bad_name"], JSON.stringify(name));
	}
	assert.equal(existsSync(join(parent, "escape")) || existsSync(join(home, "escape")), false, "nothing was made outside");
	for (const path of [outside, join(home, ".secret"), join(home, "hidden-link"), join(home, "out-link"), join(home, "missing"), "projects", join(home, ".."), undefined])
		assert.deepEqual([(await post("dirs/new", { path, name: "x" })).status, (await post("dirs/new", { path, name: "x" })).body.error], [400, "not_allowed"], String(path));
	assert.equal(existsSync(join(outside, "x")) || existsSync(join(home, ".secret", "x")), false);
	assert.equal((await post("dirs/new", { path: home, name: "notes.txt" })).body.error, "not_a_folder", "a file of that name is no folder to select");
	symlinkSync(outside, join(home, "projects", "to-outside"));
	assert.equal((await post("dirs/new", { path: parent, name: "to-outside" })).body.error, "not_a_folder", "a link out of home is not followed");
});

test("the places a picker starts from are home, its Desktop and Documents when they are pickable, and the folders the open bases work in", async () => {
	const { post } = await gui();
	const none = await post("dirs/places", {});
	assert.deepEqual([none.body.home, none.body.sep, none.body.places], [home, sep, []]);
	mkdirSync(join(home, "Desktop"));
	mkdirSync(join(home, "Documents"));
	world.herdr.workspace("wA").worktree = { checkout_path: join(home, "projects", "alpha") };
	const some = await post("dirs/places", {});
	assert.deepEqual(some.body.places, [{ name: "Desktop", path: join(home, "Desktop") }, { name: "Documents", path: join(home, "Documents") }]);
	assert.ok((some.body.recent as string[]).includes(join(home, "projects", "alpha")), "a base's own folder is recent");
	assert.ok((some.body.recent as string[]).every((dir) => dir !== home && dir.startsWith(`${home}${sep}`)), "only pickable folders under home");
});

// pi reads <folder>/.pi/settings.json whole at startup, before any extension can stop it (trust/settings.ts): every opening looks first, and a refusal creates nothing.
test("an opening in a folder whose .pi/settings.json pi must not read is refused before anything is created, on every path, and names the file and the reason", async () => {
	world.autoMains();
	const { post, calls } = await gui();
	tower();
	const folderWith = (name: string, make?: (file: string) => void) => {
		const dir = join(home, "unsafe", name);
		mkdirSync(join(dir, ".pi"), { recursive: true });
		make?.(join(dir, ".pi", "settings.json"));
		return dir;
	};
	const small = join(home, "unsafe", "small.json"), big = join(home, "unsafe", "big.json"), pipe = join(home, "unsafe", "pipe");
	mkdirSync(join(home, "unsafe"), { recursive: true });
	writeFileSync(small, "{}");
	writeFileSync(big, "x".repeat(262_145));
	execFileSync("mkfifo", [pipe]);
	const refused: [string, string, (file: string) => void][] = [
		["zero", "special", (f) => symlinkSync("/dev/zero", f)],
		["stdin", "special", (f) => symlinkSync("/dev/stdin", f)],
		["fifo", "special", (f) => execFileSync("mkfifo", [f])],
		["pipe-link", "special", (f) => symlinkSync(pipe, f)],
		["oversize", "large", (f) => writeFileSync(f, "x".repeat(262_145))],
		["oversize-link", "large", (f) => symlinkSync(big, f)],
	];
	const bare = () => [world.herdr.commands("workspace", "create"), world.herdr.commands("tab", "create"), world.herdr.commands("pane", "split"), world.herdr.commands("agent", "start")].flat().length;
	world.herdr.addPane("wA:p7", "wA:t2", "shell");
	world.herdr.addPane("wA:p8", "wA:t2");
	Object.assign(world.herdr.pane("wA:p8"), { cwd: join(home, "beta"), tokens: { sb_role: "main" } });
	let id = 0;
	for (const [name, why, make] of refused) {
		const dir = folderWith(name, make), before = bare();
		for (const [path, body] of [
			["open/base", { dir, label: "X" }],
			["open/main", { workspace: "wA", dir }],
			["open/member", { workspace: "wA", dir }],
			["open/member", { workspace: "wA", tab: "wA:t2", dir }],
		] as const) {
			if (path === "open/main") tower();
			else world.herdr.workspace("wA").tokens.tower = "gone-tower"; // a member needs a base without a tower
			const deploy = `deploy-unsafe-${++id}`, answer = await post(path, { ...body, deploy });
			assert.deepEqual([answer.status, answer.body.error, answer.body.step], [409, "settings_unsafe", "create"], `${name} ${path}: ${JSON.stringify(answer.body)}`);
			assert.match(String(answer.body.reason), /^pi was not started: .*\.pi\/settings\.json .* try again\.$/, name);
			assert.equal((answer.body.settings as { why: string }).why, why, name);
			const seen = (await post("open/progress", { id: deploy })).body as { failed: { step: string; settings: { path: string } } };
			assert.deepEqual([seen.failed.step, seen.failed.settings.path], ["create", join(dir, ".pi", "settings.json")], "the progress carries the refusal for the page to word");
		}
		assert.equal(bare(), before, `${name}: no workspace, tab, pane, or pi was made`);
	}
	assert.equal(calls.some((c) => c.method === "agent.prompt"), false, "nothing was typed");
	// What is fine still opens: no file, a plain small file, and a link to one.
	for (const make of [undefined, (f: string) => writeFileSync(f, "{}"), (f: string) => symlinkSync(small, f)]) {
		tower();
		assert.equal((await post("open/main", { workspace: "wA", dir: folderWith(`ok${++id}`, make) })).status, 200);
	}
});
