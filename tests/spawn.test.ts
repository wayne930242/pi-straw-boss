import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	assert.deepEqual(await listDirs(home, home), { path: home, home, parent: null, dirs: ["beta", "projects", "work"], truncated: false });
	assert.deepEqual((await listDirs(join(home, "projects"), home)).parent, home);
	assert.equal(await pickable(join(home, "work"), home), join(home, "projects"), "a symlink resolves to where it leads");
	for (const refused of [join(home, ".secret"), join(home, ".secret", "keys"), join(home, "hidden-link"), join(home, "out-link"), outside, scratch, "/", join(home, "notes.txt"), join(home, "missing"), "projects", join(home, "..")])
		assert.equal(await pickable(refused, home), undefined, refused);
});

async function gui() {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const call = async (method: string, params: Record<string, unknown>) => void calls.push({ method, params });
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
	assert.deepEqual((await post("dirs", { path: join(home, "beta") })).body, { path: join(home, "beta"), home, parent: home, dirs: [], truncated: false });
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

test("a base with a tower takes a new main in an unfocused tab of the picked folder, which promotes itself, and no member", async () => {
	world.autoMains();
	const { post, calls } = await gui();
	tower();
	const dir = join(home, "projects", "alpha");
	const answer = await post("open/main", { workspace: "wA", dir, prompt: "Read the README" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "alpha", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	const pane = answer.body.pane as string;
	assert.equal(world.herdr.pane(pane).tokens.sb_role, "main");
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
