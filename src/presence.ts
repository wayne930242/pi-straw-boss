import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { report, type Session } from "./herdr.ts";
import { clearOrder, markKids, netTokens, type Who } from "./order.ts";
import { nameOf } from "./reach.ts";
import type { Kit } from "./state.ts";
import { trainToken } from "./trainrole.ts";
import type { MainDuty } from "./mainduty.ts";
import { stepOf } from "./trainsign.ts";
import { trainboardDir } from "./train/board.ts";

const REFRESH_MS = 4 * 60_000;
/** How long a train waits after its step changes before it writes `sb_step`: five times the subagent detection delay (`detectMs`, 1 s), so 5 s. */
const STEP_DEBOUNCE_FACTOR = 5;
// What can turn a launched subagent's pane into a pi that is marked: Herdr detecting the agent, or the pane's session file showing up.
const DETECT_EVENTS = ["pane.agent_detected", "pane.updated"];

/** The tokens a session publishes with its role: display and discovery only, kept fresh and written again when a new Herdr server takes over. */
export function createPresence(kit: Kit, mainDuty: MainDuty) {
	const { cfg, s, me, role } = kit;
	const { run, world, events, detectMs } = cfg, guiDir = kit.guiDir;
	let timer: ReturnType<typeof setInterval> | undefined;
	// A subagent that has no pi pane yet (it sits at pi's trust prompt) is marked when Herdr reports its pi, not at the next refresh. The connection to
	// Herdr's events is open only while a launched subagent waits for that, and a reading that changes none of the marks writes nothing.
	let unlisten: (() => void) | undefined, soon: ReturnType<typeof setTimeout> | undefined, written: string | undefined;
	const unwatch = () => {
		unlisten?.();
		clearTimeout(soon);
		[unlisten, soon] = [undefined, undefined];
	};
	const watchDetect = (waiting: boolean) => {
		if (!waiting || s.stopped) return unwatch();
		unlisten ??= events(DETECT_EVENTS, (e) => {
			// A reconnection (null) may have missed the event. A pane this session marked already is of no interest.
			const id = String(e?.data.pane_id ?? (e?.data.pane as { pane_id?: string } | undefined)?.pane_id ?? "");
			if (e && (id === s.at.paneId || s.kids.has(id))) return;
			soon ??= setTimeout(() => ((soon = undefined), void detect()), detectMs).unref();
		});
	};
	// Whether this session is an integrator is its own duty (mainduty.ts); a train's code, project and step come from its record and board (trainsign.ts). A member's place beside its tab's integrator comes from the `sb_duty` token of its tab's main (order.ts): display only, any session can write a token (docs/specs/2026-11-09-agent-kinds.md §2).
	const whoAmI = (sbRole: string): Who & { step?: string } => (sbRole === "train" && s.train ? { code: s.train.code, project: s.train.project, step: stepOf(guiDir, s.train) } : sbRole === "main" ? { integrator: mainDuty.now() === "integrator", ...((d) => (d !== "worker" ? { duty: d } : {}))(mainDuty.now()) } : {});
	let stepSoon: ReturnType<typeof setTimeout> | undefined;
	/** A train's current step changed: its token is written 5 s after the first of a burst of changes (the 4 minute refresh stays as the safety net). */
	const stepChanged = () => {
		if (s.stopped || !s.isTrain || stepSoon) return;
		stepSoon = setTimeout(() => ((stepSoon = undefined), void publish()), detectMs * STEP_DEBOUNCE_FACTOR);
		stepSoon.unref();
	};
	// A train watches its project's trainboard folder for a change of its own board; the watch is best effort, the refresh is the safety net.
	let watcher: FSWatcher | undefined;
	const watchBoard = () => {
		if (watcher || !s.isTrain || !s.train || s.stopped) return;
		const { project, code } = s.train;
		try {
			watcher = watch(join(trainboardDir(guiDir), project), { recursive: true }, (_event, file) => { if (file === null || String(file).split(/[\\/]/)[0] === code) stepChanged(); });
			watcher.on("error", () => { watcher?.close(); watcher = undefined; });
			watcher.unref();
			stepChanged(); // a change before the watch is live is missed: one look after the debounce
		} catch { watcher = undefined; }
	};
	// Tokens are display and discovery only: a failed write waits for the next refresh, liveness comes from intercom.
	// One publish at a time, and shutdown waits for the one in flight: a write that lands after the clear would leave tokens behind.
	let publishing: Promise<void> = Promise.resolve();
	const publishOnce = async (known?: Session[]) => {
		const sbRole = s.stopped ? undefined : role();
		if (sbRole) {
			s.ownName = nameOf((known ?? (await s.c.listSessions().catch(() => []))).find((x) => x.id === me())) || s.ownName;
			// A failed read of Herdr leaves the subagents' tokens as they are; their TTL still runs.
			const net = await netTokens(run, s.at, sbRole, s.ownName || me().slice(0, 8), Date.now(), world, whoAmI(sbRole)).catch(() => undefined);
			await report(run, "pane", s.at.paneId, { sb_role: sbRole, sb_duty: sbRole === "main" ? mainDuty.now() : null, ...net?.own, ...(s.openedBy ? { sb_opened_by: s.openedBy } : {}), ...(s.isTrain && s.train ? { sb_train: trainToken(s.train) } : {}) }).catch(() => {});
			watchBoard();
			if (net) {
				s.kids = await markKids(run, net.kids, s.kids, net.joined);
				written = JSON.stringify(net.kids);
				watchDetect(net.waiting);
			}
		}
		if (s.holdsTower && !s.stopped) await report(run, "workspace", s.at.workspaceId, { tower: me(), sb_tower_quit: null }).catch(() => {});
	};
	// One reading of the subagents' panes; their tokens are written when they differ from the last ones written, the session's own tokens are left to the refresh.
	const detectOnce = async () => {
		if (s.stopped || !role()) return;
		const net = await netTokens(run, s.at, role()!, s.ownName || me().slice(0, 8), Date.now(), world, whoAmI(role()!)).catch(() => undefined);
		if (!net || s.stopped) return;
		watchDetect(net.waiting);
		if (JSON.stringify(net.kids) === written) return;
		s.kids = await markKids(run, net.kids, s.kids, net.joined);
		written = JSON.stringify(net.kids);
	};
	const detect = () => (publishing = publishing.then(detectOnce).catch(() => {}));
	const publish = (known?: Session[]) => (publishing = publishing.then(() => publishOnce(known)).catch(() => {}));
	return {
		publish,
		stepChanged,
		// A new Herdr server (an update handoff, or a stop and start) starts without the tokens of the one before. Writing them waits for no refresh:
		// the tower's marks go first, because they are how another session finds the tower, and the rest follows. Nothing is written by a session that has not joined.
		restore() {
			if (s.stopped || !s.at || !(s.joined || s.holdsTower)) return;
			publishing = publishing.then(async () => {
				if (s.stopped) return;
				if (s.holdsTower) await Promise.all([report(run, "workspace", s.at.workspaceId, { tower: me() }), report(run, "pane", s.at.paneId, { sb_role: "tower" })]).catch(() => {});
				await publishOnce();
			}).catch(() => {});
		},
		keepFresh() {
			timer ??= setInterval(() => void publish(), REFRESH_MS);
			timer.unref();
		},
		/** The refresh stops. */
		stop() {
			clearInterval(timer);
			timer = undefined;
			clearTimeout(stepSoon);
			stepSoon = undefined;
			watcher?.close();
			watcher = undefined;
			unwatch();
		},
		/** The publish in flight, which shutdown waits for. */
		settled: () => publishing,
		/**
		 * The tokens of this session's pane go: its role, its marks, and the sidebar order of the subagents it marked. A train's /reload keeps the three that make the pane a train
		 * (`keepTrain`): for the length of the gap a pi that joined the tab later would otherwise be crowned beside it, and the project would count one train less.
		 * The tokens lapse by their TTL when no pi comes back.
		 */
		async clear({ keepTrain = false }: { keepTrain?: boolean } = {}) {
			written = undefined;
			await report(run, "pane", s.at.paneId, { ...(keepTrain ? {} : { sb_role: null, sb_opened_by: null, sb_train: null, sb_duty: null }), sb_order: null, sb_mark: null, sb_indent: null, sb_name: null, sb_step: null, sb_tab: null, sb_main_tab: null, sb_member_tab: null }).catch(() => {});
			await clearOrder(run, [...s.kids]);
		},
	};
}
export type Presence = ReturnType<typeof createPresence>;
