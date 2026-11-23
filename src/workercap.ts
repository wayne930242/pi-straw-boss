import { dutyOfAgent } from "./duty.ts";

// The cap on a session's concurrent workers (docs/specs/2026-11-23-lite-main.md §3): at most 4 `worker` subagents run at once, counted from pi-herdr-agents' registry of the children this process
// launched and is still waiting on (orphan.ts `tracked` reads the same slot), plus the worker calls admitted in the message being prepared: pi prepares every tool call of an assistant message before any
// runs, so the registry holds none of them yet. Scouts, planners, reviewers, and resumes are not workers and are never held. A registry that cannot be read holds nothing back.

export const WORKER_CAP = 4;
const REGISTRY = Symbol.for("pi-subagents/runtime");

/** The workers pi-herdr-agents runs for this process, or undefined when its registry cannot be read. */
function runningWorkers(): number | undefined {
	const map = (globalThis as Record<symbol, { runningSubagents?: unknown } | undefined>)[REGISTRY]?.runningSubagents;
	if (!(map instanceof Map)) return undefined;
	let n = 0;
	for (const run of map.values()) if (dutyOfAgent((run as { agent?: unknown } | null)?.agent as string | undefined) === "worker") n++;
	return n;
}

export function createWorkerCap(cap = WORKER_CAP) {
	/** Worker calls admitted whose tool has not returned yet: the registry may not hold them. */
	const admitted = new Set<string>();
	return {
		/** pi's `tool_call` for `subagent`: a refusal when `agent` is a worker and `cap` already run or are admitted. */
		admit(toolCallId: string, agent: unknown): { block: true; reason: string } | undefined {
			if (typeof agent !== "string" || dutyOfAgent(agent) !== "worker") return undefined;
			const running = runningWorkers();
			if (running === undefined) return undefined;
			if (running + admitted.size >= cap) return { block: true, reason: `sb: ${cap} workers run for this main already (${running} running, ${admitted.size} starting in this message): wait for a result, then dispatch the next; a scout, a planner, or a reviewer may run now.` };
			admitted.add(toolCallId);
			return undefined;
		},
		/** pi's `tool_result` for `subagent`: the launch ended, and the registry holds the worker if it started. */
		ran: (toolCallId: string) => void admitted.delete(toolCallId),
		/** The turn ended: every call of it has run (or was blocked by another extension, which leaves no result to clear it). */
		settle: () => admitted.clear(),
	};
}
