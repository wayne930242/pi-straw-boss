import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ARM_TEXT } from "./moments.ts";
import type { Kit } from "./state.ts";
import type { Probe } from "./stillruns.ts";

// An idle wake: a main idle `idleMs` gets one message per idle period, once nothing of it runs. Two of them: the idle nudge of a coordinator or integrator (wrapup.ts, docs/specs/2026-11-25-idle-wrap-up.md part 1), which
// auto mode stops (the boss is away; its clock starts again when he is back), and the standing main's wake when nothing is armed (`armWake`, docs/specs/2026-11-26-standing-prompt.md; boss 2026-11-26
// 「閒置喚醒的條件也應該不同」), which runs under auto mode too, since a standing main runs unattended. The clock is the session's own: it sees each turn start and end, so the turn a wake starts is not counted as
// new work (the server's minute look could not tell them apart).

const LOOK_MS = 60_000;
export const ARM_MESSAGE = "straw-boss-arm", ARM_IDLE_MS = 2 * 3600_000;

/** The idle clock of one main: when its last turn settled, and whether this idle period had its wake (or the boss's no). */
export function idleClock(now: () => number, idleMs: number) {
	let since: number | undefined = now(), busy = false, nudged = false, nudgeTurn = false;
	return {
		/** A turn starts: one the wake did not start is new work, and opens a new idle period. */
		start() {
			busy = true;
			if (nudgeTurn) nudgeTurn = false;
			else nudged = false;
		},
		/** The turn and its follow-ups ended: idle from now. */
		settle() { busy = false; since = now(); },
		/** Whether a wake is due. `away` (auto mode) stops the clock; it starts again when the boss is back. */
		due(away: boolean): boolean {
			if (away) return (since = undefined), false;
			if (busy) return false;
			since ??= now();
			return !nudged && now() - since >= idleMs;
		},
		/** The wake went out: the turn it starts is its own, not new work. */
		sent() { nudged = true; nudgeTurn = true; },
		/** The boss said not yet: no wake until the main has worked again. */
		hold() { nudged = true; },
	};
}

export interface WakeSpec {
	idleMs: number;
	/** Whether this main gets this wake (its kind). */
	eligible(): boolean;
	/** Nothing of it runs: the wake may go out. */
	ready(): Promise<boolean>;
	customType: string;
	text: string;
	/** It goes out under auto mode too. */
	underAuto: boolean;
	/** It goes to a main a tower opened for a teammate's device too (a worker's, docs/specs/2026-11-26-ally-workers.md); the others never do. */
	forLink?: true;
}
export const idleWake = (now: () => number, spec: WakeSpec) => ({ ...spec, clock: idleClock(now, spec.idleMs) });
export type Wake = ReturnType<typeof idleWake>;

/** The standing main's wake: idle 2 hours with nothing armed (no boss_watch watch, monitor, loop, or subagent of its own; a read that fails counts as armed), told once per idle period to re-arm what it minds. */
export const armWake = (now: () => number, duty: () => string, probe: Pick<Probe, "strict">) =>
	idleWake(now, { idleMs: ARM_IDLE_MS, eligible: () => duty() === "standing", ready: async () => !(await probe.strict()).length, customType: ARM_MESSAGE, text: ARM_TEXT, underAuto: true });

/** Looks once a minute (`cfg.idleLook` in a test): `first` before any wake (rotclose.ts: an old main that handed over gets none), then the first wake this main is eligible for. Returns the look. */
export function idleWakes({ pi, cfg, s, role }: Kit, wakes: Wake[], first?: (ctx: ExtensionContext) => Promise<boolean>) {
	let ctx: ExtensionContext | undefined, stop: (() => void) | undefined, looking = false;
	const look = async () => {
		if (looking || !ctx) return;
		looking = true;
		try {
			if (await first?.(ctx)) return;
			if (role() !== "main" || s.isTrain || s.closing) return;
			const w = wakes.find((x) => x.eligible() && (x.forLink || !s.openedBy?.startsWith("link:")));
			if (!w || !w.clock.due(!w.underAuto && s.autoOn()) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			if (!(await w.ready()) || !ctx.isIdle()) return;
			w.clock.sent();
			pi.sendMessage({ customType: w.customType, content: w.text, display: true }, { triggerTurn: true });
		} catch { /* the next look tries again */ } finally {
			looking = false;
		}
	};
	pi.on("session_start", (_e, c) => {
		ctx = c;
		stop?.();
		stop = (cfg.idleLook ?? ((fn) => ((t) => (t.unref?.(), () => clearInterval(t)))(setInterval(() => void fn(), LOOK_MS))))(look);
	});
	pi.on("session_shutdown", () => void (stop?.(), (stop = undefined)));
	pi.on("agent_start", (_e, c) => void ((ctx = c), wakes.forEach((w) => w.clock.start())));
	pi.on("agent_settled", (_e, c) => void ((ctx = c), wakes.forEach((w) => w.clock.settle())));
	return look;
}
