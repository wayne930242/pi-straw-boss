// How far one opening (spawn.ts) has got, for the page to poll while the opening's own request is still on its way. An opening is a few steps
// in order: create (the workspace, tab, or pane), start (pi in it), join (until it is on the net), and deliver (the first message, when there is one).
// The page names an opening by an id it makes, and asks for its progress with POST /<token>/api/open/progress {id}; the last few are kept.

export type StepId = "create" | "start" | "join" | "deliver";
export type StepState = "pending" | "active" | "done" | "failed";
/** `ms` is how long the step has run (an active one) or ran (a finished one), by the server's clock. */
export interface Progress { steps: { id: StepId; state: StepState; ms: number }[]; finished: boolean; failed?: { step: StepId; reason: string } }

const KEPT = 16, ID = /^[\w-]{8,64}$/;

export function createDeploy(plan: StepId[], now: () => number = Date.now) {
	const state = new Map<StepId, StepState>(plan.map((id) => [id, "pending"])), began = new Map<StepId, number>(), took = new Map<StepId, number>();
	let active: StepId | undefined, finished = false, failed: Progress["failed"];
	const end = (to: StepState) => {
		if (!active) return;
		took.set(active, now() - began.get(active)!);
		state.set(active, to);
		active = undefined;
	};
	return {
		/** The step now running; the one before it is done. */
		go(step: StepId) {
			end("done");
			state.set((active = step), "active");
			began.set(step, now());
		},
		finish() {
			end("done");
			finished = true;
		},
		/** The running step failed (the first, when none had begun). */
		fail(reason: string) {
			const step = active ?? plan[0]!;
			if (!active) state.set(step, "failed"), took.set(step, 0);
			end("failed");
			failed = { step, reason };
		},
		get failed() {
			return failed;
		},
		view(): Progress {
			return { steps: plan.map((id) => ({ id, state: state.get(id)!, ms: id === active ? now() - began.get(id)! : (took.get(id) ?? 0) })), finished, ...(failed && { failed }) };
		},
	};
}
export type Deploy = ReturnType<typeof createDeploy>;

/** The openings in flight or just over, by the id the page gave. */
export function createDeploys(now?: () => number) {
	const kept = new Map<string, Deploy>();
	return {
		valid: (id: unknown): id is string => typeof id === "string" && ID.test(id),
		begin(id: string | undefined, plan: StepId[]) {
			const deploy = createDeploy(plan, now);
			if (id === undefined) return deploy;
			kept.set(id, deploy);
			for (const old of kept.keys()) if (kept.size > KEPT) kept.delete(old);
			return deploy;
		},
		get: (id: unknown) => (typeof id === "string" ? kept.get(id) : undefined),
	};
}
