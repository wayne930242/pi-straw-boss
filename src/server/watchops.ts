import { join } from "node:path";
import { boardSeam } from "../boardview.ts";
import type { HerdrRun, HerdrWorld, Session } from "../herdr.ts";
import { netSource } from "../net.ts";
import type { AutoMode, Period } from "./automode.ts";
import { type AutoWatch, createAutoWatch, type NoticeWhere, type WatchDeps, type WatchReport, WATCH_KEY, WATCH_TICK_MS, factsOf, watchSection } from "./autowatch.ts";
import { readAsks } from "./headasks.ts";
import { headSeam } from "./headnet.ts";
import type { Slot } from "./record.ts";
import type { StallRow } from "./stallwatch.ts";
import { inTestRun } from "./testguard.ts";
import { towerPanel } from "./towerpanel.ts";
import type { Towers } from "./towers.ts";
import { trainyardSeam, type YardDeps } from "./trainyard.ts";

// The server's side of the auto watch (autowatch.ts): the reading of the net it takes its facts from, the head tower it wakes, and its timer. Kept out of main.ts, which carries a line budget.

export interface StartWatch {
	auto: AutoMode;
	slot: Slot;
	env: NodeJS.ProcessEnv;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean | undefined>): void;
	run: HerdrRun;
	world?: HerdrWorld;
	/** pi-intercom's list as the server's own connection sees it; rejects while it is not connected. */
	sessions(): Promise<Session[]>;
	towers(): Towers | undefined;
	/** The stall watch's open incidents (none where it does not run). */
	stalls(): StallRow[];
	/** The server's book of cars, for the yards (trainyard.ts). */
	book?: () => YardDeps["book"] | undefined;
	/** The seams of a test: the watch's own deps and how often it looks. In a test run there is no watch without them (it would read the net of a fake Herdr and wake the head of every test that leaves auto mode on). */
	over?: Partial<WatchDeps> & { tickMs?: number };
}

/**
 * What the switch does for the watch (boss, 11/12): switched on with no head tower open, the server opens one, since the boss is at their switch and the watch has nobody to wake otherwise; a head that is gone later in the
 * night is not opened again (the readings count it for the morning). Switched off, the watch's notices no run took are dropped: they are stale, and nothing of the watch acts once the boss is back.
 */
export function watchSwitch(o: { towers(): Towers | undefined; log: StartWatch["log"] }) {
	return (change: { from: { on: boolean }; to: { on: boolean } }): void => {
		const towers = o.towers();
		if (!towers || change.from.on === change.to.on) return;
		if (!change.to.on) {
			const head = towers.head.status()?.workspace, dropped = head ? towers.runs.dropNotices(head, WATCH_KEY) : 0;
			if (dropped) o.log("watch-dropped", { notices: dropped });
			return;
		}
		if (towers.head.status()) return;
		void towers.head.ensure().then((got) => o.log("watch-head", { opened: got.opened, workspace: got.workspace }), (cause: Error) => o.log("watch-head", { error: String(cause?.message ?? cause).slice(0, 200) }));
	};
}

/** The watch's section of the return list for the period that ends (automode.ts `watch`): the head's asks are read here, so the nudges since the last wake are in it, and the queue, so a notice a run took since the last reading counts as told. */
export const reportWatch = (slot: Slot, now: () => number, towers: () => Towers | undefined) => (period: Period, until: string): WatchReport | undefined => watchSection(period.watch, period.since, until, asksOf(slot, now), (p) => noticeState(towers, p));
/** Where a notice of the watch is; queued while the towers are not known (it is not taken for told). */
const noticeState = (towers: () => Towers | undefined, p: { workspace: string; key: string }): NoticeWhere => towers()?.runs.noticeState(p.workspace, p.key) ?? "queued";
/** The head's asks; none when the file cannot be read (the watch's count of the head's own messages then stands where it was, and the return list is still written). */
const asksOf = (slot: Slot, now: () => number) => { try { return readAsks(slot, now()); } catch { return []; } };

/**
 * The watch of this server with its timer, or none (a test run without seams). The facts come from a reading of the net of its own, the one the pages draw (net.ts): the tower services, the head's asks, the work board, and the
 * yards; it is read when a wake is due, not at each look. The stop is returned.
 */
export function startAutoWatch(o: StartWatch): (() => void) | undefined {
	if (inTestRun() && !o.over) return undefined;
	const { tickMs, ...over } = o.over ?? {};
	const offSwitch = o.auto.onSwitch(watchSwitch(o));
	const net = netSource({
		services: (workspace) => towerPanel(o.towers).view(workspace), head: headSeam(o.slot, o.now), run: o.run, ...(o.world ? { world: o.world } : {}), sessions: o.sessions,
		board: boardSeam({ dir: join(o.slot.stateDir, "board"), now: o.now }), trainyard: trainyardSeam({ env: o.env, stateDir: o.slot.stateDir, now: o.now, ...(o.book ? { book: o.book } : {}) }),
	});
	const watch: AutoWatch = createAutoWatch({
		now: o.now, log: o.log, auto: o.auto,
		// The head tower is woken where the server stands in for it; a service that is held starts no run, so its notices would only pile up.
		head: () => ((row) => (row ? { workspace: row.workspace, ...(row.service?.state === "held" ? { held: true } : {}) } : undefined))(o.towers()?.head.status()),
		facts: async (input) => factsOf(await net.read(), { ...input, stalls: o.stalls() }),
		asks: () => asksOf(o.slot, o.now),
		waiting: (workspace) => o.towers()?.runs.noticeWaits(workspace, WATCH_KEY) ?? false,
		noticeState: (workspace, key) => noticeState(o.towers, { workspace, key }),
		wake: (workspace, text, key) => o.towers()?.runs.notice(workspace, text, key) ?? false,
		...over,
	});
	const timer = setInterval(() => void watch.tick(), tickMs ?? WATCH_TICK_MS);
	return () => (clearInterval(timer), offSwitch());
}
