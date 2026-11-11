import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkText, type Reply } from "./control.ts";
import { createDeploys, type Delivery as Said, type Deploy, type StepId } from "./deploy.ts";
import { createOpenings, type Delivery, type Opening, type Openings } from "./openings.ts";
import { clean, cleanGroup } from "./trust/found.ts";
import { type Intents, listed } from "./trust/intent.ts";
import { assertSettingsSafe, type SettingsRefusal, SettingsRefused } from "./trust/settings.ts";
import { waitPastTrust } from "./trust/wait.ts";
import { type Hidden, HiddenError, hasHidden, platformHidden } from "./hidden.ts";
import { createTab, type HerdrCall, type HerdrRun, isHead, isSub, type Pane, panes, report, result, type Sleep, startPi, type Workspace, workspaces } from "./herdr.ts";
import { isSessionRole } from "./trainrole.ts";

// What the page opens by itself, each pi started in a folder picked from the home folder. A base starts with no tower: it opens with one member
// (a base is never empty), a base without a tower takes more members, and only a member that promotes itself opens the tower (index.ts), so the
// page never opens one. A base with a tower takes new mains, each in a tab of its own. The picker never leaves home and never shows or enters a
// hidden folder; a path from the browser is resolved (symlinks too) before it is listed or used. A new main is authorised to promote itself the
// way the tower's opener does it (opener.ts), with no limits: the person asked for it. One open at a time; a failed one closes what it created.
//   POST /<token>/api/dirs {path?, workspace?, tab?}              the folders in `path`, or in the squad's or the base's own folder, or in home
//   POST /<token>/api/dirs/new {path, name}                        a new folder `name` in the pickable folder `path` (an existing one of that name is answered as it is)
//   POST /<token>/api/dirs/places {}                              home, its Desktop and Documents when they are pickable, and the folders the open bases work in
//   POST /<token>/api/open/base {dir, label, prompt?, deploy?, joinWaitMs?} a new workspace in `dir` whose first tab holds a member (`joinWaitMs`: how long to wait for its pi to join, 10 s to 5 min, default 60 s)
//   POST /<token>/api/open/member {workspace, tab?, dir?, prompt?, deploy?} a member split into `tab` (in `dir`, else that tab's folder), or in a new tab in `dir`; no tower
//   POST /<token>/api/open/main {workspace, dir, prompt?, deploy?}  a new tab in the base whose pi becomes its main; the base has a tower
//   Each open answers {workspace, tab, pane, session?, delivery?}: `delivery` is there when the open had a first message: `sent`, `unknown` (a repeat found it begun and cannot tell whether it arrived), or `not_sent` (a repeat found one never typed and carries none); the progress (deploy.ts) carries it too.
// A new pi that waits on a project trust question (trust/ask.ts) has not joined: the join wait stops counting while its pane has one, the deploy shows a `trust` step with the question, and ten minutes without an answer fail the opening.
// Before anything is created for a new pi, the folder's .pi/settings.json is looked at (trust/settings.ts: pi reads it whole at startup, before any extension can stop it); a refusal answers 409 `settings_unsafe` with the facts in `settings`, at the `create` step.
// An open may carry `deploy`, an id the page makes; POST /<token>/api/open/progress {id} then answers how far that open has got (deploy.ts), and a refused open names its failed `step`.
// An open/base with a `deploy` id is recorded durably (openings.ts, <state>/openings.json: workspace, tab, pane, folder, and where the first message stands): a repeat with the same id, after a server restart too, finds the workspace it made and answers with it (no second workspace).
// A repeat's record counts only while its workspace, its pane, and its folder (as the pane reports it; a pane with no folder counts when the workspace's label is the recorded one too) are as recorded; else it is a new open.
// A first message is typed once: a repeat types it only when the first open never began to (`delivery` of the record was `pending`), and never when it was being typed or was typed (`sent`, `unknown` in the reply).

/** The join wait of an open (`joinWaitMs` of open/base asks for another, within the bounds): a slow computer, Windows especially, needs more than a minute. */
/** Whether a pane's `sb_role` token says it joined as `role`, or, when none is named, as any joined session (a train is one). */
export const joinedAs = (token: string | undefined, role?: string): boolean => (role ? token === role : isSessionRole(token));
export const JOIN_WAIT_MS = 60_000, MIN_JOIN_WAIT_MS = 10_000, MAX_JOIN_WAIT_MS = 300_000;
const MAX_DIRS = 500, MAX_LABEL = 64;

/** `live` says whether a session is still on the net, so a tower token its tower left behind does not count; `sessionAt` names the session in a pane, so the page can go to it. */
/** `lock` is the one-open-at-a-time flag: the host owns it, as it owns `deploys` and `openings`, so the spawns of one host (a GUI that stops and starts in the process) never open at once. */
export interface SpawnDeps { lock?: { busy: boolean }; run: HerdrRun; sleep: Sleep; call?: HerdrCall; live(sessionId: string): Promise<boolean>; sessionAt?(paneId: string): Promise<string | undefined>; home?: string; hidden?: Hidden; deploys?: ReturnType<typeof createDeploys>; trustDir?: string; openings?: Openings; intents?: Intents; note?(event: string, facts: Record<string, string>): void }

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

export function createSpawn({ run, sleep, call, live, sessionAt, home = homedir(), hidden = platformHidden, deploys = createDeploys(), trustDir, openings = createOpenings(), intents, note, lock = { busy: false } }: SpawnDeps) {
	const pick = (path: unknown) => pickable(path, home, hidden);
	/** Records an opening; a file system's cause (it has the path) goes to the log, and the reply says only that the record could not be kept. */
	const keep = (id: string, opening: Opening) => {
		try {
			openings.set(id, opening);
		} catch (error) {
			note?.("opening-record-failed", { text: (error as Error).message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300) });
			throw new Error("The opening could not be recorded, so it was not kept.");
		}
	};
	const opened = async (workspace: string, tab: string, pane: string, delivery?: Said): Promise<Reply> => ({ status: 200, body: { workspace, tab, pane, ...(delivery && { delivery }), ...(sessionAt && { session: await sessionAt(pane) }) } });
	/** What an open/base says of its first message: `sent` (typed by this call, or an earlier one that finished), `unknown` (an earlier one began to type it and the server cannot tell whether it arrived; not typed again), `not_sent` (the earlier one had a message and this call has none to type). */
	const delivered = (d: Deploy, state: Delivery, asked: boolean): Said | undefined => {
		const said = state === "sent" ? "sent" : state === "sending" ? "unknown" : state === "pending" && !asked ? "not_sent" : undefined;
		d.delivery = said;
		return said;
	};
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
			if (isSub(ws) || isHead(ws)) continue;
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
	async function awaitJoin(d: Deploy, paneId: string, joinWaitMs: number, role?: string) {
		d.go("join");
		const joined = await waitPastTrust(sleep, async () => {
			const r = (await panes(run)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
			return joinedAs(r, role);
		}, joinWaitMs, 500, trustDir ? { dir: trustDir, pane: paneId, on: (r) => d.hold(r && { id: r.id, digest: r.digest, folder: clean(r.cwd), found: r.found.map(cleanGroup) }) } : undefined);
		if (!joined) throw new Error(`The pi in pane ${paneId} did not join the net${role ? ` as the ${role} of its tab` : ""} within ${joinWaitMs / 1000} s`);
	}
	/** Types the first message into the pane's pi. `track` is told how far it got before and after the call, so a record can say whether a repeat may type it again. */
	async function deliver(d: Deploy, paneId: string, prompt: string, track?: (state: Delivery) => void): Promise<Reply | undefined> {
		d.go("deliver");
		if (!call) return no(503, "unavailable", "The agent opened, but this server cannot type into it; send the first message from its comms.");
		track?.("sending"); // before the call: from here on a repeat cannot know whether the text arrived
		const sent = await call("agent.prompt", { target: paneId, text: prompt }, 15_000).then(() => undefined, (error: Error) => error.message);
		if (sent) return no(502, "prompt_failed", `The agent opened, but the first message did not arrive: ${sent}`);
		try {
			track?.("sent");
		} catch {} // typed already: a record left at `sending` keeps a repeat from typing it again, which is the safe side
	}
	/** `intent` is the folder of an open/base: a person's act, so under auto mode its pi's trust question is asked as usual. The pane is listed before pi starts and taken off when the join ends, however it ends (trust/intent.ts). */
	async function boot(d: Deploy, paneId: string, name: string, prompt: string | undefined, role?: string, joinWaitMs = JOIN_WAIT_MS, track?: (state: Delivery) => void, intent?: string): Promise<Reply | undefined> {
		d.go("start");
		d.pane = paneId; // before pi starts: its trust question can be there before `agent start` returns
		const release = intent ? listed(intents, note, paneId, intent, joinWaitMs) : undefined;
		try {
			await startPi(run, sleep, `${role ?? "member"}-${randomUUID().slice(0, 8)}`, paneId, ["--name", name]);
			await awaitJoin(d, paneId, joinWaitMs, role);
		} finally {
			release?.();
		}
		if (prompt) return deliver(d, paneId, prompt, track);
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
		await assertSettingsSafe([dir]);
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
			await assertSettingsSafe([dir]);
			const opened = await createTab(run, ws.workspace_id, dir, ["STRAW_BOSS_ROLE=member"], basename(dir) || dir);
			created = { ...opened, close: ["tab", "close", opened.tabId] };
		} else {
			// The new member sits beside the tab's main, or its first pane, in the picked folder, else in that pane's.
			const lead = await leadOf(ws.workspace_id, tabId);
			if (!lead) return no(404, "not_found", "That tab is not open any more.");
			const cwd = dir ?? (await pick(lead.cwd)) ?? (await baseDir(ws.workspace_id));
			await assertSettingsSafe([cwd]);
			const split = await result(run, ["pane", "split", lead.pane_id, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
			const paneId: string = split.pane.pane_id;
			created = { tabId: lead.tab_id, paneId, close: ["pane", "close", paneId] };
			dir = cwd;
		}
		const failed = await orClose(created.close, () => boot(d, created.paneId, `member · ${basename(dir!) || dir}`, prompt));
		return failed ?? opened(ws.workspace_id, created.tabId, created.paneId);
	}

	/**
	 * What an earlier open with this id made, when that workspace is still there, in this folder, and its pane still runs there: the pane, once its pi has joined (the wait is the
	 * same, so a repeat that comes while the first open's pi is still starting waits for it). Anything else is not that open's (Herdr reuses the ids of closed workspaces): the
	 * record goes, and the repeat is a new open. The first message is typed only if the first open never began to; one that was being typed, or was typed, is not typed again.
	 * A pi that has not joined fails the repeat and leaves the workspace and the record, since this request did not make them: the next repeat waits again.
	 */
	async function reopened(d: Deploy, id: string, dir: string, prompt: string | undefined, joinWaitMs: number): Promise<Reply | undefined> {
		const open = await workspaces(run);
		openings.prune(new Set(open.map((w) => w.workspace_id)));
		const had = openings.get(id);
		if (!had) return;
		const pane = had.dir === dir ? (await panes(run, had.workspace)).find((p) => p.pane_id === had.pane) : undefined;
		// A pane that reports no folder (Herdr's `cwd` is optional, and a Windows pane may not know it yet) counts only when everything else still agrees: the workspace id and the pane id (found above) and the workspace's label, as recorded. Anything weaker is a new open: a wrong workspace is worse than a duplicate. A folder that is reported and differs is stale.
		const same = pane && (pane.cwd ? (await pick(pane.cwd)) === had.dir : open.find((w) => w.workspace_id === had.workspace)?.label === had.label);
		if (!pane || !same) return void openings.drop(id);
		d.go("start");
		d.pane = pane.pane_id;
		await awaitJoin(d, pane.pane_id, joinWaitMs);
		let delivery: Delivery = had.delivery;
		if (prompt && (delivery === "none" || delivery === "pending")) {
			const failed = await deliver(d, pane.pane_id, prompt, (state) => void keep(id, { ...had, delivery: (delivery = state) }));
			if (failed) return failed;
		} else if (prompt) d.go("deliver"); // typed, or maybe typed, by the open before: the step is over, and the reply says which
		return opened(had.workspace, pane.tab_id, pane.pane_id, delivered(d, delivery, Boolean(prompt)));
	}

	async function openBase(d: Deploy, dir: string, label: string, prompt: string | undefined, id: string | undefined, joinWaitMs: number): Promise<Reply> {
		d.go("create");
		const again = id && (await reopened(d, id, dir, prompt, joinWaitMs));
		if (again) return again;
		await assertSettingsSafe([dir]);
		const created = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus", "--env", "STRAW_BOSS_ROLE=member"]);
		const workspaceId: string = created.workspace.workspace_id, paneId: string = created.root_pane.pane_id;
		const record = { workspace: workspaceId, tab: created.tab.tab_id as string, pane: paneId, dir, label: (created.workspace.label as string | undefined) ?? label };
		let delivery: Delivery = prompt ? "pending" : "none";
		// Created by this request a moment ago, with nothing in it but the member attempt: a base is never left empty.
		const failed = await orClose(["workspace", "close", workspaceId], async () => {
			if (id) {
				keep(id, { ...record, delivery }); // before pi starts: a restart in the join wait leaves the id known
			}
			return boot(d, paneId, `member · ${basename(dir) || dir}`, prompt, undefined, joinWaitMs, id ? (state) => void keep(id, { ...record, delivery: (delivery = state) }) : (state) => void (delivery = state), dir);
		}).catch((error) => {
			if (id) try { openings.drop(id); } catch {} // the workspace is closed with the throw: the id is free again, and the failure that is reported is the first
			return Promise.reject(error);
		});
		// A reply that is not a throw (the first message did not arrive) leaves the workspace, its pi joined: the record stays, so a repeat finds it instead of making a second base.
		return failed ?? opened(workspaceId, created.tab.tab_id, paneId, delivered(d, delivery, Boolean(prompt)));
	}

	/** Closes the progress of an open on its reply; a refusal names the step it failed at. */
	const failed = (d: Deploy, reply: Reply): Reply => {
		if (reply.status < 400) return (d.finish(), reply);
		const { reason, settings } = reply.body as { reason: string; settings?: SettingsRefusal };
		d.fail(reason, settings);
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
		let joinWaitMs = JOIN_WAIT_MS;
		if (kind === "base" && json.joinWaitMs !== undefined) {
			const ms = json.joinWaitMs;
			if (typeof ms !== "number" || !Number.isInteger(ms) || ms < MIN_JOIN_WAIT_MS || ms > MAX_JOIN_WAIT_MS) return no(400, "bad_request", `joinWaitMs is a whole number of milliseconds from ${MIN_JOIN_WAIT_MS} to ${MAX_JOIN_WAIT_MS}.`);
			joinWaitMs = ms;
		}
		if (lock.busy) return no(429, "busy", "Another opening is still on its way.");
		lock.busy = true;
		const d = deploys.begin(json.deploy as string | undefined, ["create", "start", "join", ...(prompt ? ["deliver" as StepId] : [])]);
		try {
			const done = await (kind === "main" ? openMain(d, json.workspace, dir!, prompt) : kind === "member" ? openMember(d, json.workspace, json.tab, dir, prompt) : openBase(d, dir!, label, prompt, json.deploy as string | undefined, joinWaitMs));
			return failed(d, done);
		} catch (error) {
			// A folder pi must not start in (trust/settings.ts) is refused before anything is created; the page words it in its own language from `settings`.
			if (error instanceof SettingsRefused) return failed(d, { status: 409, body: { error: "settings_unsafe", reason: error.message, settings: error.refusal } });
			return failed(d, no(502, "open_failed", (error as Error).message));
		} finally {
			lock.busy = false;
		}
	};
	// Windows could not say which folders are hidden: nothing is listed or opened on a guess.
	return (parts: string[], json: Record<string, unknown>): Promise<Reply> => route(parts, json).catch((error) => (error instanceof HiddenError ? no(503, "unreadable", error.message) : Promise.reject(error)));
}
