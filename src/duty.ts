// What a main agent is for (docs/specs/2026-11-09-agent-kinds.md §1): its duty, the kind of work it is given, and the graph of the plan it runs. No pi imports: the server and the page load this file.

export const COORDINATOR_DUTIES = ["coordinator", "integrator", "standing"] as const;
export const WORKER_DUTIES = ["worker", "scout", "planner", "reviewer"] as const; // "train" stays the Role; `watchdog` was retired in 0.83.0 (boss_watch)
export type Duty = (typeof COORDINATOR_DUTIES)[number] | (typeof WORKER_DUTIES)[number];
export type CoordinatorDuty = (typeof COORDINATOR_DUTIES)[number];
const AGENT_DUTY: Record<string, Duty> = { worker: "worker", scout: "scout", planner: "planner", reviewer: "reviewer", "visual-tester": "reviewer", "adversarial-reviewer": "reviewer" };
export const GRAPHS = ["single-loop", "fan-out/fan-in", "orchestrator-worker"] as const; // planning.md §1; a graph is not a duty (D10)
export type Graph = (typeof GRAPHS)[number];
export const isCoordinatorDuty = (v: unknown): v is CoordinatorDuty => typeof v === "string" && (COORDINATOR_DUTIES as readonly string[]).includes(v);
export const isWorkerDuty = (v: unknown): v is Exclude<Duty, CoordinatorDuty> => typeof v === "string" && (WORKER_DUTIES as readonly string[]).includes(v);
export const isGraph = (v: unknown): v is Graph => typeof v === "string" && (GRAPHS as readonly string[]).includes(v);
/** A todo's `metadata.graph` as mains write it (review 6's live values) → a graph; anything else has none. */
export const graphOf = (v: unknown): Graph | undefined =>
	v === "orchestrator-worker" ? v : v === "fan-out/fan-in" || v === "fan-out" ? "fan-out/fan-in" : v === "single" || (typeof v === "string" && v.startsWith("single-loop")) ? "single-loop" : undefined;
/** pi-herdr-agents role name → worker duty; a name not listed (or `constructor`, `toString`) has none. */
export const dutyOfAgent = (name: string | undefined): Duty | undefined => (name !== undefined && Object.hasOwn(AGENT_DUTY, name) ? AGENT_DUTY[name] : undefined);
