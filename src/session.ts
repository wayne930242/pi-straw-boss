import type { Briefing } from "./briefing.ts";
import type { Digest } from "./digest.ts";
import type { Guard } from "./guard.ts";
import { answers, newer, readRecord } from "./handover.ts";
import { herdrSocket, isSub, panes, place, report, waitFor, workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import { CONNECT_MS, type Membership } from "./membership.ts";
import { orphans } from "./orphan.ts";
import type { Presence } from "./presence.ts";
import type { Reach } from "./reach.ts";
import { ENTRY, type Kit } from "./state.ts";

const KID_MARK_MS = [3_000, 15_000];
const SUBAGENT_TOOLS = ["subagent", "subagent_resume"];

/** What the session does at its start, around each run, and at its end. */
export function registerSession(kit: Kit, { briefing, presence, membership, guard, host, reach, digest, startTower }: { briefing: Briefing; presence: Presence; membership: Membership; guard: Guard; host: ReturnType<typeof createHost>; reach: Reach; digest: Digest; startTower(): Promise<void> }) {
	const { pi, cfg, s, guiDir, me, role, tell } = kit;
	const { run, env, version } = cfg;
	const who = () => pi.getSessionName() || s.ownName || me().slice(0, 8);
	// What the tower learns at its next run (digest.ts); a line that cannot be written is not worth failing anything for.
	const note = (text: string) => void digest.note(s.at.workspaceId, text).catch(() => {});
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
		host.watch(); // the server of a session that ended without a stop is taken over here (host.ts)
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
					note(`${who()} joined tab ${s.info.tab}`);
					const taken = (await claimOpened()) && (await membership.promote(false));
					if (taken && !taken.promoted) tell(taken.text, "warning");
				});
			}
		}
		starting?.catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
		// The GUI this process ran before a /reload, /new, or /resume starts again on its URL, and a session newer than the running server
		// takes it over (one with a screen: a print run is no host, and one on the Herdr the server serves), once pi-intercom has published this session's id: the server's dialogs are routed by it.
		// Under gui.lock the restore keeps a stop typed while it waited, and a takeover does not start a server that went down meanwhile: a survivor adopts that.
		// A /new, /resume, or /fork is another session: it waits for the new id, not the one pi-intercom may still show from before.
		const record = readRecord(guiDir), back = record?.reload && !record.stopped && record.pid === process.pid && event.reason !== "startup";
		const ready = () => Boolean(me()) && (!back || event.reason === "reload" || me() !== record!.ownerSession);
		if (back || (record && ctx.hasUI && newer(version, record.version) && (!record.herdr || record.herdr === herdrSocket(env)))) void (async () => {
			if ((await waitFor(cfg.sleep, ready, CONNECT_MS)) && (back || (await answers(record!)))) await host.restore(Boolean(back && record!.remote), back ? { stopped: true } : { stopped: true, down: true });
		})().catch(() => {});
	});

	// The tower's run starts with what happened in its workspace since its last run, and the digest is cleared as it is read.
	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		briefing.begin(sections);
		if (!s.holdsTower || !sections[ENTRY]) return;
		const lines = await digest.take(s.at.workspaceId).catch(() => []);
		if (lines.length) sections[ENTRY] += `\n\nSince your last run:\n${lines.map((line) => `- ${line}`).join("\n")}`;
	});
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
		if (!SUBAGENT_TOOLS.includes(event.toolName) || s.isTower || s.barred || !role()) return;
		for (const ms of KID_MARK_MS) setTimeout(() => void presence.publish(), ms).unref();
		const { name, agent } = event.input as { name?: unknown; agent?: unknown };
		if (!event.isError) note(`${who()} ${event.toolName === "subagent" ? "started" : "resumed"} subagent ${typeof name === "string" && name ? name : "unnamed"}${typeof agent === "string" && agent ? ` (${agent})` : ""}`);
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
