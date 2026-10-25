import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readLinkConfig } from "../src/link/config.ts";
import { inside, nearestTeams, oneTeamEach, projectProblem, resolveDevice, towerFor, type NetView } from "../src/link/routing.ts";

// Where a delivery goes (docs/specs/2026-10-25-straw-link.md, Addressing and delivery): only to a tower whose pane's cwd is inside the team's
// project, the one closest to the project root, then the first in workspace order; and who a `device` argument names (R-F020).

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-link-routing-測試-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const dir = (...p: string[]) => {
	const path = join(root, ...p);
	mkdirSync(path, { recursive: true });
	return path;
};

/** A net of workspaces `w1..` in this order, each with the panes given: [pane id, role token, cwd, session id or null]. */
function net(spec: Record<string, [string, string | undefined, string | undefined, string | null][]>): NetView {
	const workspaces = Object.keys(spec).map((id) => ({ workspace_id: id, label: `label-${id}`, tokens: {} }));
	const panes = Object.entries(spec).flatMap(([ws, list]) => list.map(([pane_id, role, cwd]) => ({ pane_id, tab_id: `${ws}:t`, workspace_id: ws, ...(cwd ? { cwd } : {}), tokens: (role ? { sb_role: role } : {}) as Record<string, string> })));
	const sessions = Object.values(spec).flatMap((list) => list.flatMap(([pane, , , id]) => (id ? [{ id, herdrLocation: { status: "current", paneId: pane } }] : [])));
	return { workspaces, panes, sessions, tabs: [] };
}

test("inside: a directory is inside its project and its subdirectories, not a sibling that shares a prefix, not a parent; symlinks resolve", () => {
	const project = dir("proj"), sub = dir("proj", "apps", "api"), sibling = dir("proj-other");
	assert.ok(inside(project, project));
	assert.ok(inside(sub, project));
	assert.ok(!inside(sibling, project));
	assert.ok(!inside(root, project));
	symlinkSync(sub, join(root, "link-to-sub"));
	assert.ok(inside(join(root, "link-to-sub"), project), "a cwd reached through a symlink is where it really is");
	symlinkSync(sibling, join(project, "escape"));
	assert.ok(!inside(join(project, "escape"), project), "a symlink inside the project that leads out is outside");
	assert.ok(!inside(join(root, "does-not-exist"), project));
	assert.ok(!inside("relative/path", project));
});

test("towerFor takes only a tower whose pane's cwd is inside the project: never a main or a member, never a session that is not live, never a pane without a cwd", () => {
	const project = dir("proj"), elsewhere = dir("elsewhere");
	const view = net({
		w1: [["p1", "main", project, "s-main"], ["p2", "member", project, "s-member"], ["p3", undefined, project, "s-plain"]],
		w2: [["p4", "tower", elsewhere, "s-else"], ["p5", "tower", project, null], ["p6", "tower", undefined, "s-nocwd"]],
	});
	assert.equal(towerFor(view, project), undefined, "none of these is a tower of the project");
	const withTower = net({ w1: [["p1", "main", project, "s-main"]], w2: [["p4", "tower", project, "s-tower"]] });
	const pick = towerFor(withTower, project)!;
	assert.deepEqual([pick.session.id, pick.pane.pane_id, pick.workspace.workspace_id], ["s-tower", "p4", "w2"]);
});

test("with several towers in the project, the one whose cwd is closest to the project root wins, then the first in Herdr's workspace order", () => {
	const project = dir("proj"), deep = dir("proj", "apps", "api"), shallow = dir("proj", "apps");
	const view = net({ w1: [["p1", "tower", deep, "s-deep"]], w2: [["p2", "tower", shallow, "s-shallow"]], w3: [["p3", "tower", project, "s-root"]], w4: [["p4", "tower", project, "s-root-late"]] });
	assert.equal(towerFor(view, project)!.session.id, "s-root", "the project root itself, and w3 before w4");
	const noRoot = net({ w1: [["p1", "tower", deep, "s-deep"]], w2: [["p2", "tower", shallow, "s-shallow"]], w3: [["p3", "tower", shallow, "s-shallow-late"]] });
	assert.equal(towerFor(noRoot, project)!.session.id, "s-shallow");
});

test("a message for a named workspace goes to the tower of that workspace label; with no tower there it waits instead of going to another", () => {
	const project = dir("proj");
	const view = net({ w1: [["p1", "tower", project, "s1"]], w2: [["p2", "tower", project, "s2"]] });
	assert.equal(towerFor(view, project, "label-w2")!.session.id, "s2");
	assert.equal(towerFor(view, project, "label-w1")!.session.id, "s1");
	assert.equal(towerFor(view, project, "label-w9"), undefined);
	assert.equal(towerFor(view, project, "")!.session.id, "s1", "no workspace named: the rule above");
});

test("a sub workspace has no tower: a tower pane in a linked worktree workspace is not a candidate", () => {
	const project = dir("proj");
	const view = net({ w1: [["p1", "tower", project, "s1"]] });
	view.workspaces[0]!.worktree = { is_linked_worktree: true };
	assert.equal(towerFor(view, project), undefined);
});

test("a project may not be the home folder, hold ~/.pi, or sit inside it; a relative or missing one is refused", () => {
	const home = dir("home"), agent = dir("home", ".pi", "agent"), proj = dir("home", "projects", "moldplan");
	assert.equal(projectProblem(proj, { home, agentDir: agent }), undefined);
	assert.match(projectProblem(home, { home, agentDir: agent })!, /home folder/);
	assert.match(projectProblem(root, { home, agentDir: agent })!, /~\/\.pi|\.pi/, "a parent of ~/.pi holds it");
	assert.match(projectProblem(join(home, ".pi"), { home, agentDir: agent })!, /\.pi/);
	assert.match(projectProblem(agent, { home, agentDir: agent })!, /\.pi|agent/);
	assert.match(projectProblem("projects/x", { home, agentDir: agent })!, /absolute/);
	assert.match(projectProblem(join(root, "nope"), { home, agentDir: agent })!, /exist/);
	assert.match(projectProblem("/", { home, agentDir: agent })!, /\.pi|home/);
	const other = dir("elsewhere", "agent-dir");
	assert.match(projectProblem(other, { home, agentDir: other })!, /agent/);
});

test("R-F020: a device is named by its id, its short id, or its label; a label two devices share, or a name that fits two, is an error that lists them", () => {
	const members = [
		{ team: "t1", id: "abcdef" + "a".repeat(20), label: "alice-mac" },
		{ team: "t1", id: "bcdefg" + "b".repeat(20), label: "bob-mac" },
		{ team: "t1", id: "cdefgh" + "c".repeat(20), label: "bob-mac" },
		{ team: "t1", id: "ddddd2" + "d".repeat(20), label: "ci-box" },
		{ team: "t1", id: "me".padEnd(26, "m"), label: "me-here" },
	];
	const self = "me".padEnd(26, "m");
	assert.deepEqual(resolveDevice("alice-mac", members, self), { ok: true, team: "t1", id: members[0]!.id });
	assert.deepEqual(resolveDevice("abcdef", members, self), { ok: true, team: "t1", id: members[0]!.id }, "a short id");
	assert.deepEqual(resolveDevice(members[3]!.id, members, self), { ok: true, team: "t1", id: members[3]!.id }, "a full id");
	assert.deepEqual(resolveDevice("ABCDEF", members, self), { ok: true, team: "t1", id: members[0]!.id }, "ids are lower case");
	const twin = resolveDevice("bob-mac", members, self);
	assert.ok(!twin.ok);
	assert.match(twin.error, /2 devices/);
	assert.match(twin.error, /bob-mac \(bcdefg\)/);
	assert.match(twin.error, /bob-mac \(cdefgh\)/);
	assert.match(twin.error, /short id/);
	const clash = resolveDevice("cdefgh", [...members, { team: "t1", id: "zzzzzz" + "z".repeat(20), label: "cdefgh" }], self);
	assert.ok(!clash.ok && /2 devices/.test(clash.error), "a short id that is also another device's label");
	const none = resolveDevice("carol", members, self);
	assert.ok(!none.ok);
	assert.match(none.error, /No device "carol"/);
	assert.match(none.error, /alice-mac \(abcdef\)/);
	assert.ok(!none.error.includes("me-here"), "this device is not a target");
	const mine = resolveDevice("me-here", members, self);
	assert.ok(!mine.ok && /this device/i.test(mine.error));
	assert.ok(!resolveDevice("", members, self).ok);
	// The same label in two teams of the same tower is ambiguous too.
	const two = resolveDevice("alice-mac", [...members, { team: "t2", id: "eeeeee" + "e".repeat(20), label: "alice-mac" }], self);
	assert.ok(!two.ok && /2 devices/.test(two.error));
});

test("the config: teams with a project and a share, bad ones listed as problems and left out, a missing or unreadable file is no teams", () => {
	const home = dir("home"), agent = dir("home", ".pi", "agent"), state = dir("home", ".pi", "agent", "straw-boss"), proj = dir("home", "projects", "moldplan");
	const T1 = "01".repeat(16), T2 = "02".repeat(16), T3 = "03".repeat(16), T4 = "04".repeat(16);
	assert.deepEqual(readLinkConfig(state, { home, agentDir: agent }).teams.size, 0);
	writeFileSync(join(state, "config.json"), "{broken");
	assert.deepEqual(readLinkConfig(state, { home, agentDir: agent }).teams.size, 0);
	writeFileSync(join(state, "config.json"), JSON.stringify({ towerModel: "x", link: { relay: "https://r.example", teams: { [T1]: { project: "~/projects/moldplan", share: "presence" }, [T2]: { project: proj }, [T3]: { project: home }, [T4]: { share: "status" }, nothex: { project: proj } } } }));
	const cfg = readLinkConfig(state, { home, agentDir: agent });
	assert.deepEqual([...cfg.teams.keys()], [T1, T2]);
	assert.deepEqual(cfg.teams.get(T1), { project: proj, share: "presence", name: "moldplan" });
	assert.equal(cfg.teams.get(T2)!.share, "status", "the default");
	assert.equal(cfg.relay, "https://r.example");
	assert.equal(cfg.problems.length, 3, cfg.problems.join("\n"));
	assert.ok(cfg.problems.some((p) => p.includes(T3) && /home folder/.test(p)));
	assert.ok(cfg.problems.some((p) => p.includes(T4)));
});

test("SLH-F009: a child folder whose name starts with two dots is inside its parent", () => {
	const project = dir("p"), child = dir("p", "..x"), deeper = dir("p", "..x", "..y");
	assert.ok(inside(child, project));
	assert.ok(inside(deeper, project));
	assert.ok(!inside(project, child), "the parent is not inside the child");
	assert.ok(!inside(dir("q"), project));
});

test("SLH-F010: a device in two teams whose projects both hold the tower is one device, reached through the team with the nearest project", () => {
	const outer = dir("outer"), inner = dir("outer", "inner"), tower = dir("outer", "inner", "api"), other = dir("elsewhere");
	const teams = [{ team: "outer", project: outer }, { team: "elsewhere", project: other }, { team: "inner", project: inner }];
	assert.deepEqual(nearestTeams(tower, teams).map((t) => t.team), ["inner", "outer"], "the elsewhere team does not hold the tower");
	const members = [{ team: "inner", id: "d".repeat(26), label: "Lee" }, { team: "outer", id: "d".repeat(26), label: "Lee" }, { team: "outer", id: "e".repeat(26), label: "Kim" }];
	const one = oneTeamEach(members);
	assert.deepEqual(one.map((m) => [m.team, m.label]), [["inner", "Lee"], ["outer", "Kim"]]);
	assert.deepEqual(resolveDevice("Lee", one, "z".repeat(26)), { ok: true, team: "inner", id: "d".repeat(26) });
	assert.ok(!resolveDevice("Lee", members, "z".repeat(26)).ok, "listed per team, the same device could not be named at all");
});
