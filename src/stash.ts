import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reply } from "./control.ts";
import { createTab, type HerdrRun, isSub, type Pane, panes, parentOf, report, result, type Session, type Sleep, startPi, tabs, workspaces } from "./herdr.ts";
import { assertSettingsSafe } from "./trust/settings.ts";
import { waitPastTrust } from "./trust/wait.ts";

// Stash and pop (docs/specs/2026-10-22-stash/spec.md). A stash puts a whole base away: it checks that every pane can be resumed losing
// nothing (Herdr's view here, each session's own view through its bridge's `stash-check`), writes a manifest of what ran where, then closes
// the base as its close button does (closer.ts). A pop opens a new workspace from the manifest and resumes each pi from its session file:
// the tower first (its session marks it a tower), then per tab the main (with the one-time sb_open_main token, as spawn.ts opens a main),
// then the members. Anything a resume cannot bring back (a running turn, a subagent, a monitor, a busy shell) refuses the stash instead.
//   POST /<token>/api/close/stash {workspace, name}    checks, writes <state dir>/stash/<name>.json, then closes the base

export type StashRole = "tower" | "main" | "member";
export interface StashPane { kind: StashRole | "shell"; cwd: string; session?: string; name?: string }
export interface StashTab { label?: string; panes: StashPane[] }
export interface Stash { version: 1; name: string; label: string; cwd: string; stashedAt: string; tabs: StashTab[] }

const ROLES = new Set<string>(["tower", "main", "member"]), SETTLED = new Set(["idle", "done"]);
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
const MAX_NAME = 64, CHECK_ROUNDS = 3, CHECK_GAP_MS = 2000, JOIN_MS = 60_000;
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

/** A stash name is a file name: at most 64 characters, no slash, backslash, or control character, not starting with a dot. */
export const nameOk = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_NAME && name === name.trim() && !name.startsWith(".") && !/[/\\\p{Cc}]/u.test(name);
const dirOf = (stateDir: string) => join(stateDir, "stash");
export const stashFile = (stateDir: string, name: string) => join(dirOf(stateDir), `${name}.json`);
/** A free stash name from a base label (or a taken name): slashes and control characters become "-", it is trimmed and cut, then " 2", " 3"… */
export function nameFor(label: string, stateDir: string): string {
	const base = label.replace(/[/\\\p{Cc}]/gu, "-").trim().replace(/^\.+/, "").slice(0, MAX_NAME - 4).trim() || "base";
	for (let n = 1; ; n++) if (!existsSync(stashFile(stateDir, n > 1 ? `${base} ${n}` : base))) return n > 1 ? `${base} ${n}` : base;
}

/** A stash as the page lists it. */
export interface Stashed { name: string; label: string; at: string }
/** The stashes waiting to be popped with their labels, for the page; a manifest that does not read is left out. */
export function stashedList(stateDir: string): Stashed[] {
	return listStashes(stateDir).flatMap((name) => { try { const st = readStash(stateDir, name); return [{ name, label: st.label, at: st.stashedAt }]; } catch { return []; } });
}

/** The stashes waiting to be popped, by name. */
export function listStashes(stateDir: string): string[] {
	try {
		return readdirSync(dirOf(stateDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter(nameOk).sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function paneOk(p: unknown): p is StashPane {
	const x = p as Partial<StashPane> | null;
	return x !== null && typeof x === "object" && (x.kind === "shell" || ROLES.has(x.kind as string)) && str(x.cwd) && (x.session === undefined || str(x.session)) && (x.name === undefined || typeof x.name === "string");
}
/** `session` is absent for a pi that never wrote its file (pi writes it at the first reply): it has no conversation to lose, so a pop starts it fresh in its role. */
/** What a pop can open: the stash checks it before it closes anything, the pop before it opens anything. */
const stashOk = (st: Stash | null) => st?.version === 1 && str(st.label) && str(st.cwd) && Array.isArray(st.tabs) && st.tabs.length > 0 && st.tabs.every((t) => Array.isArray(t?.panes) && t.panes.length > 0 && t.panes.every(paneOk) && (t.label === undefined || typeof t.label === "string"));
export function readStash(stateDir: string, name: string, file = stashFile(stateDir, name)): Stash {
	if (!nameOk(name)) throw new Error(`"${name}" is not a stash name`);
	let st: Stash;
	try {
		st = JSON.parse(readFileSync(file, "utf8")) as Stash;
	} catch (error) {
		throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `Nothing is stashed as "${name}"` : `The stash "${name}" cannot be read: ${(error as Error).message}`);
	}
	if (!stashOk(st)) throw new Error(`The stash "${name}" is not a manifest this version reads`);
	return st;
}

/** What runs in a shell pane's foreground besides the shell; undefined when Herdr cannot say. */
async function foreground(run: HerdrRun, paneId: string): Promise<string[] | undefined> {
	try {
		const procs = (await result(run, ["pane", "process-info", "--pane", paneId])).process_info?.foreground_processes as { name?: string; argv0?: string }[] | undefined;
		if (!Array.isArray(procs)) return undefined;
		return procs.map((p) => String(p.argv0 ?? p.name ?? "").replace(/^-/, "").split("/").pop()!).filter((n) => !SHELLS.has(n));
	} catch {
		return undefined;
	}
}

/** Herdr's side of the check, and the manifest's tabs: tower tab first, then Herdr's tab order, each tab's panes in Herdr's order. `resume`: false for
 * a close, which needs nothing a pop would read (session files, folders), only that nothing running is lost. */
export async function survey(run: HerdrRun, workspaceId: string, live: Session[], resume = true) {
	const all = await workspaces(run), ws = all.find((w) => w.workspace_id === workspaceId);
	if (!ws) return undefined;
	const reasons: string[] = [], agents: Session[] = [], out: StashTab[] = [];
	if (isSub(ws)) reasons.push(`${ws.label} is a sub workspace; stash the base it belongs to`);
	// A sub workspace is neither recorded nor closed: anything running in it would lose the base it reports to.
	for (const sub of all.filter((w) => isSub(w) && parentOf(all, w)?.workspace_id === workspaceId)) {
		const ps = await panes(run, sub.workspace_id), busy = ps.filter((p) => p.agent).length;
		if (busy) reasons.push(`its sub workspace ${sub.label} runs ${busy} agent${busy > 1 ? "s" : ""}`);
		for (const p of ps.filter((x) => !x.agent)) if ((await foreground(run, p.pane_id))?.length !== 0) reasons.push(`pane ${p.pane_id} in its sub workspace ${sub.label} runs something`);
	}
	const here = await panes(run, workspaceId), sessionAt = (p: Pane) => live.find((s) => s.herdrLocation?.paneId === p.pane_id);
	for (const t of await tabs(run, workspaceId)) {
		const tab: StashTab = { ...(t.label ? { label: t.label } : {}), panes: [] };
		for (const p of here.filter((x) => x.tab_id === t.tab_id)) {
			const cwd = p.cwd ?? ws.worktree?.checkout_path ?? "", session = sessionAt(p), who = session?.name ?? `pane ${p.pane_id}`;
			if (!p.agent) {
				const fg = await foreground(run, p.pane_id);
				if (!cwd && resume) reasons.push(`pane ${p.pane_id} has no folder Herdr knows of`);
				if (!fg) reasons.push(`Herdr cannot say what runs in pane ${p.pane_id}`);
				else if (fg.length) reasons.push(`pane ${p.pane_id} runs ${fg.join(", ")}`);
				tab.panes.push({ kind: "shell", cwd });
				continue;
			}
			const role = p.tokens?.sb_role ?? "";
			if (p.agent !== "pi") reasons.push(`pane ${p.pane_id} runs ${p.agent}, which Straw Boss cannot ask to quit`);
			else if (!ROLES.has(role)) reasons.push(`${who} is a subagent or outside the net`);
			if (p.agent !== "pi" || !ROLES.has(role)) continue;
			if (!SETTLED.has(p.agent_status ?? "")) reasons.push(`${who} is ${p.agent_status ?? "in an unknown state"}`);
			// A path Herdr names whose file does not exist yet is a session that never replied: nothing to resume, it starts fresh at pop.
			const named = p.agent_session?.value, file = named && existsSync(named) ? named : undefined;
			if (!named && resume) reasons.push(`${who} has no session file Herdr knows of`);
			if (!cwd && resume) reasons.push(`${who} has no folder Herdr knows of`);
			if (session) agents.push(session);
			else reasons.push(`${who} is not on the intercom net`);
			tab.panes.push({ kind: role as StashRole, cwd, ...(file ? { session: file } : {}), ...(session?.name ? { name: session.name } : {}) });
		}
		if (tab.panes.length) out.push(tab);
	}
	const towered = (t: StashTab) => t.panes.some((p) => p.kind === "tower");
	const tabsOut = [...out.filter(towered), ...out.filter((t) => !towered(t))];
	const cwd = tabsOut.flatMap((t) => t.panes).find((p) => p.kind === "tower")?.cwd ?? ws.worktree?.checkout_path ?? tabsOut[0]?.panes[0]?.cwd ?? "";
	if (!tabsOut.length && resume) reasons.push(`${ws.label} has nothing in it to stash`);
	return { label: ws.label, cwd, tabs: tabsOut, reasons, agents };
}

/** Each session's own side, through its bridge. A bridge that has not told this server about itself yet (one just started) gets another round after the net is read again. */
async function askSessions(d: Pick<StashDeps, "sleep" | "check">, agents: Session[], refresh?: () => Promise<unknown>) {
	const reasons: string[] = [], named = (s: Session) => s.name ?? s.id.slice(0, 8);
	let pending = agents;
	for (let round = 0; pending.length && round < CHECK_ROUNDS; round++) {
		if (round) (await d.sleep(CHECK_GAP_MS), await refresh?.());
		const got = await Promise.all(pending.map(async (s) => ({ s, r: await d.check(s.id) })));
		for (const { s, r } of got) if (r?.reason) reasons.push(`${named(s)}: ${r.reason}`);
		pending = got.filter(({ r }) => !r).map(({ s }) => s);
	}
	for (const s of pending) reasons.push(`${named(s)} did not answer the check (an older pi-straw-boss, or a stuck session)`);
	return reasons;
}

/**
 * Close all: the invoker's own base (its tower, mains, members, and shells; never another base, a sub workspace, or a workspace outside the net)
 * is checked as a stash checks it, minus what only a pop needs; any refusal closes nothing. Then it closes as its close button does, each session
 * quitting only while it can still be stashed. The base is looked at again just before it closes, and the server's own session, when it sits
 * there, is asked again too (its batch does not ask it).
 */
export async function closeAll(d: Pick<StashDeps, "run" | "sleep" | "sessions" | "check">, me: string, closeBase: (workspace: string) => Promise<Reply>, refresh?: () => Promise<unknown>, by?: string, workspace?: string): Promise<Reply> {
	const live = await d.sessions(), alive = new Set(live.map((s) => s.id)), ps = await panes(d.run), lives = (p: Pane) => live.some((s) => s.herdrLocation?.paneId === p.pane_id);
	// Only the invoker's own base: the other bases of the net are not its to close.
	const baseOf = (id?: string) => (id ? live.find((s) => s.id === id)?.herdrLocation?.workspace?.id : undefined), mine = baseOf(me), theirs = workspace ?? baseOf(by);
	if (!theirs) return no(400, "bad_request", "Close all needs a base: name its workspace, or ask from a session of the net.");
	// A role token outlives its pi up to its TTL: only a live tower, main, or member puts a workspace on the net.
	const bases = (await workspaces(d.run)).filter((w) => w.workspace_id === theirs && !isSub(w) && ((w.tokens?.tower && alive.has(w.tokens.tower)) || ps.some((p) => p.workspace_id === w.workspace_id && (p.tokens?.sb_role === "main" || p.tokens?.sb_role === "member") && lives(p))));
	if (!bases.length) return no(404, "not_found", "That workspace is not a base on the net.");
	const surveyAll = async (sessions: Session[]) => Promise.all(bases.map(async (w) => ({ w, sv: await survey(d.run, w.workspace_id, sessions, false) })));
	const first = await surveyAll(live), reasons = first.flatMap(({ w, sv }) => (sv ? sv.reasons.map((r) => `${w.label}: ${r}`) : []));
	reasons.push(...(await askSessions(d, first.flatMap(({ sv }) => sv?.agents ?? []), refresh)));
	if (!reasons.length) reasons.push(...(await surveyAll(await d.sessions())).flatMap(({ w, sv }) => (sv?.reasons ?? []).map((r) => `${w.label}: ${r}`)));
	if (reasons.length) return no(409, "refused", `Nothing was closed: ${reasons.join("; ")}.`);
	const order = bases, done: string[] = [];
	const stop = (why: string) => no(409, "close_failed", `${why} Closed before it: ${done.join(", ") || "none"}; the rest stay open.`);
	for (const w of order) {
		// The run takes minutes: each base is looked at again just before it closes (a shell job, a subagent left running), and the server's own
		// session, which its batch does not ask, is checked again before its base closes with it.
		const sv = await survey(d.run, w.workspace_id, await d.sessions(), false);
		if (!sv) continue; // closed by someone else meanwhile
		const late = [...sv.reasons, ...(w.workspace_id === mine ? ((r) => (r?.reason ? [r.reason] : r ? [] : ["this server's session did not answer"]))(await d.check(me)) : [])];
		if (late.length) return stop(`${w.label} cannot close now: ${late.join("; ")}.`);
		const r = await closeBase(w.workspace_id);
		if (r.status === 404) continue;
		if (r.status !== 200) return stop((r.body as { reason?: string }).reason ?? `${w.label} did not close.`);
		done.push(w.label);
	}
	return { status: 200, body: { closed: done } };
}

/** `me`: the server's own session, which its batch does not ask: it is checked again when it sits in the base. */
export interface StashDeps { run: HerdrRun; sleep: Sleep; sessions(): Promise<Session[]>; check(key: string): Promise<{ reason?: string } | undefined>; stateDir: string; now?: () => Date; me?: string }

/** The server's stash: every check first (nothing closes on a refusal), then the manifest, then `closeBase` (the close-base batch). */
export async function stashBase(d: StashDeps, json: Record<string, unknown>, closeBase: (workspace: string) => Promise<Reply>, refresh?: () => Promise<unknown>): Promise<Reply> {
	if (!str(json.workspace) || json.workspace.length > 200) return no(400, "bad_request", "A base is named by its workspace.");
	// Without a name (the page's Stash) the base's label names it, made a free, valid name.
	if (json.name !== undefined && !nameOk(json.name)) return no(400, "bad_request", `A stash name has at most ${MAX_NAME} characters, no slash, backslash, or control character, and does not start with a dot.`);
	if (typeof json.name === "string" && existsSync(stashFile(d.stateDir, json.name))) return no(409, "exists", `Something is stashed as "${json.name}" already; pop it or pick another name.`);
	const sv = await survey(d.run, json.workspace, await d.sessions());
	if (!sv) return no(404, "not_found", "That base is not open any more.");
	const reasons = [...sv.reasons, ...(await askSessions(d, sv.agents, refresh))];
	// Herdr's side once more, since the rounds took seconds: a shell job or a subagent started meanwhile refuses too. The sessions' own side is
	// asked again by the close itself (`ifStashable`), so a turn started now refuses that session's quit and stops the batch.
	if (!reasons.length) reasons.push(...((await survey(d.run, json.workspace, await d.sessions()))?.reasons ?? ["the base is not open any more"]));
	// The server's own session quits only with its workspace, unasked: when it sits in the base, it is asked once more now.
	if (!reasons.length && d.me && (await d.sessions()).find((s) => s.id === d.me)?.herdrLocation?.workspace?.id === json.workspace) {
		const r = await d.check(d.me);
		if (!r || r.reason) reasons.push(r?.reason ?? "this server's session did not answer");
	}
	if (reasons.length) return no(409, "refused", `Nothing was stashed: ${reasons.join("; ")}.`);
	const name = typeof json.name === "string" ? json.name : nameFor(sv.label, d.stateDir), file = stashFile(d.stateDir, name);
	const stash: Stash = { version: 1, name, label: sv.label, cwd: sv.cwd, stashedAt: (d.now?.() ?? new Date()).toISOString(), tabs: sv.tabs };
	if (!stashOk(stash)) return no(500, "unreadable", "Nothing was stashed: the manifest would not be one a pop can read.");
	mkdirSync(dirOf(d.stateDir), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(stash, null, 2), { mode: 0o600, flag: "wx" });
	const closed = await closeBase(json.workspace);
	if (closed.status === 200) return { status: 200, body: { stashed: name, sessions: sv.agents.length } };
	// A batch that stopped half way leaves sessions running beside ones that quit: popping would run a session file twice, so the manifest goes.
	rmSync(file, { force: true });
	const quit = sv.tabs.flatMap((t) => t.panes).filter((p) => p.session).map((p) => `${p.name ?? "?"}: pi --session ${p.session}`);
	const why = (closed.body as { reason?: string }).reason ?? "the base did not close";
	return no(closed.status, "stash_failed", `${why} Nothing is stashed; a session that did quit resumes with its own file (${quit.join("; ")}).`);
}

/** `agentDir`: the popping session's PI_CODING_AGENT_DIR, when it runs under one, so each pi resumes with the same settings and extensions. */
export interface PopDeps { run: HerdrRun; sleep: Sleep; stateDir: string; live(sessionId: string): Promise<boolean>; agentDir?: string; now?: () => Date; trustDir?: string }
const RANK: Record<StashPane["kind"], number> = { tower: 0, main: 1, member: 2, shell: 3 };
const roleEnv = (kind: StashPane["kind"]) => (kind === "shell" ? [] : [`STRAW_BOSS_ROLE=${kind}`]), flags = (env: string[]) => env.flatMap((e) => ["--env", e]);

/** Resumes one pi in its pane and waits until it is back in its role (a member may come back as the tab's main: the guard's choice). */
async function resume({ run, sleep, live, trustDir }: PopDeps, ws: string, paneId: string, p: StashPane) {
	if (p.kind === "tower") await report(run, "pane", paneId, { sb_role: "tower" });
	if (p.kind === "main") await report(run, "pane", paneId, { sb_open_main: "1" }); // authorises exactly this pi to promote itself (session.ts)
	// Herdr agent names are unique across workspaces and lowercase only.
	const agent = p.kind === "tower" ? `tower-${ws.toLowerCase()}` : `${p.kind}-${randomUUID().slice(0, 8)}`;
	await startPi(run, sleep, agent, paneId, [...(p.session ? ["--session", p.session] : []), ...(p.name ? ["--name", p.name] : [])]);
	const watch = trustDir ? { dir: trustDir, pane: paneId } : undefined; // a trust question the pi waits on is not counted (trust/wait.ts)
	const back = p.kind === "tower"
		? await waitPastTrust(sleep, async () => ((id) => id && live(id))((await workspaces(run)).find((w) => w.workspace_id === ws)?.tokens?.tower), JOIN_MS, 1000, watch)
		: await waitPastTrust(sleep, async () => ((r) => (p.kind === "main" ? r === "main" : r === "member" || r === "main"))((await panes(run, ws)).find((x) => x.pane_id === paneId)?.tokens?.sb_role), JOIN_MS, 500, watch);
	if (!back) throw new Error(`${p.name ?? p.session ?? p.kind} did not come back as the ${p.kind} within ${JOIN_MS / 1000} s (pane ${paneId})`);
}

/**
 * Opens the stash `name` in a new workspace; on any failure the new workspace closes and the manifest goes back, so popping again starts over.
 * The manifest is claimed first by moving it into stash/.popping/ (one rename, which only one session wins), so two pops never run one session file twice.
 */
export async function popBase(d: PopDeps, name: string): Promise<{ workspace: string; label: string; sessions: number }> {
	if (!nameOk(name)) throw new Error(`"${name}" is not a stash name`);
	const claimed = join(dirOf(d.stateDir), ".popping", `${name}.json`);
	mkdirSync(dirname(claimed), { recursive: true, mode: 0o700 });
	try {
		renameSync(stashFile(d.stateDir, name), claimed);
	} catch (error) {
		throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `Nothing is stashed as "${name}" (or another session is popping it)` : (error as Error).message);
	}
	try {
		const r = await open(d, name, claimed);
		mkdirSync(join(dirOf(d.stateDir), "popped"), { recursive: true, mode: 0o700 });
		renameSync(claimed, join(dirOf(d.stateDir), "popped", `${name}-${(d.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}.json`));
		return r;
	} catch (error) {
		// Back under its name, unless something was stashed under it meanwhile: then under a free one, never over the other.
		const back = existsSync(stashFile(d.stateDir, name)) ? nameFor(name, d.stateDir) : name;
		linkSync(claimed, stashFile(d.stateDir, back));
		rmSync(claimed, { force: true });
		throw back === name ? error : new Error(`${(error as Error).message}; it is stashed again as "${back}", since "${name}" was taken meanwhile`);
	}
}
async function open(d: PopDeps, name: string, file: string) {
	const { run } = d, st = readStash(d.stateDir, name, file), all = st.tabs.flatMap((t) => t.panes);
	const envOf = (kind: StashPane["kind"]) => [...roleEnv(kind), ...(d.agentDir ? [`PI_CODING_AGENT_DIR=${d.agentDir}`] : [])];
	const gone = [...new Set([...all.filter((p) => p.session && !existsSync(p.session)).map((p) => p.session!), ...all.map((p) => p.cwd).filter((c) => !statSync(c, { throwIfNoEntry: false })?.isDirectory())])];
	if (gone.length) throw new Error(`Nothing was opened: ${gone.join(", ")} no longer exist${gone.length > 1 ? "" : "s"}`);
	// Every pi to start is looked at before anything is made: pi reads a folder's .pi/settings.json at startup, before any extension can stop it (trust/settings.ts).
	await assertSettingsSafe(all.filter((p) => p.kind !== "shell").map((p) => p.cwd), "The stash");
	const root = st.tabs[0]!.panes[0]!;
	const created = await result(run, ["workspace", "create", "--cwd", root.cwd, "--label", st.label, "--no-focus", ...flags(envOf(root.kind))]);
	const ws: string = created.workspace.workspace_id;
	try {
		let sessions = 0;
		for (const [i, tab] of st.tabs.entries()) {
			const ids: string[] = [];
			for (const [j, p] of tab.panes.entries()) {
				if (i === 0 && j === 0) ids.push(created.root_pane.pane_id as string);
				else if (j === 0) ids.push((await createTab(run, ws, p.cwd, envOf(p.kind), tab.label)).paneId);
				else ids.push((await result(run, ["pane", "split", ids[j - 1]!, "--direction", "right", "--cwd", p.cwd, "--no-focus", ...flags(envOf(p.kind))])).pane.pane_id as string);
			}
			if (i === 0 && tab.label) await run(["tab", "rename", created.tab.tab_id as string, tab.label]);
			const starts = tab.panes.map((p, j) => ({ p, pane: ids[j]! })).filter(({ p }) => p.kind !== "shell").sort((a, b) => RANK[a.p.kind] - RANK[b.p.kind]);
			for (const { p, pane } of starts) (await resume(d, ws, pane, p), sessions++);
		}
		return { workspace: ws, label: st.label, sessions };
	} catch (error) {
		await run(["workspace", "close", ws]).catch(() => {});
		throw error;
	}
}
