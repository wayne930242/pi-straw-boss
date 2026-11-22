import { randomUUID } from "node:crypto";
import { alive } from "./remote.ts";
import { boardState, readTrainboards } from "./train/board.ts";
import { createTab, type Pane, panes, report, type HerdrRun, type Session, type Sleep, startPi, workspaces } from "./herdr.ts";
import { integratorOf } from "./integrator.ts";
import type { CoordinatorDuty } from "./duty.ts";
import { assertSettingsSafe } from "./trust/settings.ts";
import { isRoleLabel, TRAIN, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";
import { waitPastTrust } from "./trust/wait.ts";
import { tabLabel } from "./tablabel.ts";
import { MAIN_WAIT_MS, MAX_OPENED_MAINS, OpenLimitError, type OpenerEnv, type Revived, type ReviveRequest } from "./opener.ts";
import { type DeadRow, deathKey, failedIn, gatherDead, keyOf, MAX_REVIVES, pick, readLedger, REVIVABLE, REVIVE_TOKEN, ReviveRefused, reviveHandoff, revivedIn, roleRefusal, sessionHeader, sessionNotes, sessionsDir, takeLock, updateLedger } from "./revive.ts";

// The two openings a tower's and a main's own: the revive of a dead main or train (docs/specs/2026-11-23-tower-revive.md §4), which the opener runs on its queue (opener.ts `revive`), and a main's
// successor (§8, tools.ts `boss_handover`). Both make a tab the way an open does (createTab, the one-time claim, startPi, the wait for the pi's role) and close it when they fail.

/**
 * The panes whose pi is live, as the caps, the integrator twin, and the train code count them (RVR-F001): pi runs there and the broker lists a session at it. A pi that died leaves its sb tokens on its pane until their
 * TTL runs out (up to 10 min, herdr.ts), which is just when its death is raised, so a pane is counted by its live pi and never by its tokens alone; and the dead session's own old pane is never its rival.
 */
export const livePanes = (ps: Pane[], sessions: Session[], own?: string): Pane[] => ps.filter((p) => p.pane_id !== own && p.agent === "pi" && sessions.some((s) => s.herdrLocation?.paneId === p.pane_id));

/** The tab label of a revived session: its train's, or its own name's. */
const reviveLabel = (r: DeadRow) => (r.train ? trainLabel(r.train.code) : r.name ? tabLabel(r.name) : undefined);

/**
 * The revive of a dead main or train (docs/specs/2026-11-23-tower-revive.md §4): the same session file in a new tab of this workspace, as the same sb identity. It shares the open's queue, so an open and a revive never count the
 * caps at once; a refusal opens nothing and is kept in the session's ledger with its reason.
 */
export async function reviveMain(env: OpenerEnv, { session, reason, origin }: ReviveRequest): Promise<Revived> {
	const { run, sleep } = env;
	if (!env.stateDir) throw new ReviveRefused("this tower keeps no state folder, so it reads no role record");
	const why = reason.trim();
	if (!why || why.length > 300 || /[\r\n]/.test(why)) throw new ReviveRefused("reason is one line of 1 to 300 characters: why this session is revived");
	const workspace = (await workspaces(run)).find((w) => w.workspace_id === env.workspaceId);
	if (!workspace) throw new Error(`Workspace ${env.workspaceId} is not open any more`);
	const dir = workspace.worktree?.checkout_path ?? env.cwd, root = env.sessionsRoot ?? sessionsDir();
	const look = async () => {
		const [everywhere, sessions] = await Promise.all([panes(run), env.sessions()]);
		const rows = await gatherDead({ stateDir: env.stateDir!, run, now: Date.now(), sessions: async () => sessions, root, checkout: dir, recovering: env.recovering?.() ?? false, panes: everywhere, sessionList: sessions, allNotes: true });
		return { everywhere, sessions, rows };
	};
	const first = await look();
	const row = pick(first.rows, session);
	// Only the record's own workspace's tower revives it: another tower would open it far from its tab, and two towers would race.
	if (row.record.workspace !== workspace.workspace_id) throw new ReviveRefused(`it is a session of workspace ${row.record.workspace}; that workspace's tower revives it`);
	if (row.record.role === TRAIN && !row.train) throw new ReviveRefused("its record names no train");
	if (!REVIVABLE.includes(row.verdict.state)) throw new ReviveRefused(`it is ${row.verdict.state}: ${row.verdict.reason}`);
	const rivals = livePanes(first.everywhere, first.sessions, row.record.pane);
	const refusal = roleRefusal(row, { integrationOff: env.integrationOff?.() ?? false, live: rivals, sessions: first.sessions });
	if (refusal) throw new ReviveRefused(refusal);
	const unlock = takeLock(env.stateDir, row.file, Date.now());
	try {
		const now = Date.now(), ledger = readLedger(env.stateDir, row.file, row.session), key = deathKey(row.file) ?? "";
		const tried = ledger.attempts.find((a) => a.key === key && a.outcome !== "refused");
		if (tried) throw new ReviveRefused(`this death was already tried at ${new Date(tried.at).toISOString()} (${tried.outcome}${tried.error ? `: ${tried.error}` : ""}); a tower tries each death once, and the boss decides a retry`);
		const failed = failedIn(ledger, now).at(-1);
		if (failed) throw new ReviveRefused(`a revive of it failed at ${new Date(failed.at).toISOString()} (${failed.error ?? "no reason kept"}); a tower does not try it again for 24 h, and the boss decides a retry`);
		const recent = revivedIn(ledger, now);
		if (recent.length >= MAX_REVIVES) throw new ReviveRefused(`it was revived ${recent.length} times in the last 24 h (the limit is ${MAX_REVIVES}): it keeps dying, so the boss looks at it first`);
		// A train has its own checks (§4, P4): its board says it is still under way, its writer is gone, and no pane carries its code; the open's "a code is used once" is set aside on this path only.
		const train = row.train;
		if (train) {
			const read = readTrainboards(env.stateDir, { project: train.project }).trains.find((b) => b.code === train.code);
			if (!read?.ok) throw new ReviveRefused(`the trainboard of ${trainLabel(train.code)} of project ${train.project} cannot be read${read && !read.ok ? `: ${read.reason}` : ""}`);
			if (read.end || boardState(read.board, { now, alive: false, ...(read.end ? { end: read.end } : {}) }) === "ended") throw new ReviveRefused(`${trainLabel(train.code)} of project ${train.project} has ended (its board says so); a new train takes a new code`);
			if (read.board.writer.session !== row.session) throw new ReviveRefused(`the trainboard of ${trainLabel(train.code)} was written by session ${read.board.writer.session.slice(0, 8)}, not this one`);
			if (alive(read.board.writer.pid)) throw new ReviveRefused(`the writer of ${trainLabel(train.code)}'s board (pid ${read.board.writer.pid}) is still running`);
			if (rivals.some((p) => trainFromToken(p.tokens?.sb_train)?.code === train.code && trainFromToken(p.tokens?.sb_train)?.project === train.project)) throw new ReviveRefused(`a live pane carries ${trainLabel(train.code)} of project ${train.project}`);
			if (env.integrationOff?.()) throw new ReviveRefused("a train is not revived: integration is off on this computer");
		}
		// The caps of an opened main (§5): a tower-opened main takes its place back, so a sender that has another opened main now, or a workspace at the limit, refuses it. A boss-opened main counts toward neither.
		const here = rivals.filter((p) => p.workspace_id === workspace.workspace_id);
		const marked = here.filter((p) => p.tokens?.sb_opened_by && !integratorOf(p.tokens.sb_opened_by) && p.tokens.sb_role !== TRAIN && !(p.tokens.sb_role === undefined && p.tokens.sb_train));
		if (!train && row.openedBy && !integratorOf(row.openedBy)) {
			const ofSender = marked.filter((p) => p.tokens!.sb_opened_by === row.openedBy).length;
			if (ofSender) throw new ReviveRefused(`its sender ${row.openedBy.slice(0, 40)} already has an opened main running in workspace ${workspace.label} (a sender gets one at a time): close one first`);
			if (marked.length >= MAX_OPENED_MAINS) throw new ReviveRefused(`workspace ${workspace.label} already has ${marked.length} mains opened by its tower (the limit is ${MAX_OPENED_MAINS})`);
		}
		const cwd = sessionHeader(row.file)?.cwd ?? dir;
		await assertSettingsSafe([cwd]);
		// The second look, just before the start: a Herdr restore or a hand `pi --session` that came meanwhile wins.
		const again = (await look()).rows.find((r) => r.file === row.file);
		if (!again || !REVIVABLE.includes(again.verdict.state)) throw new ReviveRefused(`it is ${again?.verdict.state ?? "gone"} now${again ? `: ${again.verdict.reason}` : ""}`);
		const { tabId, paneId } = await createTab(run, workspace.workspace_id, cwd, [`STRAW_BOSS_ROLE=${train ? TRAIN : "main"}`], reviveLabel(row));
		const attempt = (outcome: "revived" | "failed", more: { error?: string; tab?: string; pane?: string } = {}) => updateLedger(env.stateDir!, row.file, Date.now(), (l) => void l.attempts.push({ at: Date.now(), key, by: env.tower().id, outcome, reason: why, ...more }));
		try {
			await report(run, "pane", paneId, { sb_open_main: "1", [REVIVE_TOKEN]: keyOf(row.file), ...(row.openedBy ? { sb_opened_by: row.openedBy } : {}), ...(train ? { sb_train: trainToken(train) } : {}), ...(!train && row.record.duty && !sessionNotes(row.file).duty ? { sb_open_duty: row.record.duty } : {}) });
			// pi restores the session's own name under --session, so no --name is given.
			await startPi(run, sleep, `revive-${randomUUID().slice(0, 8)}`, paneId, ["--session", row.file]);
			const wanted = train ? TRAIN : "main";
			const main = await waitPastTrust(sleep, async () => {
				const tokens = (await panes(run, workspace.workspace_id)).find((p) => p.pane_id === paneId)?.tokens;
				if (tokens?.sb_role !== wanted) return undefined;
				const mine = (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId);
				if (mine && mine.id !== row.session) throw new Error(`the pi in pane ${paneId} joined as session ${mine.id.slice(0, 8)}, not ${row.session.slice(0, 8)}: it is no revive of that session`);
				return mine;
			}, MAIN_WAIT_MS, 500, env.trustDir ? { dir: env.trustDir, pane: paneId } : undefined);
			if (!main) throw new Error(`The pi in pane ${paneId} did not come back as the ${wanted} of session ${row.session.slice(0, 8)} within ${MAIN_WAIT_MS / 1000} s`);
			// Two pis on one session file: a restore or a hand start raced this one, and the other pi wins.
			const twins = (await panes(run)).filter((p) => p.pane_id !== paneId && p.agent_session?.value === row.file);
			if (twins.length) throw new ReviveRefused(`another pane (${twins.map((p) => p.pane_id).join(", ")}) runs this session file now; the revived pi was closed, and that one keeps it`);
			const missed = readLedger(env.stateDir, row.file, row.session).missed;
			const sent = await env.send(main.id, reviveHandoff({ row, tower: env.tower(), tab: tabId, workspace: workspace.label, reason: why, waits: env.waitsOf?.(row.session) ?? [], missed, now: Date.now(), ...(origin ? { origin } : {}) }));
			if (sent.status !== "sent") throw new Error(`The revived ${wanted} ${main.name ?? main.id} did not take the handoff: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
			updateLedger(env.stateDir, row.file, Date.now(), (l) => void (l.missed = []));
			attempt("revived", { tab: tabId, pane: paneId });
			const closedOld = await closeOldTab(env, row, paneId).catch(() => undefined);
			return { tab: tabId, pane: paneId, main: main.id, file: row.file, ...(row.name ? { name: row.name } : {}), ...(row.kind ? { kind: row.kind } : {}), ...(train ? { train } : {}), ...(row.openedBy ? { openedBy: row.openedBy } : {}), ...(closedOld ? { closedOld } : {}) };
		} catch (error) {
			await run(["tab", "close", tabId]).catch(() => {});
			if (!(error instanceof ReviveRefused)) attempt("failed", { error: (error as Error).message.slice(0, 300) });
			throw error;
		}
	} finally {
		unlock();
	}
}
/**
 * D3: the old tab is closed only when the tower opened it (the record names an opener) and its one pane is the dead pane, sitting at a bare shell: `process-info` lists the shell alone in the foreground. Anything else stays for the boss.
 */
async function closeOldTab(env: OpenerEnv, row: DeadRow, newPane: string): Promise<string | undefined> {
	if (!row.openedBy || row.record.tab === undefined) return undefined;
	const inTab = (await panes(env.run, row.record.workspace)).filter((p) => p.tab_id === row.record.tab);
	if (inTab.length !== 1 || inTab[0]!.pane_id !== row.record.pane || inTab[0]!.pane_id === newPane) return undefined;
	const info = JSON.parse(await env.run(["pane", "process-info", "--pane", row.record.pane])).result?.process_info as { shell_pid?: number; foreground_processes?: { pid?: number }[] } | undefined;
	const fg = info?.foreground_processes ?? [];
	if (!(fg.length === 1 && typeof info?.shell_pid === "number" && fg[0]!.pid === info.shell_pid)) return undefined;
	await env.run(["tab", "close", row.record.tab]);
	return row.record.tab;
}
/** What a main's own handover needs (docs/specs/2026-11-23-tower-revive.md §8): the same safe start as an open, in the main's own workspace. */
export interface SuccessorEnv {
	run: HerdrRun;
	sleep: Sleep;
	workspaceId: string;
	cwd: string;
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	trustDir?: string;
}
export interface SuccessorRequest { from: { id: string; name: string }; handoff: string; reason: string; duty?: CoordinatorDuty; openedBy?: string }
export interface Successor { tab: string; pane: string; main: string; name: string }

/** The successor's first prompt: the handoff file to read, and who handed over. Facts only; the session-rotation rule says the rest. */
export const successorPrompt = (r: SuccessorRequest) => [
	`Straw Boss: main ${r.from.name} (session ${r.from.id}) opened this tab for you with boss_handover and handed its work over to you; its reason: ${r.reason}.`,
	`Read the handoff file ${r.handoff} now and follow it as your session-rotation rule describes: resume the loop's book id it names, recreate the monitors and loops it lists, drop completed todos, and keep its replies owed.`,
	`Your kind is already ${r.duty ?? "coordinator"} and your name is the old main's. Then tell ${r.from.name} by intercom (send, to "${r.from.id}") that you took over; it gives up its role after that.`,
].join("\n");

/**
 * Opens a main's successor: a new tab in its workspace with `STRAW_BOSS_ROLE=main`, the one-time claim, the old main's opener and kind, and pi started under the old main's name; once the new pi is the tab's main it gets the handoff
 * path as its first prompt. A failure closes the tab it made. The caller holds the one-successor rule.
 */
export async function openSuccessor(env: SuccessorEnv, r: SuccessorRequest): Promise<Successor> {
	const { run, sleep } = env;
	if (isRoleLabel(tabLabel(r.from.name).trim())) throw new OpenLimitError("this main's name is the label of a tower's or a train's tab; rename it first");
	await assertSettingsSafe([env.cwd]);
	const { tabId, paneId } = await createTab(run, env.workspaceId, env.cwd, ["STRAW_BOSS_ROLE=main"], tabLabel(r.from.name));
	try {
		await report(run, "pane", paneId, { sb_open_main: "1", sb_handover_from: r.from.id, ...(r.openedBy ? { sb_opened_by: r.openedBy } : {}), ...(r.duty ? { sb_open_duty: r.duty } : {}) });
		await startPi(run, sleep, `next-${randomUUID().slice(0, 8)}`, paneId, ["--name", r.from.name]);
		const main = await waitPastTrust(sleep, async () => {
			const tokens = (await panes(run, env.workspaceId)).find((p) => p.pane_id === paneId)?.tokens;
			return tokens?.sb_role === "main" ? (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId && s.id !== r.from.id) : undefined;
		}, MAIN_WAIT_MS, 500, env.trustDir ? { dir: env.trustDir, pane: paneId } : undefined);
		if (!main) throw new Error(`The pi in pane ${paneId} did not become the main agent of its tab within ${MAIN_WAIT_MS / 1000} s`);
		const sent = await env.send(main.id, successorPrompt(r));
		if (sent.status !== "sent") throw new Error(`The successor ${main.name ?? main.id} did not take the handoff: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
		return { tab: tabId, pane: paneId, main: main.id, name: r.from.name };
	} catch (error) {
		await run(["tab", "close", tabId]).catch(() => {});
		throw error;
	}
}
