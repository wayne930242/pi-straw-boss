import { nextBoundary, type Phase, phaseAt } from "./phase.ts";

// Storybook's live day and night (docs/specs/2026-11-26-storybook-theme/spec.md §B2): one timer to the next 06:00 or 18:00, and a look again when the page comes back (visibilitychange, pageshow) or has news
// (a snapshot, at most once a minute), since a phone that slept skips timers and a time-zone or DST change moves the boundary. A change sets `data-phase` on <html> while the face is Storybook and tells the listeners
// (the page paints its theme-color and tab badge again). Nothing else moves: no reload, no route, no focus, no draft, no dialog. The clock is a seam, so tests drive it with tests/fake-clock.ts.

export interface PhaseClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
interface Events { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void }
export interface PhaseEnv {
	clock?: PhaseClock;
	root?: { dataset: Record<string, string | undefined> };
	/** Where visibility and pageshow are heard (document and window in a page). */
	doc?: Events & { visibilityState?: string };
	win?: Events;
	/** The demo's forced phase (phase.ts `forcePhase`): when it answers, the clock is not read. */
	forced?: () => Phase | undefined;
}
/** A snapshot looks at the clock no more often than this. */
export const RECHECK_MS = 60_000;
/** The longest wait armed at once: a far boundary is reached in steps, so a stalled timer is re-armed against the clock. */
const LONGEST = 6 * 3600_000;

const realClock: PhaseClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function mountPhase(env: PhaseEnv = {}) {
	const clock = env.clock ?? realClock, root = env.root ?? (typeof document !== "undefined" ? document.documentElement : undefined);
	const face = root?.dataset.view;
	const read = (): Phase => env.forced?.() ?? phaseAt(new Date(clock.now()));
	const listeners: ((phase: Phase) => void)[] = [];
	let phase = read(), timer: unknown, lastLook = clock.now();
	const paint = () => {
		if (root && root.dataset.view === face) root.dataset.phase = phase;
	};
	function arm() {
		if (timer !== undefined) clock.clearTimeout(timer);
		const at = clock.now();
		const wait = Math.min(LONGEST, Math.max(1000, nextBoundary(new Date(at)).getTime() - at));
		timer = clock.setTimeout(() => ((timer = undefined), check()), wait);
	}
	/** Reads the clock: a new phase is painted and told. */
	function check() {
		lastLook = clock.now();
		const next = read();
		if (next !== phase) {
			phase = next;
			paint();
			for (const fn of listeners) fn(phase);
		}
		arm();
	}
	paint();
	arm();
	const visible = () => env.doc?.visibilityState !== "hidden" && check();
	env.doc?.addEventListener("visibilitychange", visible);
	env.win?.addEventListener("pageshow", check);
	return {
		phase: () => phase,
		check,
		/** A snapshot arrived: look again when a minute has passed since the last look. */
		recheck: () => void (clock.now() - lastLook >= RECHECK_MS && check()),
		onShift: (fn: (phase: Phase) => void) => void listeners.push(fn),
		stop() {
			if (timer !== undefined) clock.clearTimeout(timer);
			env.doc?.removeEventListener("visibilitychange", visible);
			env.win?.removeEventListener("pageshow", check);
		},
	};
}
