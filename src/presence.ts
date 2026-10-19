import { report, type Session } from "./herdr.ts";
import { clearOrder, markKids, netTokens } from "./order.ts";
import { nameOf } from "./reach.ts";
import type { Kit } from "./state.ts";

const REFRESH_MS = 4 * 60_000;
// What can turn a launched subagent's pane into a pi that is marked: Herdr detecting the agent, or the pane's session file showing up.
const DETECT_EVENTS = ["pane.agent_detected", "pane.updated"];

/** The tokens a session publishes with its role: display and discovery only, kept fresh and written again when a new Herdr server takes over. */
export function createPresence({ cfg, s, me, role }: Kit) {
	const { run, world, events, detectMs } = cfg;
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
	// Tokens are display and discovery only: a failed write waits for the next refresh, liveness comes from intercom.
	// One publish at a time, and shutdown waits for the one in flight: a write that lands after the clear would leave tokens behind.
	let publishing: Promise<void> = Promise.resolve();
	const publishOnce = async (known?: Session[]) => {
		const sbRole = s.stopped ? undefined : role();
		if (sbRole) {
			s.ownName = nameOf((known ?? (await s.c.listSessions().catch(() => []))).find((x) => x.id === me())) || s.ownName;
			// A failed read of Herdr leaves the subagents' tokens as they are; their TTL still runs.
			const net = await netTokens(run, s.at, sbRole, s.ownName || me().slice(0, 8), Date.now(), world).catch(() => undefined);
			await report(run, "pane", s.at.paneId, { sb_role: sbRole, ...net?.own, ...(s.openedBy ? { sb_opened_by: s.openedBy } : {}) }).catch(() => {});
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
		const net = await netTokens(run, s.at, role()!, s.ownName || me().slice(0, 8), Date.now(), world).catch(() => undefined);
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
			unwatch();
		},
		/** The publish in flight, which shutdown waits for. */
		settled: () => publishing,
		/** The tokens of this session's pane go: its role, its marks, and the sidebar order of the subagents it marked. */
		async clear() {
			written = undefined;
			await report(run, "pane", s.at.paneId, { sb_role: null, sb_opened_by: null, sb_order: null, sb_mark: null, sb_indent: null, sb_name: null, sb_tab: null, sb_main_tab: null, sb_member_tab: null }).catch(() => {});
			await clearOrder(run, [...s.kids]);
		},
	};
}
export type Presence = ReturnType<typeof createPresence>;
