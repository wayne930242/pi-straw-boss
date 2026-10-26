// How far one opening (spawn.ts) has got, for the page to poll while the opening's own request is still on its way. An opening is a few steps
// in order: create (the workspace, tab, or pane), start (pi in it), join (until it is on the net), and deliver (the first message, when there is one).
// The page names an opening by an id it makes, and asks for its progress with POST /<token>/api/open/progress {id}; the last few are kept.
// A step of its own, `trust`, is inserted before the running one only when the new pi waits on a project trust question (trust/serve.ts): the opening holds there, and the question is in the progress.

import type { SettingsRefusal } from "./trust/settings.ts";
import type { TrustGroup } from "./trust/types.ts";

export type StepId = "create" | "start" | "join" | "deliver" | "trust";
/** The trust question an opening waits on: what the panel shows and answers (the same route as the alert). */
export interface TrustPrompt { id: string; digest: string; folder: string; found: TrustGroup[] }
export type StepState = "pending" | "active" | "done" | "failed";
/** `ms` is how long the step has run (an active one) or ran (a finished one), by the server's clock. */
export interface Progress { steps: { id: StepId; state: StepState; ms: number }[]; finished: boolean; failed?: { step: StepId; reason: string; settings?: SettingsRefusal }; trust?: TrustPrompt }

const KEPT = 16, ID = /^[\w-]{8,64}$/;

export function createDeploy(given: StepId[], now: () => number = Date.now) {
	const plan = [...given], state = new Map<StepId, StepState>(plan.map((id) => [id, "pending"])), began = new Map<StepId, number>(), took = new Map<StepId, number>();
	let active: StepId | undefined, finished = false, failed: Progress["failed"], asking: TrustPrompt | undefined, held: StepId | undefined, pane: string | undefined;
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
		/** The running step failed (the first, when none had begun). `settings` says the folder's .pi/settings.json is why (trust/settings.ts), so the page can word it itself. */
		fail(reason: string, settings?: SettingsRefusal) {
			const step = active ?? plan[0]!;
			if (!active) state.set(step, "failed"), took.set(step, 0);
			end("failed");
			failed = { step, reason, ...(settings && { settings }) };
		},
		get failed() {
			return failed;
		},
		/** The opening is over (done or failed). */
		get over() {
			return finished || Boolean(failed);
		},
		/** The pane the new pi runs in, once there is one: a trust question for it belongs to this opening. */
		get pane() {
			return pane;
		},
		set pane(next: string | undefined) {
			pane = next;
		},
		/**
		 * A trust question holds the opening (`ask` given): `trust` is inserted before the running step, which waits until the question is gone, and runs meanwhile.
		 * Without `ask` the question is over (answered, or its pi ended) and the held step runs again.
		 */
		hold(ask?: TrustPrompt) {
			asking = ask;
			if (ask && active !== "trust") {
				held = active;
				if (!plan.includes("trust")) (plan.splice(Math.max(0, plan.indexOf(held ?? "join")), 0, "trust"), state.set("trust", "pending"));
				if (held) (state.set(held, "pending"), (active = undefined));
				this.go("trust");
			} else if (!ask && active === "trust") {
				end("done");
				if (held) (state.set(held, "active"), (active = held), began.set(held, now()));
				held = undefined;
			}
		},
		view(): Progress {
			return { steps: plan.map((id) => ({ id, state: state.get(id)!, ms: id === active ? now() - began.get(id)! : (took.get(id) ?? 0) })), finished, ...(failed && { failed }), ...(asking && active === "trust" && { trust: asking }) };
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
		/** The id of the opening that runs a pi in `pane` and is not over: the page that made it shows its trust question inline. */
		openingOf: (pane: string) => [...kept].find(([, d]) => d.pane === pane && !d.over)?.[0],
	};
}
