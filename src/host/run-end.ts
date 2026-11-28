// A run's end as sb's host tells it (docs/specs/2026-11-28-todo-preflight.md B, S6). Maestro's `subagent_result` and `subagent_ping` name the run's session file, and a result its `elapsed`
// seconds; neither names the run id, and a ping no time at all, though its run's first segment was spent. The host notes each launch and resume it acknowledged (`status: "started"`, its run id,
// its session file, its start from Maestro's registry), and as each end goes out adds the run id, and a ping's elapsed, to the message's details, then sends `subagent:run-end` on pi.events:
// pi-todo-ledger counts an end by it even when the message never reaches the model (a steer cleared before its turn), once by the run id. Nothing of Maestro is changed; an end of a run
// the host did not note passes as it came.

export const RUN_END_EVENT = "subagent:run-end";
const ENDS = new Set(["subagent_result", "subagent_ping"]), REGISTRY = Symbol.for("pi-subagents/runtime"), NOTED = Symbol.for("pi-straw-boss/run-starts"), KEEP = 256;

interface Start { id: string; at: number }
type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** When Maestro's registry says run `id` started (its `startTime`), while it still holds the run. */
export const registryStart = (id: string): number | undefined => {
	const map = (globalThis as Record<symbol, { runningSubagents?: unknown } | undefined>)[REGISTRY]?.runningSubagents, at = map instanceof Map ? (map.get(id) as { startTime?: unknown } | undefined)?.startTime : undefined;
	return typeof at === "number" && Number.isFinite(at) ? at : undefined;
};
/** The noted starts by session file, kept on the process so a /reload keeps the runs it launched. */
const noted = (): Map<string, Start> => ((globalThis as Record<symbol, Map<string, Start> | undefined>)[NOTED] ??= new Map());

export interface RunEnds {
	/** A `subagent` or `subagent_resume` result: a started run is noted by its session file. */
	started(tool: string, details: unknown): void;
	/** A message the host sends: an end of a noted run, with its run id and a ping's elapsed added, and the event to send once it went out; anything else as it came. */
	ended<M extends { customType?: string; details?: unknown }>(message: M): { message: M; event?: Json };
}

export function createRunEnds(d: { now(): number; startOf(id: string): number | undefined }): RunEnds {
	const runs = noted();
	return {
		started(tool, details) {
			if (!obj(details) || details.status !== "started" || !text(details.id)) return;
			const file = tool === "subagent_resume" ? details.sessionPath : details.sessionFile;
			if (!text(file)) return;
			runs.delete(file), runs.set(file, { id: details.id, at: d.startOf(details.id) ?? d.now() });
			for (const key of runs.keys()) { if (runs.size <= KEEP) break; runs.delete(key); }
		},
		ended(message) {
			const details = message.details;
			if (!ENDS.has(message.customType ?? "") || !obj(details) || !text(details.sessionFile)) return { message };
			const run = runs.get(details.sessionFile);
			if (!run) return { message };
			runs.delete(details.sessionFile); // an end closes its run: a resume notes the next one
			const elapsed = typeof details.elapsed === "number" ? details.elapsed : Math.max(0, Math.floor((d.now() - run.at) / 1000));
			const out = { ...details, ...(text(details.id) ? {} : { id: run.id }), ...(typeof details.elapsed === "number" ? {} : { elapsed }) };
			const event = { v: 1, id: run.id, kind: message.customType === "subagent_ping" ? "ping" : "result", ...(text(details.name) ? { name: details.name } : {}), ...(text(details.item) ? { item: details.item } : {}), sessionFile: details.sessionFile, elapsed };
			return { message: { ...message, details: out }, event };
		},
	};
}
