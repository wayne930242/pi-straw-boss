import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkText, type Reply } from "./control.ts";
import { createTab, type HerdrCall, type HerdrRun, isSub, type Pane, panes, report, result, type Sleep, startPi, waitFor, type Workspace, workspaces } from "./herdr.ts";

// What the page opens by itself, each pi started in a folder picked from the home folder. A base starts with no tower: it opens with one member
// (a base is never empty), a base without a tower takes more members, and only a member that promotes itself opens the tower (index.ts), so the
// page never opens one. A base with a tower takes new mains, each in a tab of its own. The picker never leaves home and never shows or enters a
// hidden folder; a path from the browser is resolved (symlinks too) before it is listed or used. A new main is authorised to promote itself the
// way the tower's opener does it (opener.ts), with no limits: the person asked for it. One open at a time; a failed one closes what it created.
//   POST /<token>/api/dirs {path?, workspace?}                    the folders in `path`, or in the base's own folder, or in home
//   POST /<token>/api/open/base {dir, label, prompt?}             a new workspace in `dir` whose first tab holds a member
//   POST /<token>/api/open/member {workspace, tab?, dir?, prompt?} a member split into `tab` in that tab's folder, or in a new tab in `dir`; no tower
//   POST /<token>/api/open/main {workspace, dir, prompt?}         a new tab in the base whose pi becomes its main; the base has a tower

const MAX_DIRS = 500, JOIN_WAIT_MS = 60_000, MAX_LABEL = 64;

/** `live` says whether a session is still on the net, so a tower token its tower left behind does not count. */
export interface SpawnDeps { run: HerdrRun; sleep: Sleep; call?: HerdrCall; live(sessionId: string): Promise<boolean>; home?: string }

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

export function createSpawn({ run, sleep, call, live, home = homedir() }: SpawnDeps) {
	let busy = false;
	/** The base's own folder: its checkout, else where its tower runs, else where its first pane runs; home when that is not pickable. */
	const baseDir = async (workspaceId: unknown) => {
		const ws = typeof workspaceId === "string" ? (await workspaces(run)).find((w) => w.workspace_id === workspaceId) : undefined;
		if (!ws) return home;
		const here = await panes(run, ws.workspace_id);
		const own = ws.worktree?.checkout_path ?? here.find((p) => p.tokens?.sb_role === "tower")?.cwd ?? here[0]?.cwd;
		return (await pickable(own, home)) ?? (await realpath(home).catch(() => home));
	};
	const towered = async (ws: Workspace) => Boolean(ws.tokens?.tower && (await live(ws.tokens.tower)));
	const base = async (workspaceId: unknown): Promise<Workspace | Reply> => {
		const ws = (await workspaces(run)).find((w) => w.workspace_id === workspaceId);
		if (!ws) return no(404, "not_found", "That base is not open any more.");
		return isSub(ws) ? no(400, "bad_request", "A sub workspace has no agents of its own to add to.") : ws;
	};

	/** Starts pi in a fresh pane and waits until it has joined the net (as `role`, or as anything when none is named), then types the first message. */
	async function boot(paneId: string, name: string, prompt: string | undefined, role?: string): Promise<Reply | undefined> {
		await startPi(run, sleep, `${role ?? "member"}-${randomUUID().slice(0, 8)}`, paneId, ["--name", name]);
		const joined = await waitFor(sleep, async () => {
			const r = (await panes(run)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
			return role ? r === role : r === "member" || r === "main";
		}, JOIN_WAIT_MS, 500);
		if (!joined) throw new Error(`The pi in pane ${paneId} did not join the net${role ? ` as the ${role} of its tab` : ""} within ${JOIN_WAIT_MS / 1000} s`);
		if (!prompt) return;
		if (!call) return no(503, "unavailable", "The agent opened, but this server cannot type into it; send the first message from its comms.");
		const sent = await call("agent.prompt", { target: paneId, text: prompt }, 15_000).then(() => undefined, (error: Error) => error.message);
		if (sent) return no(502, "prompt_failed", `The agent opened, but the first message did not arrive: ${sent}`);
	}
	/** Runs `open` on what was just created, and closes it again when the open fails: nothing was typed into it yet, so nothing is lost with it. */
	const orClose = async (close: string[], open: () => Promise<Reply | undefined>) => {
		try {
			return await open();
		} catch (error) {
			await run(close).catch(() => {});
			throw error;
		}
	};

	async function openMain(workspaceId: unknown, dir: string, prompt?: string): Promise<Reply> {
		const ws = await base(workspaceId);
		if ("status" in ws) return ws;
		if (!(await towered(ws))) return no(409, "no_tower", "This base has no tower yet: add a member, and the tower opens when a member promotes itself.");
		const name = basename(dir) || dir;
		const { tabId, paneId } = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=main"], name);
		const failed = await orClose(["tab", "close", tabId], async () => {
			// sb_open_main authorises exactly one pi in this shell to promote itself (index.ts consumes it).
			await report(run, "pane", paneId, { sb_open_main: "1" });
			return boot(paneId, `main · ${name}`, prompt, "main");
		});
		return failed ?? { status: 200, body: { workspace: ws.workspace_id, tab: tabId, pane: paneId } };
	}

	async function openMember(workspaceId: unknown, tabId: unknown, dir: string | undefined, prompt?: string): Promise<Reply> {
		const ws = await base(workspaceId);
		if ("status" in ws) return ws;
		if (await towered(ws)) return no(409, "has_tower", "This base has a tower: open a new main instead, in a tab of its own.");
		let created: { tabId: string; paneId: string; close: string[] };
		if (tabId === undefined) {
			if (!dir) return OUTSIDE;
			const opened = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=member"], basename(dir) || dir);
			created = { ...opened, close: ["tab", "close", opened.tabId] };
		} else {
			// The new member sits beside the tab's main, or its first pane, in that pane's folder: the folder never comes from the browser here.
			const here = (await panes(run, ws.workspace_id)).filter((p) => p.tab_id === tabId);
			const lead: Pane | undefined = here.find((p) => p.tokens?.sb_role === "main") ?? here[0];
			if (!lead) return no(404, "not_found", "That tab is not open any more.");
			const cwd = (await pickable(lead.cwd, home)) ?? (await baseDir(ws.workspace_id));
			const split = await result(run, ["pane", "split", lead.pane_id, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
			const paneId: string = split.pane.pane_id;
			created = { tabId: lead.tab_id, paneId, close: ["pane", "close", paneId] };
			dir = cwd;
		}
		const failed = await orClose(created.close, () => boot(created.paneId, `member · ${basename(dir!) || dir}`, prompt));
		return failed ?? { status: 200, body: { workspace: ws.workspace_id, tab: created.tabId, pane: created.paneId } };
	}

	async function openBase(dir: string, label: string, prompt?: string): Promise<Reply> {
		const created = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
		const workspaceId: string = created.workspace.workspace_id, paneId: string = created.root_pane.pane_id;
		// Created by this request a moment ago, with nothing in it but the member attempt: a base is never left empty.
		const failed = await orClose(["workspace", "close", workspaceId], () => boot(paneId, `member · ${basename(dir) || dir}`, prompt));
		return failed ?? { status: 200, body: { workspace: workspaceId, tab: created.tab.tab_id, pane: paneId } };
	}

	return async function handle([scope, kind = ""]: string[], json: Record<string, unknown>): Promise<Reply> {
		if (scope === "dirs" && !kind) {
			const dir = json.path === undefined ? await baseDir(json.workspace) : await pickable(json.path, home);
			if (!dir) return OUTSIDE;
			return listDirs(dir, home).then((body) => ({ status: 200, body }), () => no(403, "unreadable", "This folder cannot be read."));
		}
		if (scope !== "open" || !["main", "member", "base"].includes(kind)) return no(404, "not_found", "No such action.");
		const split = kind === "member" && json.tab !== undefined;
		if (split && typeof json.tab !== "string") return no(400, "bad_request", "A tab is named by its id.");
		const dir = split ? undefined : await pickable(json.dir, home);
		if (!split && !dir) return OUTSIDE;
		let prompt: string | undefined, label = "";
		if (typeof json.prompt === "string" && json.prompt.trim()) {
			const typed = checkText(json.prompt);
			if (typeof typed !== "string") return typed;
			prompt = typed;
		}
		if (kind === "base") {
			label = typeof json.label === "string" && json.label.trim() ? json.label.trim() : basename(dir!);
			if (label.length > MAX_LABEL || /[\p{Cc}]/u.test(label)) return no(400, "bad_request", `The name must be at most ${MAX_LABEL} characters, with no control characters.`);
		}
		if (busy) return no(429, "busy", "Another opening is still on its way.");
		busy = true;
		try {
			return await (kind === "main" ? openMain(json.workspace, dir!, prompt) : kind === "member" ? openMember(json.workspace, json.tab, dir, prompt) : openBase(dir!, label, prompt));
		} catch (error) {
			return no(502, "open_failed", (error as Error).message);
		} finally {
			busy = false;
		}
	};
}
