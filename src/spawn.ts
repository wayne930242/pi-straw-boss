import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkText, type Reply } from "./control.ts";
import { createDeploys, type Deploy, type StepId } from "./deploy.ts";
import { waitPastTrust } from "./trust/wait.ts";
import { type Hidden, HiddenError, hasHidden, platformHidden } from "./hidden.ts";
import { createTab, type HerdrCall, type HerdrRun, isSub, type Pane, panes, report, result, type Sleep, startPi, type Workspace, workspaces } from "./herdr.ts";

// What the page opens by itself, each pi started in a folder picked from the home folder. A base starts with no tower: it opens with one member
// (a base is never empty), a base without a tower takes more members, and only a member that promotes itself opens the tower (index.ts), so the
// page never opens one. A base with a tower takes new mains, each in a tab of its own. The picker never leaves home and never shows or enters a
// hidden folder; a path from the browser is resolved (symlinks too) before it is listed or used. A new main is authorised to promote itself the
// way the tower's opener does it (opener.ts), with no limits: the person asked for it. One open at a time; a failed one closes what it created.
//   POST /<token>/api/dirs {path?, workspace?, tab?}              the folders in `path`, or in the squad's or the base's own folder, or in home
//   POST /<token>/api/dirs/new {path, name}                        a new folder `name` in the pickable folder `path` (an existing one of that name is answered as it is)
//   POST /<token>/api/dirs/places {}                              home, its Desktop and Documents when they are pickable, and the folders the open bases work in
//   POST /<token>/api/open/base {dir, label, prompt?}             a new workspace in `dir` whose first tab holds a member
//   POST /<token>/api/open/member {workspace, tab?, dir?, prompt?} a member split into `tab` (in `dir`, else that tab's folder), or in a new tab in `dir`; no tower
//   POST /<token>/api/open/main {workspace, dir, prompt?}         a new tab in the base whose pi becomes its main; the base has a tower
// A new pi that waits on a project trust question (trust/ask.ts) has not joined: the join wait stops counting while its pane has one, the deploy shows a `trust` step with the question, and ten minutes without an answer fail the opening.
// An open may carry `deploy`, an id the page makes; POST /<token>/api/open/progress {id} then answers how far that open has got (deploy.ts), and a refused open names its failed `step`.

const MAX_DIRS = 500, JOIN_WAIT_MS = 60_000, MAX_LABEL = 64;

/** `live` says whether a session is still on the net, so a tower token its tower left behind does not count; `sessionAt` names the session in a pane, so the page can go to it. */
export interface SpawnDeps { run: HerdrRun; sleep: Sleep; call?: HerdrCall; live(sessionId: string): Promise<boolean>; sessionAt?(paneId: string): Promise<string | undefined>; home?: string; hidden?: Hidden; deploys?: ReturnType<typeof createDeploys>; trustDir?: string }

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });
const OUTSIDE = no(400, "not_allowed", "Only folders in your home folder, outside hidden folders, can be picked.");

/**
 * The real path of a directory the page may pick: at or under home, with no hidden part once symlinks are resolved. Where `hidden` reads attributes (Windows, hidden.ts)
 * no part may carry one, in the path as given too: "My Documents" is a hidden junction to Documents, and leads there only for the Explorer that never shows it.
 * The path as given is read from home as the caller spelled it as well as from the real root: realpath rewrites a spelling such as an 8.3 short name
 * (`C:\Users\RUNNER~1`), after which the path given in the old spelling no longer lies under the real root and would go unchecked.
 */
export async function pickable(path: unknown, home = homedir(), hidden = platformHidden): Promise<string | undefined> {
	if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) return;
	const [real, root] = await Promise.all([realpath(path).catch(() => undefined), realpath(home).catch(() => home)]);
	if (!real) return;
	const rel = relative(root, real);
	if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).some((part) => part.startsWith("."))) return;
	if (hidden) {
		for (const base of [root, resolve(home)]) {
			const given = relative(base, resolve(path));
			if (given.startsWith("..") || isAbsolute(given)) continue;
			if (given !== rel && (await hasHidden(base, given.split(sep).filter(Boolean), hidden))) return;
			break;
		}
		if (rel && (await hasHidden(root, rel.split(sep), hidden))) return;
	}
	return (await stat(real).catch(() => undefined))?.isDirectory() ? real : undefined;
}

/** The visible folders in `dir` (a symlink counts when it leads to a pickable folder), sorted, at most MAX_DIRS of them. */
export async function listDirs(dir: string, home = homedir(), hidden = platformHidden) {
	const root = await realpath(home).catch(() => home), names: string[] = [], marked = await hidden?.(dir);
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".") || marked?.has(e.name.toLowerCase())) continue;
		if (e.isDirectory() || (e.isSymbolicLink() && (await pickable(join(dir, e.name), home, hidden)))) names.push(e.name);
	}
	names.sort((a, b) => a.localeCompare(b));
	return { path: dir, home: root, sep, parent: dir === root ? null : dirname(dir), dirs: names.slice(0, MAX_DIRS), truncated: names.length > MAX_DIRS };
}

const BAD_NAME = /[\p{Cc}\p{Cf}\\/<>:"|?*]/u, RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD = () => no(400, "bad_name", "A folder name is at most 255 characters, with no / \\ : * ? \" < > | and no leading or trailing dot.");
/** A new folder `name` in the pickable `parent`: a plain visible name, no path in it, which Windows also takes. A folder already there is answered as it is. */
export async function makeDir(parent: unknown, name: unknown, home = homedir(), hidden = platformHidden): Promise<Reply> {
	const dir = await pickable(parent, home, hidden);
	if (!dir) return OUTSIDE;
	const clean = typeof name === "string" ? name.trim() : "";
	if (!clean || Buffer.byteLength(clean) > 255 || RESERVED.test(clean) || clean.startsWith(".") || /[. ]$/.test(clean) || BAD_NAME.test(clean)) return BAD();
	const path = join(dir, clean), made = await mkdir(path).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : error));
	if (made instanceof Error) return made.code === "ENAMETOOLONG" ? BAD() : no(403, "unwritable", `The folder could not be made: ${made.message}`);
	const real = await pickable(path, home, hidden);
	if (!real && made) await rmdir(path).catch(() => {}); // a link swapped in after the check: take back the folder this call made
	return real ? { status: 200, body: { path: real, created: made } } : no(409, "not_a_folder", `${clean} exists here and is not a folder you can pick.`);
}

export function createSpawn({ run, sleep, call, live, sessionAt, home = homedir(), hidden = platformHidden, deploys = createDeploys(), trustDir }: SpawnDeps) {
	const pick = (path: unknown) => pickable(path, home, hidden);
	let busy = false;
	const opened = async (workspace: string, tab: string, pane: string): Promise<Reply> => ({ status: 200, body: { workspace, tab, pane, ...(sessionAt && { session: await sessionAt(pane) }) } });
	/** The base's own folder: its checkout, else where its tower runs, else where its first pane runs; home when that is not pickable. */
	const baseDir = async (workspaceId: unknown) => {
		const ws = typeof workspaceId === "string" ? (await workspaces(run)).find((w) => w.workspace_id === workspaceId) : undefined;
		if (!ws) return home;
		const here = await panes(run, ws.workspace_id);
		const own = ws.worktree?.checkout_path ?? here.find((p) => p.tokens?.sb_role === "tower")?.cwd ?? here[0]?.cwd;
		return (await pick(own)) ?? (await realpath(home).catch(() => home));
	};
	/** Where a person starts from: home, its Desktop and Documents when they are pickable, and the folders the open bases (and the panes in them) work in. */
	const places = async () => {
		const root = await realpath(home).catch(() => home), seen = new Set<string>(), recent: string[] = [];
		const keep = async (path: unknown) => {
			const dir = await pick(path);
			if (dir && dir !== root && !seen.has(dir)) (seen.add(dir), recent.push(dir));
		};
		for (const ws of await workspaces(run).catch(() => [])) {
			if (isSub(ws)) continue;
			await keep(ws.worktree?.checkout_path);
			for (const pane of await panes(run, ws.workspace_id).catch(() => [])) await keep(pane.cwd);
		}
		const named = await Promise.all(["Desktop", "Documents"].map(async (name) => [name, await pick(join(root, name))] as const));
		return { home: root, sep, places: named.flatMap(([name, path]) => (path ? [{ name, path }] : [])), recent: recent.slice(0, 10) };
	};
	const leadOf = async (workspaceId: string, tabId: unknown): Promise<Pane | undefined> => {
		const here = (await panes(run, workspaceId)).filter((p) => p.tab_id === tabId);
		return here.find((p) => p.tokens?.sb_role === "main") ?? here[0];
	};
	const towered = async (ws: Workspace) => Boolean(ws.tokens?.tower && (await live(ws.tokens.tower)));
	const base = async (workspaceId: unknown): Promise<Workspace | Reply> => {
		const ws = (await workspaces(run)).find((w) => w.workspace_id === workspaceId);
		if (!ws) return no(404, "not_found", "That base is not open any more.");
		return isSub(ws) ? no(400, "bad_request", "A sub workspace has no agents of its own to add to.") : ws;
	};

	/** Starts pi in a fresh pane and waits until it has joined the net (as `role`, or as anything when none is named), then types the first message. */
	async function boot(d: Deploy, paneId: string, name: string, prompt: string | undefined, role?: string): Promise<Reply | undefined> {
		d.go("start");
		d.pane = paneId; // before pi starts: its trust question can be there before `agent start` returns
		await startPi(run, sleep, `${role ?? "member"}-${randomUUID().slice(0, 8)}`, paneId, ["--name", name]);
		d.go("join");
		const joined = await waitPastTrust(sleep, async () => {
			const r = (await panes(run)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
			return role ? r === role : r === "member" || r === "main";
		}, JOIN_WAIT_MS, 500, trustDir ? { dir: trustDir, pane: paneId, on: (r) => d.hold(r && { id: r.id, digest: r.digest, folder: r.cwd, found: r.found }) } : undefined);
		if (!joined) throw new Error(`The pi in pane ${paneId} did not join the net${role ? ` as the ${role} of its tab` : ""} within ${JOIN_WAIT_MS / 1000} s`);
		if (!prompt) return;
		d.go("deliver");
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

	async function openMain(d: Deploy, workspaceId: unknown, dir: string, prompt?: string): Promise<Reply> {
		d.go("create");
		const ws = await base(workspaceId);
		if ("status" in ws) return ws;
		if (!(await towered(ws))) return no(409, "no_tower", "This base has no tower yet: add a member, and the tower opens when a member promotes itself.");
		const name = basename(dir) || dir;
		const { tabId, paneId } = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=main"], name);
		const failed = await orClose(["tab", "close", tabId], async () => {
			// sb_open_main authorises exactly one pi in this shell to promote itself (index.ts consumes it).
			await report(run, "pane", paneId, { sb_open_main: "1" });
			return boot(d, paneId, `main · ${name}`, prompt, "main");
		});
		return failed ?? opened(ws.workspace_id, tabId, paneId);
	}

	async function openMember(d: Deploy, workspaceId: unknown, tabId: unknown, dir: string | undefined, prompt?: string): Promise<Reply> {
		d.go("create");
		const ws = await base(workspaceId);
		if ("status" in ws) return ws;
		if (await towered(ws)) return no(409, "has_tower", "This base has a tower: open a new main instead, in a tab of its own.");
		let created: { tabId: string; paneId: string; close: string[] };
		if (tabId === undefined) {
			if (!dir) return OUTSIDE;
			const opened = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=member"], basename(dir) || dir);
			created = { ...opened, close: ["tab", "close", opened.tabId] };
		} else {
			// The new member sits beside the tab's main, or its first pane, in the picked folder, else in that pane's.
			const lead = await leadOf(ws.workspace_id, tabId);
			if (!lead) return no(404, "not_found", "That tab is not open any more.");
			const cwd = dir ?? (await pick(lead.cwd)) ?? (await baseDir(ws.workspace_id));
			const split = await result(run, ["pane", "split", lead.pane_id, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
			const paneId: string = split.pane.pane_id;
			created = { tabId: lead.tab_id, paneId, close: ["pane", "close", paneId] };
			dir = cwd;
		}
		const failed = await orClose(created.close, () => boot(d, created.paneId, `member · ${basename(dir!) || dir}`, prompt));
		return failed ?? opened(ws.workspace_id, created.tabId, created.paneId);
	}

	async function openBase(d: Deploy, dir: string, label: string, prompt?: string): Promise<Reply> {
		d.go("create");
		const created = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
		const workspaceId: string = created.workspace.workspace_id, paneId: string = created.root_pane.pane_id;
		// Created by this request a moment ago, with nothing in it but the member attempt: a base is never left empty.
		const failed = await orClose(["workspace", "close", workspaceId], () => boot(d, paneId, `member · ${basename(dir) || dir}`, prompt));
		return failed ?? opened(workspaceId, created.tab.tab_id, paneId);
	}

	/** Closes the progress of an open on its reply; a refusal names the step it failed at. */
	const failed = (d: Deploy, reply: Reply): Reply => {
		if (reply.status < 400) return (d.finish(), reply);
		const { reason } = reply.body as { reason: string };
		d.fail(reason);
		return { status: reply.status, body: { ...(reply.body as object), step: d.failed!.step } };
	};

	const route = async ([scope, kind = ""]: string[], json: Record<string, unknown>): Promise<Reply> => {
		if (scope === "dirs" && !kind) {
			const lead = json.path === undefined && typeof json.workspace === "string" && json.tab !== undefined ? await leadOf(json.workspace, json.tab) : undefined;
			const dir = json.path !== undefined ? await pick(json.path) : ((lead && (await pick(lead.cwd))) ?? (await baseDir(json.workspace)));
			if (!dir) return OUTSIDE;
			return listDirs(dir, home, hidden).then((body) => ({ status: 200, body }), (error) => (error instanceof HiddenError ? Promise.reject(error) : no(403, "unreadable", "This folder cannot be read.")));
		}
		if (scope === "dirs" && kind === "new") return makeDir(json.path, json.name, home, hidden);
		if (scope === "dirs" && kind === "places") return { status: 200, body: await places() };
		if (scope === "open" && kind === "progress") {
			const seen = deploys.get(json.id);
			return seen ? { status: 200, body: seen.view() } : no(404, "not_found", "No such opening.");
		}
		if (scope !== "open" || !["main", "member", "base"].includes(kind)) return no(404, "not_found", "No such action.");
		if (json.deploy !== undefined && !deploys.valid(json.deploy)) return no(400, "bad_request", "The opening's id is 8 to 64 letters, digits, - or _.");
		const split = kind === "member" && json.tab !== undefined;
		if (split && typeof json.tab !== "string") return no(400, "bad_request", "A tab is named by its id.");
		const dir = split && json.dir === undefined ? undefined : await pick(json.dir);
		if (!dir && !(split && json.dir === undefined)) return OUTSIDE;
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
		const d = deploys.begin(json.deploy as string | undefined, ["create", "start", "join", ...(prompt ? ["deliver" as StepId] : [])]);
		try {
			const done = await (kind === "main" ? openMain(d, json.workspace, dir!, prompt) : kind === "member" ? openMember(d, json.workspace, json.tab, dir, prompt) : openBase(d, dir!, label, prompt));
			return failed(d, done);
		} catch (error) {
			return failed(d, no(502, "open_failed", (error as Error).message));
		} finally {
			busy = false;
		}
	};
	// Windows could not say which folders are hidden: nothing is listed or opened on a guess.
	return (parts: string[], json: Record<string, unknown>): Promise<Reply> => route(parts, json).catch((error) => (error instanceof HiddenError ? no(503, "unreadable", error.message) : Promise.reject(error)));
}
