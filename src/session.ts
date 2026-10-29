import { join } from "node:path";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { removeEntry } from "./board.ts";
import type { Briefing } from "./briefing.ts";
import type { Control } from "./closemain.ts";
import type { Digest } from "./digest.ts";
import type { Guard } from "./guard.ts";
import { isSub, type Place, panes, place, report, waitFor, workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import type { IntegrationWatch } from "./integration.ts";
import { CONNECT_MS, type Membership } from "./membership.ts";
import { orphans } from "./orphan.ts";
import type { RunMode } from "./runmode.ts";
import type { Presence } from "./presence.ts";
import type { Reach } from "./reach.ts";
import type { Roles } from "./roles.ts";
import { ENTRY, type Kit } from "./state.ts";

const KID_MARK_MS = [3_000, 15_000];
const SUBAGENT_TOOLS = ["subagent", "subagent_resume"];
const CHECKING = "Straw Boss is still asking Herdr whether this is a sub workspace; try again in a moment";

/** What the session does at its start, around each run, and at its end. */
export function registerSession(kit: Kit, { runMode, briefing, roles, presence, membership, guard, host, reach, digest, control, integration, startTower }: { runMode: RunMode; briefing: Briefing; roles: Roles; presence: Presence; membership: Membership; guard: Guard; host: ReturnType<typeof createHost>; reach: Reach; digest: Digest; control: Control; integration: IntegrationWatch; startTower(): Promise<void> }) {
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
	let placed: Place | undefined; // where Herdr says this session runs, as the sub workspace check found it
	const barReason = async () => {
		try {
			const here = (placed = await place(run)), { workspaceId } = here;
			if (!here.terminalId) tell("Straw Boss: this Herdr reports no terminal_id for the pane, so a main of this session cannot come back after a Herdr restore (roles.ts)", "warning");
			const all = await workspaces(run);
			const sub = all.find((w) => w.workspace_id === workspaceId);
			return sub && isSub(sub) ? { text: `${sub.label} is a sub workspace, so this session cannot join the net; the main agent of its parent workspace represents it`, level: "info" as const } : undefined;
		} catch (error) {
			return { text: `Straw Boss could not tell whether this is a sub workspace: ${(error as Error).message}`, level: "error" as const };
		}
	};
	// A tab the tower opened for a request starts its pi with this role: it promotes itself as soon as it has joined (opener.ts).
	const opensAsMain = env.STRAW_BOSS_ROLE === "main";
	// The session start in progress, and its answer to whether this session may join (true) once Herdr has said what workspace it is in.
	let started: object | undefined, checked: Promise<boolean> = Promise.resolve(false);
	// STRAW_BOSS_ROLE=main stays in the new tab's shell, so a later pi started there would self-promote. The tower's one-time pane token is what
	// authorises it: this pi consumes the token and keeps the opener's marker (sb_opened_by) fresh, which the tower counts to enforce its limits.
	const claimOpened = async () => {
		if (!opensAsMain) return false;
		const mine = (await panes(run, s.at.workspaceId).catch(() => [])).find((p) => p.pane_id === s.at.paneId);
		if (mine?.tokens?.sb_open_main !== "1") return false;
		s.openedBy = mine.tokens.sb_opened_by;
		pi.appendEntry(ENTRY, { openedBy: s.openedBy ?? null, openedPane: s.at.paneId }); // null, not undefined: a later claim (a pop) overrides an earlier opener
		await report(run, "pane", s.at.paneId, { sb_open_main: null }).catch(() => {});
		return true;
	};

	const begin = async (event: SessionStartEvent, ctx: ExtensionContext) => {
		const start = (started = {});
		s.stopped = false;
		integration.arm();
		s.ui = ctx.ui;
		s.hasUI = ctx.hasUI;
		s.quit = () => ctx.shutdown();
		briefing.load();
		s.saved = Object.assign({}, ...ctx.sessionManager.getBranch().flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [e.data] : [])));
		s.file = ctx.sessionManager.getSessionFile();
		// A Herdr restore resumes the pane into this session file without STRAW_BOSS_ROLE and, when pi had not yet written the file, without its entries: the record decides (roles.ts).
		// The pane, tab, and workspace must all be the recorded ones; a tower needs no more, since it closes its pane when it quits (roles.ts).
		s.isTower ||= Boolean(s.saved.tower) || roles.held({ paneId: env.HERDR_PANE_ID, tabId: env.HERDR_TAB_ID, workspaceId: env.HERDR_WORKSPACE_ID }) === "tower";
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
			// Asking Herdr whether this is a sub workspace waits in the background too: on a loaded machine a Herdr call takes seconds, and pi-intercom
			// connects only after this handler returns. Until the answer comes the session counts as barred, so nothing joins (membership.ts) or promotes early.
			s.barred = CHECKING;
			checked = barReason().then((bar) => {
				if (start !== started) return false; // a /new or /resume started another session meanwhile, which asks again
				s.barred = bar?.text;
				if (bar) tell(bar.text, bar.level);
				return !bar;
			});
			let keepRestored = false;
			starting = checked.then(async (joinable) => {
				if (!joinable) return;
				if (!s.stopped) unwatch = cfg.watch(presence.restore); // a shutdown that came while Herdr was asked about the workspace has stopped nothing yet
				// What the record says is read before joining: the guard may promote this session at once, which writes its record anew (roles.ts).
				// A main a Herdr restore resumed in its own pane and tab takes the role back; a tab that has a live main already keeps it.
				const resumed = Boolean(placed) && roles.held(placed!) === "main";
				// The tower that opened it may close it again, as before the restore; the record names the opener, and the promotion below writes it into the new record.
				s.restoredOpener = roles.openerOf(resumed ? placed : undefined);
				// A pi started in the shell of a main that quit is no restore, and the record must not claim the next one.
				if (!resumed && event.reason === "startup" && placed && roles.sameShell(placed)) roles.forget();
				s.restored = resumed; // consumed by the promotion that makes this session the tab's main (membership.ts), also when the guard makes it
				await membership.joinNet();
				note(`${who()} joined tab ${s.info.tab}`);
				const claimed = await claimOpened();
				if (!claimed && event.reason !== "startup" && s.saved.openedBy && s.saved.openedPane === s.at.paneId) s.openedBy = s.saved.openedBy; // only the same pi in the tower's pane (/reload, /fork): `pi --session` anywhere is the boss's main
				if (s.openedBy) {
					control.register(); // the tower that opened this main may ask it to close (closemain.ts), also after a reload
					if (s.isMain) roles.remember("main"); // the guard may have crowned it during the join, before the opener was known: the record names it for a Herdr restore (roles.ts)
					await presence.publish(); // sb_opened_by was cleared at shutdown
				}
				if (!claimed && !resumed) return;
				const taken = await membership.promote(false).catch((error) => {
					if (resumed) keepRestored = true; // the owner may still confirm after the claim timed out, and that refresh must not open a tower
					throw error;
				});
				if (!taken.promoted) {
					tell(taken.text, claimed ? "warning" : "info");
					if (resumed) roles.forget(); // another main holds the tab, and this session stays a member: its record would claim the next restore
				} else if (!claimed) await membership.adoptOpener(); // a no-op when the refresh that made it the main did so already (membership.ts)
			}).finally(() => {
				if (start === started && !keepRestored) [s.restored, s.restoredOpener] = [false, undefined]; // the promotion consumes it when it makes this session the main; one found main already, or a join that failed, does not
			});
		}
		starting?.catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
	};
	pi.on("session_start", async (event, ctx) => {
		// The run mode's own handler ran before this one (registered first, and pi awaits them in turn): a run or a pane it quits has no net to join. A pi still waiting for the server's pane-role answer
		// (a resident tower's, runmode.ts) neither runs nor starts yet: its start comes with a `none` answer, and never with a hand run, a quit, or no answer.
		if (runMode.deciding) return void runMode.afterNormal(() => void begin(event, ctx).catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error")));
		if (runMode.mode !== "normal") return;
		await begin(event, ctx);
	});

	// The tower's run starts with what happened in its workspace since its last run, and the digest is cleared as it is read.
	pi.on("before_agent_start", async (event) => {
		if (runMode.active()) return;
		const sections = event.systemPromptOptions.sections;
		briefing.begin(sections);
		if (!s.holdsTower || !sections[ENTRY]) return;
		const lines = await digest.take(s.at.workspaceId).catch(() => []);
		if (lines.length) sections[ENTRY] += `\n\nSince your last run:\n${lines.map((line) => `- ${line}`).join("\n")}`;
	});
	pi.on("agent_settled", () => void (!runMode.active() && briefing.settled()));

	// A member that dispatches or resumes a subagent without promoting is promoted here, before the subagent starts, unless the tab already has a main.
	// A tower only coordinates: it dispatches no subagent (one would outlive it with no one to take its result), and opens a main for the work instead.
	pi.on("tool_call", async (event) => {
		if (!SUBAGENT_TOOLS.includes(event.toolName) || runMode.active()) return;
		await checked; // a subagent launched while session start still asks Herdr about the workspace waits for the answer
		if (s.barred) return;
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
		if (runMode.mode === "run") return; // a run's own shutdown is runmode.ts's: it joined nothing and holds no pane, tokens, or board entry
		// This session's board entry goes with the session on quit, new, resume, and fork (its id is done in this process); a reload keeps it.
		if (event.reason !== "reload" && s.boardId) removeEntry(join(guiDir, "board"), s.boardId);
		s.boardId = undefined;
		if (s.closing) roles.forget(); // closed on purpose: a Herdr restore does not bring it back (roles.ts)
		// A closed session, and a tower that quits however it was asked, take their pane with them (and an emptied tab); a /reload, /new, resume or fork keeps it.
		if ((s.closing ? !s.closing.keepPane : s.isTower) && event.reason === "quit" && env.HERDR_PANE_ID) {
			// A herdr or sh that is not found throws; the shutdown goes on (the GUI is released below), and the pane is left open with the reason on stderr.
			try { cfg.later(process.pid, ["pane", "close", env.HERDR_PANE_ID]); } catch (error) { process.stderr.write(`straw-boss: the pane was not closed: ${(error as Error).message}\n`); }
		}
		s.dashboard?.stop();
		s.dashboard = undefined;
		s.headWatch?.();
		s.headWatch = undefined;
		presence.stop();
		guard.stop();
		stopWatching();
		integration.stop();
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
