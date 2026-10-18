import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkText, type Reply } from "./control.ts";
import { createTab, type HerdrCall, type HerdrRun, isSub, panes, report, result, type Sleep, startPi, TOWER_LABEL, waitFor, workspaces } from "./herdr.ts";

// What the page opens by itself: a main agent in a new tab of a base, or a new base (a Herdr workspace) with its tower, each in a directory picked
// from the home folder. The picker never leaves home and never shows or enters a hidden folder; a path from the browser is resolved (symlinks
// too) before it is listed or used. A new main is authorised to promote itself the way the tower's opener does it (opener.ts), with no limits:
// the person asked for it. One open at a time; a failed one closes what it created.
//   POST /<token>/api/dirs {path?, workspace?}            the folders in `path`, or in the base's own folder, or in home
//   POST /<token>/api/open/main {workspace, dir, prompt?}  a new tab in the base whose pi becomes its main, then the first prompt typed into it
//   POST /<token>/api/open/tower {dir, label}              a new workspace in `dir` whose first tab holds its tower

const MAX_DIRS = 500, MAIN_WAIT_MS = 60_000, MAX_LABEL = 64;

export interface SpawnDeps { run: HerdrRun; sleep: Sleep; call?: HerdrCall; openTower(workspaceId: string): Promise<{ id: string }>; home?: string }

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });
const OUTSIDE = no(400, "not_allowed", "Only folders in your home folder, outside hidden folders, can be picked.");

/** The real path of a directory the page may pick: at or under home, with no hidden part once symlinks are resolved. */
export async function pickable(path: unknown, home = homedir()): Promise<string | undefined> {
	if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) return;
	const [real, root] = await Promise.all([realpath(path).catch(() => undefined), realpath(home).catch(() => home)]);
	if (!real) return;
	const rel = relative(root, real);
	if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).some((part) => part.startsWith("."))) return;
	return (await stat(real).catch(() => undefined))?.isDirectory() ? real : undefined;
}

/** The visible folders in `dir` (a symlink counts when it leads to a pickable folder), sorted, at most MAX_DIRS of them. */
export async function listDirs(dir: string, home = homedir()) {
	const root = await realpath(home).catch(() => home), names: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".")) continue;
		if (e.isDirectory() || (e.isSymbolicLink() && (await pickable(join(dir, e.name), home)))) names.push(e.name);
	}
	names.sort((a, b) => a.localeCompare(b));
	return { path: dir, home: root, parent: dir === root ? null : dirname(dir), dirs: names.slice(0, MAX_DIRS), truncated: names.length > MAX_DIRS };
}

export function createSpawn({ run, sleep, call, openTower, home = homedir() }: SpawnDeps) {
	let busy = false;
	/** The base's own folder: its checkout, else where its tower runs, else where its first pane runs; home when that is not pickable. */
	const baseDir = async (workspaceId: unknown) => {
		const ws = typeof workspaceId === "string" ? (await workspaces(run)).find((w) => w.workspace_id === workspaceId) : undefined;
		if (!ws) return home;
		const here = await panes(run, ws.workspace_id);
		const own = ws.worktree?.checkout_path ?? here.find((p) => p.tokens?.sb_role === "tower")?.cwd ?? here[0]?.cwd;
		return (await pickable(own, home)) ?? (await realpath(home).catch(() => home));
	};

	async function openMain(workspaceId: unknown, dir: string, prompt?: string): Promise<Reply> {
		const ws = (await workspaces(run)).find((w) => w.workspace_id === workspaceId);
		if (!ws) return no(404, "not_found", "That base is not open any more.");
		if (isSub(ws)) return no(400, "bad_request", "A sub workspace has no main agents of its own.");
		const name = basename(dir) || dir;
		const { tabId, paneId } = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=main"], name);
		try {
			// sb_open_main authorises exactly one pi in this shell to promote itself (index.ts consumes it).
			await report(run, "pane", paneId, { sb_open_main: "1" });
			await startPi(run, sleep, `main-${randomUUID().slice(0, 8)}`, paneId, ["--name", `main · ${name}`]);
			const main = await waitFor(sleep, async () => (await panes(run, ws.workspace_id)).find((p) => p.pane_id === paneId)?.tokens?.sb_role === "main", MAIN_WAIT_MS, 500);
			if (!main) throw new Error(`The pi in pane ${paneId} did not become the main agent of its tab within ${MAIN_WAIT_MS / 1000} s`);
		} catch (error) {
			await run(["tab", "close", tabId]).catch(() => {}); // nothing was typed into it yet, so nothing is lost with it
			throw error;
		}
		if (prompt) {
			if (!call) return no(503, "unavailable", "The main opened, but this server cannot type into it; send the first message from its comms.");
			const sent = await call("agent.prompt", { target: paneId, text: prompt }, 15_000).then(() => undefined, (error: Error) => error.message);
			if (sent) return no(502, "prompt_failed", `The main opened, but the first message did not arrive: ${sent}`);
		}
		return { status: 200, body: { workspace: ws.workspace_id, tab: tabId, pane: paneId } };
	}

	async function openBase(dir: string, label: string): Promise<Reply> {
		const created = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus", "--env", "STRAW_BOSS_ROLE=tower"]);
		const workspaceId: string = created.workspace.workspace_id;
		try {
			// The first tab becomes the tower tab, so the new base holds no empty shell: ensureTower reuses a pane marked sb_role=tower.
			await report(run, "pane", created.root_pane.pane_id, { sb_role: "tower" });
			await run(["tab", "rename", created.tab.tab_id, TOWER_LABEL]);
			const tower = await openTower(workspaceId);
			return { status: 200, body: { workspace: workspaceId, tower: tower.id } };
		} catch (error) {
			await run(["workspace", "close", workspaceId]).catch(() => {}); // created by this request a moment ago, with nothing in it but the tower attempt
			throw error;
		}
	}

	return async function handle([scope, kind = ""]: string[], json: Record<string, unknown>): Promise<Reply> {
		if (scope === "dirs" && !kind) {
			const dir = json.path === undefined ? await baseDir(json.workspace) : await pickable(json.path, home);
			if (!dir) return OUTSIDE;
			return listDirs(dir, home).then((body) => ({ status: 200, body }), () => no(403, "unreadable", "This folder cannot be read."));
		}
		if (scope !== "open" || (kind !== "main" && kind !== "tower")) return no(404, "not_found", "No such action.");
		const dir = await pickable(json.dir, home);
		if (!dir) return OUTSIDE;
		let prompt: string | undefined, label = "";
		if (kind === "main" && typeof json.prompt === "string" && json.prompt.trim()) {
			const typed = checkText(json.prompt);
			if (typeof typed !== "string") return typed;
			prompt = typed;
		}
		if (kind === "tower") {
			label = typeof json.label === "string" && json.label.trim() ? json.label.trim() : basename(dir);
			if (label.length > MAX_LABEL || /[\p{Cc}]/u.test(label)) return no(400, "bad_request", `The name must be at most ${MAX_LABEL} characters, with no control characters.`);
		}
		if (busy) return no(429, "busy", "Another opening is still on its way.");
		busy = true;
		try {
			return await (kind === "main" ? openMain(json.workspace, dir, prompt) : openBase(dir, label));
		} catch (error) {
			return no(502, "open_failed", (error as Error).message);
		} finally {
			busy = false;
		}
	};
}
