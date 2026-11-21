import { type CoordinatorDuty, type Graph, isCoordinatorDuty } from "./duty.ts";
import { ENTRY, type Kit } from "./state.ts";
import { planGraph, todosOfBranch } from "./todo.ts";
import { integrationOff } from "./trainswitch.ts";

// A main's kind (docs/specs/2026-11-09-agent-kinds.md §2): one function, `now()`, feeds the prompt, the label, the gate, and the yard. The kind is declared (`boss_duty`) or migrated from the signs of an
// integrator, at most once per session: while `s.duty` is unset only.

/** The two-word name `integrator.md` prescribes: `integ <project>`. */
export const INTEG_NAME = /^integ \S+$/;

export interface MainDuty {
	/** What this main runs as: its declared kind, `coordinator` when none; `integrator` only while the guard and the loaded prompts both have integration on. */
	now(): CoordinatorDuty;
	/** The graph of the plan in this session's own todos (D10); the card and the prompt read the same function. */
	graph(): Graph | undefined;
	/** Whether integration is on for both reads (the train guard's and the prompts'). */
	integrationOn(): boolean;
	/** Writes a kind entry (all four fields), sets `s.duty`, and returns what it was. */
	write(duty: CoordinatorDuty, why: string, source?: "boss_duty"): { from: CoordinatorDuty | undefined };
	/** The migration (§2): only while `s.duty` is unset and integration is on. Returns the sign that matched, if one did. */
	migrate(name: string | undefined): "name" | "train todos" | undefined;
	/** Called after every write of a kind (a switch or a migration): the rebrief, the publish, and the digest line hang here. */
	onWrite(cb: (change: { from: CoordinatorDuty | undefined; to: CoordinatorDuty; why: string; source: "boss_duty" | undefined }) => void): void;
	/** How the train guard's load-time read is told: `() => Boolean(guard)`. Before it is set the switch is read live. Both reads must have integration on (AK3-F003). */
	trainOn(read: () => boolean): void;
	/** Called by the briefing's owner: how the loaded prompts say integration is off. */
	promptsOff(read: () => boolean | undefined): void;
}

export function createMainDuty(kit: Kit): MainDuty {
	const { pi, s, cfg, guiDir } = kit;
	const listeners: Parameters<MainDuty["onWrite"]>[0][] = [];
	let off: () => boolean | undefined = () => undefined, guarded: (() => boolean) | undefined;
	const integrationOn = () => (guarded ? guarded() : !integrationOff(cfg.env, guiDir)) && off() !== true;
	const hasTrainTodo = () => (todosOfBranch(s.branch()) ?? []).some((t) => t.sb?.kind === "train");
	return {
		integrationOn,
		onWrite: (cb) => void listeners.push(cb),
		promptsOff: (read) => void (off = read),
		trainOn: (read) => void (guarded = read),
		now: () => (s.duty === "integrator" && !integrationOn() ? "coordinator" : (s.duty ?? "coordinator")),
		graph: () => planGraph(todosOfBranch(s.branch()) ?? []),
		write(duty, why, source) {
			const from = isCoordinatorDuty(s.duty) ? s.duty : undefined;
			pi.appendEntry(ENTRY, { duty, dutyFrom: from ?? null, dutyWhy: why, dutyAt: cfg.now() });
			s.duty = duty;
			for (const cb of listeners) cb({ from, to: duty, why, source });
			return { from };
		},
		migrate(name) {
			if (s.duty !== undefined || !integrationOn() || kit.role() !== "main") return undefined;
			const sign = name !== undefined && INTEG_NAME.test(name) ? "name" : hasTrainTodo() ? "train todos" : undefined;
			if (sign) this.write("integrator", `migrated: ${sign}`);
			return sign;
		},
	};
}
