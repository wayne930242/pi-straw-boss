// pi-herdr-agents owns these runs. Ask the current owner on each read: a /reload can replace it without losing supervision.
export interface RunEvents { emit(channel: string, request: unknown): void }
export interface RunHost { events?: RunEvents }
interface Run { id: string; name: string; agent?: string }
type Runs = { source: "snapshot" | "legacy"; runs: Run[] } | { source: "unknown"; runs?: undefined };
export type RunCount = { source: "snapshot" | "legacy"; count: number } | { source: "unknown" };

const CHANNEL = "pi-herdr-agents:runs:v1", SLOT = Symbol.for("pi-subagents/runtime"), DELIVERY = ["pending", "delivered", "suppressed"];
/** A whole v1 row (maestro/core/tracked-runs.ts `TrackedRun`); a row missing a field is no proof of what the owner tracks (review snapshot-F005). */
const isRun = (row: unknown): row is Run => {
	const r = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
	return !!r && typeof r.id === "string" && typeof r.name === "string" && (r.agent === undefined || typeof r.agent === "string") && typeof r.persistent === "boolean" && DELIVERY.includes(r.delivery as string);
};

/** A synchronous reply wins even when empty. An unreadable reply proves nothing; only an absent reply selects the old host's process-wide Map. */
export function readRuns(events?: RunEvents): Runs {
	const probe: { snapshot?: { version?: unknown; runs?: unknown } | null } = {};
	events?.emit(CHANNEL, probe);
	if (probe.snapshot !== undefined) {
		const rows = probe.snapshot?.runs;
		// Array.from reads a hole as undefined, which is no run: `every` alone skips holes.
		return probe.snapshot?.version === 1 && Array.isArray(rows) && Array.from(rows).every(isRun) ? { source: "snapshot", runs: rows } : { source: "unknown" };
	}
	const map = (globalThis as Record<symbol, { runningSubagents?: unknown } | undefined>)[SLOT]?.runningSubagents;
	if (!(map instanceof Map)) return { source: "unknown" };
	return { source: "legacy", runs: Array.from(map, ([id, value]) => ({ id, name: String(value?.name ?? ""), agent: value?.agent })) };
}

export function tracked(events?: RunEvents): Set<string> | undefined {
	const { runs } = readRuns(events);
	return runs && new Set(runs.map((r) => r.id));
}

export function runCount(events?: RunEvents): RunCount {
	const state = readRuns(events);
	return state.source === "unknown" ? { source: "unknown" } : { source: state.source, count: state.runs.length };
}
