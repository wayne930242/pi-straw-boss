/**
 * The state of sb's subagent host in this process, kept under one branded global so sb_doctor, the session's recovery paths,
 * and the tests read the same answer without importing the engine (docs/how-it-works.md#the-subagent-host).
 *
 * - `off`: host.json or PI_STRAW_BOSS_HOST turned it off; nothing registers.
 * - `pending`: selected; the check runs at session start, once every extension has registered.
 * - `active`: sb registered the subagent tools and owns the runs this process launches.
 * - `stood-down`: another extension registered `subagent` (pi-herdr-agents, or another sb copy); sb registered nothing.
 * - `failed`: the engine threw while it loaded.
 */
export type HostState =
	| { state: "off"; from: string }
	| { state: "pending"; from: string }
	| { state: "active"; from: string }
	| { state: "stood-down"; from: string; why: string; others: string[] }
	| { state: "failed"; from: string; error: string };

export const HOST_STATE_KEY = Symbol.for("pi-straw-boss/host-state");

type Slot = Record<symbol, HostState | undefined>;

export function hostState(): HostState | undefined {
	return (globalThis as unknown as Slot)[HOST_STATE_KEY];
}

export function setHostState(state: HostState): void {
	(globalThis as unknown as Slot)[HOST_STATE_KEY] = state;
}

/** Whether sb's host launched, and so owns, the subagent runs of this process: the older recovery paths written for pi-herdr-agents stand aside for them. */
export const hostOwnsRuns = (): boolean => hostState()?.state === "active";

/** One line for sb_doctor and /boss doctor. */
export function describeHost(state = hostState()): string {
	if (!state) return "not loaded (this pi did not load pi-straw-boss's src/host/index.ts)";
	switch (state.state) {
		case "off": return `off (${state.from})`;
		case "pending": return "selected, waiting for session start";
		case "active": return "active: sb registered subagent, subagent_cancel, subagent_resume and subagents_list";
		case "stood-down": return `stood down: ${state.why}`;
		case "failed": return `failed to load: ${state.error}`;
	}
}
