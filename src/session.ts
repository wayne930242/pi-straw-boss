import type { Briefing } from "./briefing.ts";
import type { Guard } from "./guard.ts";
import { answers, newer, readRecord } from "./handover.ts";
import { isSub, panes, place, report, waitFor, workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import { CONNECT_MS, type Membership } from "./membership.ts";
import { orphans } from "./orphan.ts";
import type { Presence } from "./presence.ts";
import type { Reach } from "./reach.ts";
import { ENTRY, type Kit } from "./state.ts";

const KID_MARK_MS = [3_000, 15_000];
const SUBAGENT_TOOLS = ["subagent", "subagent_resume"];

/** What the session does at its start, around each run, and at its end. */
export function registerSession(kit: Kit, { briefing, presence, membership, guard, host, reach, startTower }: { briefing: Briefing; presence: Presence; membership: Membership; guard: Guard; host: ReturnType<typeof createHost>; reach: Reach; startTower(): Promise<void> }) {
	const { pi, cfg, s, guiDir, me, role, tell } = kit;
	const { run, env, version } = cfg;
	// Watches for subagents this session launched whose result can no longer reach it (orphan.ts), and the watch on the Herdr server.
	let nudges: ReturnType<typeof orphans> | undefined, nudgeTimer: ReturnType<typeof setInterval> | undefined, unwatch: (() => void) | undefined;
	const stopWatching = () => {
		clearInterval(nudgeTimer);
		nudges?.stop();
		unwatch?.();
		unwatch = undefined;
	};
	// A session in a sub workspace (a linked git worktree) acts like a subagent: it never joins. Failing to tell bars it too.
	const barReason = async () => {
		try {
			const { workspaceId } = await place(run);
			const all = await workspaces(run);
			const sub = all.find((w) => w.workspace_id === workspaceId);
			return sub && isSub(sub) ? { text: `${sub.label} is a sub workspace, so this session cannot join the net; the main agent of its parent workspace represents it`, level: "info" as const } : undefined;
		} catch (error) {
			return { text: `Straw Boss could not tell whether this is a sub workspace: ${(error as Error).message}`, level: "error" as const };
		}
	};
	// A tab the tower opened for a request starts its pi with this role: it promotes itself as soon as it has joined (opener.ts).
	const opensAsMain = env.STRAW_BOSS_ROLE === "main";
	// STRAW_BOSS_ROLE=main stays in the new tab's shell, so a later pi started there would self-promote. The tower's one-time pane token is what
	// authorises it: this pi consumes the token and keeps the opener's marker (sb_opened_by) fresh, which the tower counts to enforce its limits.
	const claimOpened = async () => {
		if (!opensAsMain) return false;
		const mine = (await panes(run, s.at.workspaceId).catch(() => [])).find((p) => p.pane_id === s.at.paneId);
		if (mine?.tokens?.sb_open_main !== "1") return false;
		s.openedBy = mine.tokens.sb_opened_by;
		await report(run, "pane", s.at.paneId, { sb_open_main: null }).catch(() => {});
		return true;
	};

	pi.on("session_start", async (event, ctx) => {
		s.stopped = false;
		s.ui = ctx.ui;
		s.hasUI = ctx.hasUI;
		s.quit = () => ctx.shutdown();
		briefing.load();
		s.saved = Object.assign({}, ...ctx.sessionManager.getBranch().flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [e.data] : [])));
		s.isTower ||= Boolean(s.saved.tower);
		const log = ctx.sessionManager;
		stopWatching();
		nudges = orphans({ run, file: () => log.getSessionFile(), entries: () => log.getEntries(), sessions: host.sessions, send: reach.send, type: ENTRY, remember: (key) => pi.appendEntry(ENTRY, { nudged: key }), me, tell });
		nudgeTimer = setInterval(() => void nudges?.poll().catch(() => {}), cfg.nudgeMs).unref();
		// Starting runs in the background: pi awaits session_start handlers in turn, and pi-intercom connects in its own, after this one.
		let starting: Promise<void> | undefined;
		if (s.isTower) {
			unwatch = cfg.watch(presence.restore);
			starting = startTower();
		} else {
			const bar = await barReason();
			s.barred = bar?.text;
			if (bar) {
				tell(bar.text, bar.level);
			} else {
				if (!s.stopped) unwatch = cfg.watch(presence.restore); // a shutdown that came while Herdr was asked about the workspace has stopped nothing yet
				starting = membership.joinNet().then(async () => {
					const taken = (await claimOpened()) && (await membership.promote(false));
					if (taken && !taken.promoted) tell(taken.text, "warning");
				});
			}
		}
		starting?.catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
		// The GUI this process ran before a /reload, /new, or /resume starts again on its URL, and a session newer than the running server
		// takes it over, once pi-intercom has published this session's id: the server's dialogs are routed by it.
		// A /new, /resume, or /fork is another session: it waits for the new id, not the one pi-intercom may still show from before.
		const record = readRecord(guiDir), back = record?.reload && record.pid === process.pid && event.reason !== "startup";
		const ready = () => Boolean(me()) && (!back || event.reason === "reload" || me() !== record!.ownerSession);
		if (back || (record && newer(version, record.version))) void (async () => {
			if ((await waitFor(cfg.sleep, ready, CONNECT_MS)) && (back || (await answers(record!)))) await host.restore(Boolean(back && record!.remote));
		})().catch(() => {});
	});

	pi.on("before_agent_start", (event) => briefing.begin(event.systemPromptOptions.sections));
	pi.on("agent_settled", () => briefing.settled());

	// A member that dispatches or resumes a subagent without promoting is promoted here, before the subagent starts, unless the tab already has a main.
	// A tower only coordinates: it dispatches no subagent (one would outlive it with no one to take its result), and opens a main for the work instead.
	pi.on("tool_call", async (event) => {
		if (!SUBAGENT_TOOLS.includes(event.toolName) || s.barred) return;
		if (s.isTower) return { block: true, reason: "A tower dispatches no subagents. Open a main for this work with boss_open_main, or route it to the main that owns it." };
		try {
			await membership.joinNet();
			if (!s.isMain) await membership.promote(false);
		} catch (error) {
			tell(`Straw Boss: ${(error as Error).message}`, "warning");
		}
	});

	// A launched subagent is marked within seconds, once its pane shows its session file, instead of at the next 4 minute refresh.
	pi.on("tool_result", (event) => {
		if (SUBAGENT_TOOLS.includes(event.toolName) && !s.isTower && !s.barred && role()) for (const ms of KID_MARK_MS) setTimeout(() => void presence.publish(), ms).unref();
	});

	pi.on("session_shutdown", async (event) => {
		// A closed session, and a tower that quits however it was asked, take their pane with them (and an emptied tab); a /reload, /new, resume or fork keeps it.
		if ((s.closing ? !s.closing.keepPane : s.isTower) && event.reason === "quit" && env.HERDR_PANE_ID) cfg.later(process.pid, ["pane", "close", env.HERDR_PANE_ID]);
		await host.release(event.reason !== "quit"); // a /reload, /new, or /resume starts the GUI again in this process
		s.dashboard?.stop();
		s.dashboard = undefined;
		presence.stop();
		guard.stop();
		stopWatching();
		s.stopped = true; // a refresh still in flight must not write tokens after they are cleared
		await presence.settled();
		const held = s.holdsTower;
		s.holdsTower = false;
		if (!role() || !s.at) return;
		await presence.clear();
		// A tower that quits says so with the members the base has, so the mains are cleared at once instead of after the grace a /reload gets,
		// and the guard opens no new tower until the base grows past them.
		const members = event.reason === "quit" && held ? (await panes(run, s.at.workspaceId).catch(() => [])).filter((p) => ["member", "main"].includes(p.tokens?.sb_role ?? "")).length : 0;
		if (held) await report(run, "workspace", s.at.workspaceId, { tower: null, ...(event.reason === "quit" ? { sb_tower_quit: String(members) } : {}) }).catch(() => {});
	});
}
