import { join } from "node:path";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { removeEntry } from "./board.ts";
import type { Briefing } from "./briefing.ts";
import type { Control } from "./closemain.ts";
import type { Digest } from "./digest.ts";
import type { Guard } from "./guard.ts";
import { isHead, isSub, type Place, panes, place, report, tabs, TOWER_LABEL, waitFor, workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import type { IntegrationWatch } from "./integration.ts";
import { CONNECT_MS, type Membership } from "./membership.ts";
import { type CoordinatorDuty, dutyOfAgent, isCoordinatorDuty } from "./duty.ts";
import type { MainDuty } from "./mainduty.ts";
import { plannedInMessage } from "./planmsg.ts";
import { orphans } from "./orphan.ts";
import { restored } from "./restored.ts";
import type { RunMode } from "./runmode.ts";
import type { Presence } from "./presence.ts";
import type { Reach } from "./reach.ts";
import type { Roles } from "./roles.ts";
import { ENTRY, type Kit } from "./state.ts";
import { isSessionRole, TRAIN, TRAIN_EVENT, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";

/** The custom message that asks the launcher to resume the subagents a Herdr restore brought back plain. */
const RESUME = "straw-boss-resume";
const KID_MARK_MS = [3_000, 15_000];
const SUBAGENT_TOOLS = ["subagent", "subagent_resume"];
const CHECKING = "Straw Boss is still asking Herdr whether this is a sub workspace; try again in a moment";
const UNPLACED = (why: string) => `Straw Boss could not tell whether this is a sub workspace: ${why}; it asks again`;

/** What the session does at its start, around each run, and at its end. */
export function registerSession(kit: Kit, { mainDuty, runMode, briefing, roles, presence, membership, guard, host, reach, digest, control, integration, startTower }: { mainDuty: MainDuty; runMode: RunMode; briefing: Briefing; roles: Roles; presence: Presence; membership: Membership; guard: Guard; host: ReturnType<typeof createHost>; reach: Reach; digest: Digest; control: Control; integration: IntegrationWatch; startTower(): Promise<void> }) {
	const { pi, cfg, s, guiDir, me, role, tell } = kit;
	const { run, env, version } = cfg;
	const who = () => pi.getSessionName() || s.ownName || me().slice(0, 8);
	// What the tower learns at its next run (digest.ts); a line that cannot be written is not worth failing anything for.
	const note = (text: string) => void digest.note(s.at.workspaceId, text).catch(() => {});
	// Watches for subagents this session launched whose result can no longer reach it (orphan.ts), and the watch on the Herdr server.
	let nudges: ReturnType<typeof orphans> | undefined, restores: ReturnType<typeof restored> | undefined, nudgeTimer: ReturnType<typeof setInterval> | undefined, unwatch: (() => void) | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined;
	const stopWatching = () => {
		clearInterval(nudgeTimer);
		clearTimeout(retryTimer);
		nudges?.stop();
		restores?.stop();
		unwatch?.();
		unwatch = undefined;
	};
	// A session in a sub workspace (a linked git worktree) acts like a subagent: it never joins. Only a definitive answer bars it for good;
	// a Herdr that could not answer (it is slow under load) leaves the session unplaced, and the check is asked again (`begin`).
	let placed: Place | undefined; // where Herdr says this session runs, as the sub workspace check found it
	type Verdict = { bar?: { text: string; level: "info" } } | { failed: string } | { tower: true };
	type Once = (what: string, text: string, level: "info" | "warning" | "error") => void;
	/** `tell`, each `what` once per start: a check that is asked again does not repeat its warning. */
	const onceOf = (): Once => {
		const seen = new Set<string>();
		return (what, text, level) => void (seen.has(what) || (seen.add(what), tell(text, level)));
	};
	/** The label Herdr lists for the tab now: the proof of a tower's or a train's tab (roles.ts). A list that fails throws, and proves nothing. */
	const labelOf = async (here: Place) => (await tabs(run, here.workspaceId)).find((t) => t.tab_id === here.tabId)?.label;
	const shown = (label: string | undefined) => (label === undefined ? "no tab" : JSON.stringify(Array.from(label).slice(0, 40).join("")));
	// Whether the tower role this session claims is proven. Its saved entry and its role record are files its own shell can write, so they only claim; the proof is Herdr's:
	// the pane sits in a tab labelled with the tower glyph, which a restore keeps and no file holds (docs/specs/2026-11-07-train-workers.md §29), and no other pane of that tab runs an
	// agent: the label proves the tab, not the pane, and a tower that starts beside a live one yields by closing the tab (RP131-F001). No proof is a member, told once.
	const towerProof = async (here: Place, once: Once): Promise<boolean> => {
		const entry = Boolean(s.saved.tower);
		if (!entry && roles.claimed(here) !== "tower") return false;
		const label = await labelOf(here);
		const inTab = (entry && label === TOWER_LABEL) || roles.held({ ...here, tabLabel: label }) === "tower";
		const shared = inTab && (await panes(run, here.workspaceId)).some((p) => p.tab_id === here.tabId && p.pane_id !== here.paneId && (p.agent || p.tokens?.sb_role));
		if (inTab && !shared) return true;
		once("tower-claim", `Straw Boss: this session's ${entry ? "saved entry" : "role record"} says it was a tower, but ${shared ? "its pane shares the tower tab with another agent's pane" : `Herdr lists its pane in ${shown(label)}, not in a tower tab`}, so it starts as a member: a file alone gives no role`, "warning");
		return false;
	};
	const barReason = async (once: Once): Promise<Verdict> => {
		try {
			const here = (placed = await place(run)), { workspaceId } = here;
			if (!here.terminalId) once("terminal", "Straw Boss: this Herdr reports no terminal_id for the pane, so a main of this session cannot come back after a Herdr restore (roles.ts)", "warning");
			const all = await workspaces(run);
			const sub = all.find((w) => w.workspace_id === workspaceId);
			if (sub && isHead(sub)) return { bar: { text: "This is the head tower's workspace, so a session typed here cannot join the net; the head tower is its own", level: "info" } };
			if (sub && isSub(sub)) return { bar: { text: `${sub.label} is a sub workspace, so this session cannot join the net; the main agent of its parent workspace represents it`, level: "info" } };
			return (await towerProof(here, once)) ? { tower: true } : {};
		} catch (error) {
			return { failed: (error as Error).message };
		}
	};
	// A tab the tower opened for a request starts its pi with this role: it promotes itself as soon as it has joined (opener.ts).
	const opensAsMain = env.STRAW_BOSS_ROLE === "main";
	// A tab the tower opened for a train starts its pi with this one: the pi is the train (s.isTrain), never the tab's main (docs/specs/2026-11-07-train-workers.md §3.3).
	const opensAsTrain = env.STRAW_BOSS_ROLE === TRAIN;
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
		// The kind the tower opened it with (docs/specs/2026-11-09-agent-kinds.md §6) is consumed with the claim: the entry, `s.duty`, and, at the promotion below, the role record, which a restore before the first message reads.
		const duty = mine.tokens.sb_open_duty;
		if (isCoordinatorDuty(duty) && s.duty !== duty && (duty !== "integrator" || mainDuty.integrationOn())) { // `integrator` only while integration is on, as the door (opener.ts) requires: a token written by anything else gets no hidden integrator entry (R0790-F003).
			const tower = (await workspaces(run).catch(() => [])).find((w) => w.workspace_id === s.at.workspaceId)?.tokens?.tower;
			mainDuty.write(duty, `opened by tower ${tower ?? `of workspace ${s.at.workspaceId}`} as ${duty}`);
		}
		await report(run, "pane", s.at.paneId, { sb_open_main: null, ...(mine.tokens.sb_open_duty !== undefined ? { sb_open_duty: null } : {}) }).catch(() => {});
		return true;
	};

	const begin = async (event: SessionStartEvent, ctx: ExtensionContext) => {
		const start = (started = {});
		s.stopped = false;
		s.trainSettled = false;
		integration.arm();
		s.ui = ctx.ui;
		s.hasUI = ctx.hasUI;
		s.quit = () => ctx.shutdown();
		briefing.load();
		s.saved = Object.assign({}, ...ctx.sessionManager.getBranch().flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [e.data] : [])));
		s.duty = isCoordinatorDuty(s.saved.duty) ? s.saved.duty : undefined; // the migration's guard is this live value (docs/specs/2026-11-09-agent-kinds.md §2)
		s.branch = () => ctx.sessionManager.getBranch();
		s.file = ctx.sessionManager.getSessionFile();
		// A tower here is one by its process: started with STRAW_BOSS_ROLE=tower (state.ts), or a tower already in an earlier start of this process. A Herdr restore resumes the pane into this session
		// file without the variable: the saved entry or the role record then claims the role, and the claim is proven against Herdr with the workspace check below (`towerProof`), never taken from the file.
		const log = ctx.sessionManager;
		stopWatching();
		nudges = orphans({ run, file: () => log.getSessionFile(), entries: () => log.getEntries(), sessions: host.sessions, send: reach.send, type: ENTRY, remember: (key) => pi.appendEntry(ENTRY, { nudged: key }), me, tell });
		// Subagents a Herdr restart brought back as plain pi sessions are closed, and this session is asked to resume them (restored.ts).
		restores = restored({ run, sleep: cfg.sleep, file: () => log.getSessionFile(), entries: () => log.getEntries(), active: () => !s.isTower, launcher: () => (me() ? { id: me(), name: who() } : undefined), sessions: host.sessions, send: reach.send, type: ENTRY, remember: (data) => pi.appendEntry(ENTRY, data), resume: (text, details) => pi.sendMessage({ customType: RESUME, content: text, display: true, details }, { triggerTurn: true, deliverAs: "steer" }), tell });
		nudgeTimer = setInterval(() => void Promise.allSettled([nudges?.poll(), restores?.poll()]), cfg.nudgeMs).unref();
		// Starting runs in the background: pi awaits session_start handlers in turn, and pi-intercom connects in its own, after this one.
		const asTower = () => {
			s.trainSettled = true; // a tower is no train
			s.barred = s.recheck = undefined; // what an earlier start of this process left (a member's unplaced check) is not a tower's: it dispatches no subagents, and a bar would let its call through
			unwatch ??= cfg.watch(presence.restore);
			startTower().catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
		};
		if (s.isTower) return asTower();
		// Asking Herdr whether this is a sub workspace waits in the background too: on a loaded machine a Herdr call takes seconds, and pi-intercom
		// connects only after this handler returns. Until the answer comes the session counts as barred: a join waits for the answer first (`s.recheck`, membership.ts), and a promotion needs the join, so nothing joins or promotes early.
		s.barred = CHECKING;
		const once = onceOf();
		let keepRestored = false, failed = false, retries = 0, decided: { resumed: boolean; opener: string | undefined; duty: CoordinatorDuty | undefined } | undefined, proceeding: Promise<void> | undefined, asking: Promise<boolean> | undefined;
		// This start is the one in progress: a newer start or a shutdown ends it, and what it still has in flight must neither tell, retry, nor join.
		const live = () => start === started && !s.stopped;
		// A step that failed for want of Herdr or intercom is asked again after 1 s, 2 s, 5 s, then every 15 s; no timer outlives a shutdown or a newer start.
		// `retryTimer` is shared by the starts, so only a live start calls this: an ended start's late failure would clear the newer start's timer.
		const retryLater = (again: () => unknown) => {
			clearTimeout(retryTimer);
			retryTimer = setTimeout(() => void (live() && again()), cfg.joinRetryMs[Math.min(retries++, cfg.joinRetryMs.length - 1)]).unref();
		};
		// What a joinable session does once it is placed: join, and the opener and restore bookkeeping that goes with it. Once per start, whoever got the answer first.
		// How this pi came to be a train: the tower's one-time claim (the pane's `sb_open_main` with a valid `sb_train`), the same pi in the same pane after a /reload (its saved entry), or a Herdr restore (its record). It is known before the join: the
		// join publishes the role, and the guard looks at the tab as soon as the join ends, so neither may ever see a train as a member that can be crowned.
		let trainHow: "claim" | "reload" | "restore" | undefined;
		const trainIdentity = async () => {
			if (s.isTrain || !placed) return;
			// A pane list that fails is no answer for a pi that was started as a train: it is asked again, and the guard stays closed meanwhile (trainguard.ts).
			const mine = opensAsTrain ? (await panes(run, placed.workspaceId).catch((error) => { throw Object.assign(error as Error, { joining: true }); })).find((p) => p.pane_id === placed!.paneId) : undefined;
			const token = trainFromToken(mine?.tokens?.sb_train);
			const saved = trainFromToken(s.saved.train && trainToken(s.saved.train));
			if (mine?.tokens?.sb_open_main === "1" && token) return void ([s.isTrain, s.train, s.openedBy, trainHow] = [true, token, mine.tokens.sb_opened_by, "claim"]);
			// The saved entry and the role record are files the session's own shell can write: they name the train it claims to be, and Herdr proves it, by the tab that carries the train's code
			// (`train <MMDDx>`, set by the open and kept by a restore; docs/specs/2026-11-07-train-workers.md §29). A tab list that fails is no answer, as the pane list above.
			const entry = event.reason !== "startup" && saved && s.saved.openedPane === placed.paneId ? saved : undefined;
			// The label carries the short code only. At a /reload the pane still carries the train's own `sb_train` (presence.ts keeps it over the gap), which says the project and the year:
			// an entry that names another train is not taken (RP131-F003). After a restore, or another start in this process, the token is gone and only the label is left.
			const kept = entry && event.reason === "reload" ? (mine ?? (await panes(run, placed.workspaceId).catch((error) => { throw Object.assign(error as Error, { joining: true }); })).find((p) => p.pane_id === placed!.paneId))?.tokens?.sb_train : undefined;
			const other = entry && event.reason === "reload" && kept !== trainToken(entry);
			const named = entry ?? (roles.claimed(placed) === TRAIN ? roles.trainOf(placed) : undefined);
			if (!named) return;
			const label = await labelOf(placed).catch((error) => { throw Object.assign(error as Error, { joining: true }); });
			if (entry && !other && label === trainLabel(entry.code)) {
				[s.isTrain, s.train, s.openedBy, trainHow] = [true, entry, s.saved.openedBy ?? undefined, "reload"];
			} else if (roles.held({ ...placed, tabLabel: label }) === TRAIN) {
				const record = roles.trainOf(placed);
				if (record) [s.isTrain, s.train, s.openedBy, trainHow] = [true, record, roles.openerOf(placed), "restore"];
			} else if (label !== trainLabel(named.code)) once("train-claim", `Straw Boss: this session's ${entry ? "saved entry" : "role record"} names ${trainLabel(named.code)}, but Herdr lists its pane in ${shown(label)}, not in that train's tab, so it is no train: a file alone gives no role`, "warning");
			else if (other) once("train-claim", `Straw Boss: this session's saved entry names ${trainToken(entry!)}, but its pane carries ${kept ?? "no train's mark"}, so it is no train: a file alone gives no role`, "warning");
		};
		const proceed = async () => {
			if (!s.stopped && !unwatch) unwatch = cfg.watch(presence.restore); // a shutdown that came while Herdr was asked about the workspace has stopped nothing yet
			await trainIdentity();
			if (live()) s.trainSettled = true; // the role is decided: a train, or none
			// What the record says is read once, before the first join: the guard may promote this session at once, which writes its record anew (roles.ts), and a retry must not take that record for a restore's.
			decided ??= (() => {
				// A main a Herdr restore resumed in its own pane and tab takes the role back; a tab that has a live main already keeps it.
				const resumed = Boolean(placed) && roles.held(placed!) === "main";
				// The tower that opened it may close it again, as before the restore; the record names the opener, and the promotion below writes it into the new record.
				const opener = roles.openerOf(resumed ? placed : undefined);
				// So may its kind: a restore before the first message has no entry to read it from (pi had written no file), and the record has it (§6).
				const duty = resumed ? roles.dutyOf(placed!) : undefined;
				// A pi started in the shell of a main that quit is no restore, and the record must not claim the next one.
				if (!resumed && event.reason === "startup" && placed && roles.sameShell(placed)) roles.forget();
				return { resumed, opener, duty };
			})();
			if (decided.duty && s.duty === undefined) s.duty = decided.duty; // the entries win; the record speaks only where they hold none
			const { resumed } = decided;
			s.restoredOpener = decided.opener;
			s.restored = resumed; // consumed by the promotion that makes this session the tab's main (membership.ts), also when the guard makes it; each attempt sets it again, the one that failed having reset it
			await membership.joinNet().catch((error) => {
				throw Object.assign(error as Error, { joining: true });
			});
			note(`${who()} joined tab ${s.info.tab}`);
			if (failed) tell(`Straw Boss: joined the net (tab ${s.info.tab}) after ${retries} ${retries === 1 ? "retry" : "retries"}`, "info");
			if (s.isTrain) {
				pi.events.emit(TRAIN_EVENT, { train: true });
				// A train is never promoted. The tower that opened it may close it (closemain.ts), a Herdr restore brings it back (roles.ts), and a /reload in this pane finds it again (the entry).
				if (trainHow === "claim") await report(run, "pane", s.at.paneId, { sb_open_main: null }).catch(() => {});
				if (trainHow !== "reload") pi.appendEntry(ENTRY, { openedBy: s.openedBy ?? null, openedPane: s.at.paneId, train: s.train });
				control.register();
				roles.remember(TRAIN);
				await presence.publish();
				return;
			}
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
			mainDuty.migrate(pi.getSessionName()); // a restored or opened main with the signs of an integrator
		};
		const proceedOnce = () =>
			(proceeding ??= proceed()
				.catch((error: Error & { joining?: boolean; final?: boolean }) => {
					if (!live()) return; // an ended start tells nothing to the session that replaced it, and arms nothing
					if (!error.joining) return tell(`Straw Boss: ${error.message}`, "error");
					// A join that failed is told once and asked again by timer: the channel's connection and owner events (membership.ts) may never come, and a failed look at the pane has no channel to report one.
					once("join", `Straw Boss: ${error.message}`, "error");
					if (error.final) return; // what waiting cannot fix (membership.ts `fatal`) is told and left; /boss tries once more when the boss asks
					[proceeding, failed] = [undefined, true];
					retryLater(proceedOnce);
				})
				.finally(() => {
					if (start === started && !keepRestored) [s.restored, s.restoredOpener] = [false, undefined]; // the promotion consumes it when it makes this session the main; one found main already, or a join that failed, does not
				}));
		// Only a definitive answer settles `barred`; whoever asks while an ask is in flight shares it, so each ask is handled once.
		const answer = () =>
			(asking ??= barReason(once)
				.then((verdict) => {
					if (!live()) return false; // a /new or /resume started another session meanwhile, which asks again; a shutdown joins nothing
					if ("failed" in verdict) {
						s.barred = UNPLACED(verdict.failed);
						failed = true;
						once("check", s.barred, "warning");
						retryLater(answer);
						return false;
					}
					clearTimeout(retryTimer);
					// The claim is proven: the tower starts now, as one started with the variable does at once. It never joins (membership.ts refuses a tower's join).
					if ("tower" in verdict) return ((s.isTower = true), asTower(), false);
					s.recheck = undefined;
					s.barred = verdict.bar?.text;
					if (verdict.bar) return (tell(verdict.bar.text, verdict.bar.level), (s.trainSettled = true), false); // a session that never joins is no train
					void proceedOnce();
					return true;
				})
				.finally(() => (asking = undefined)));
		s.recheck = async () => void (await answer());
		checked = answer();
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
		mainDuty.migrate(pi.getSessionName()); // a main's signs: its name and its train todos, read before the prompt is built
		briefing.begin(sections);
		if (!s.holdsTower || !sections[ENTRY]) return;
		const lines = await digest.take(s.at.workspaceId).catch(() => []);
		if (lines.length) sections[ENTRY] += `\n\nSince your last run:\n${lines.map((line) => `- ${line}`).join("\n")}`;
	});
	// A rename from any source (boss_rename, /name, another extension) can make this main an integrator (§2); its todos are read again after each todo call.
	pi.on("session_info_changed", (event) => void (!runMode.active() && mainDuty.migrate((event as { name?: string }).name)));
	pi.on("agent_settled", () => void (!runMode.active() && briefing.settled()));

	// A member that dispatches or resumes a subagent without promoting is promoted here, before the subagent starts, unless the tab already has a main.
	// A tower only coordinates: it dispatches no subagent (one would outlive it with no one to take its result), and opens a main for the work instead.
	pi.on("tool_call", async (event, ctx) => {
		if (!SUBAGENT_TOOLS.includes(event.toolName) || runMode.active()) return;
		await checked; // a subagent launched while session start still asks Herdr about the workspace waits for the answer
		await s.recheck?.(); // a Herdr that could not answer then is asked again now, not at the next timer
		if (s.barred) return;
		if (s.isTower) return { block: true, reason: "A tower dispatches no subagents. Open a main for this work with boss_open_main, or route it to the main that owns it." };
		try {
			await membership.joinNet();
			if (!s.isMain) await membership.promote(false); // a train is refused there (membership.ts), silently: it dispatches its reviewers as it is
		} catch (error) {
			tell(`Straw Boss: ${(error as Error).message}`, "warning");
		}
		mainDuty.migrate(pi.getSessionName()); // the promotion above may have just made this an `integ <project>` main whose migration had not run: it is never asked for a plan
		// A coordinator's worker waits for a plan that names a graph (§2a); scouts, planners and reviewers, a resume, an integrator, and a standing main never wait.
		if (event.toolName !== "subagent" || role() !== "main" || mainDuty.now() !== "coordinator" || mainDuty.graph() || plannedInMessage(ctx.sessionManager.getBranch(), event.toolCallId, (event as { parentToolCallId?: string }).parentToolCallId)) return;
		const agent = (event.input as { agent?: unknown } | undefined)?.agent;
		if (typeof agent === "string" && ["scout", "planner", "reviewer"].includes(dutyOfAgent(agent) ?? "") ) return;
		return { block: true, reason: `sb: plan first: a worker needs a plan whose todos name a graph (${briefing.dir()}/planning.md). Write the plan's todos, then dispatch; a scout, a planner, or a reviewer may run now. If your job is a project's merge trains or minding one system, call boss_duty with integrator or standing instead.` };
	});

	// A launched subagent is marked within seconds, once its pane shows its session file, instead of at the next 4 minute refresh.
	pi.on("tool_result", (event) => {
		if (event.toolName === "todo" && !event.isError) briefing.rebrief(); // a todo call can name or end a plan's graph (§2a)
		if (!SUBAGENT_TOOLS.includes(event.toolName) || s.isTower || s.barred || !role()) return;
		for (const ms of KID_MARK_MS) setTimeout(() => void presence.publish(), ms).unref();
		const { name, agent } = event.input as { name?: unknown; agent?: unknown };
		if (!event.isError) note(`${who()} ${event.toolName === "subagent" ? "started" : "resumed"} subagent ${typeof name === "string" && name ? name : "unnamed"}${typeof agent === "string" && agent ? ` (${agent})` : ""}`);
	});

	pi.on("session_shutdown", async (event) => {
		// A run's own shutdown is runmode.ts's: it joined nothing and holds no pane, tokens, or board entry. So is that of a pi that never became a normal session (undecided, or plain after no answer from the server):
		// the standing pane it sits in is the server's, and a quit of it leaves the pane as it found it (RV7-F002).
		if (runMode.mode !== "normal") return;
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
		presence.stop();
		guard.stop();
		stopWatching();
		integration.stop();
		s.stopped = true; // a refresh still in flight must not write tokens after they are cleared
		await presence.settled();
		const held = s.holdsTower;
		s.holdsTower = false;
		const had = role(), keepTrain = s.isTrain && event.reason === "reload";
		[s.isTrain, s.train, s.trainSettled, s.trainSign] = [false, undefined, false, false]; // a /new or /resume in this process is not the train: the next start finds out again
		if (!had || !s.at) return;
		// A /reload brings the same train back in this pane (its entry), so it keeps the tokens that name it through the gap; only a quit, /new, /resume or /fork lets go of them.
		await presence.clear({ keepTrain });
		// A tower that quits says so with the members the base has, so the mains are cleared at once instead of after the grace a /reload gets,
		// and the guard opens no new tower until the base grows past them.
		const members = event.reason === "quit" && held ? (await panes(run, s.at.workspaceId).catch(() => [])).filter((p) => isSessionRole(p.tokens?.sb_role)).length : 0;
		if (held) await report(run, "workspace", s.at.workspaceId, { tower: null, ...(event.reason === "quit" ? { sb_tower_quit: String(members) } : {}) }).catch(() => {});
	});
}
