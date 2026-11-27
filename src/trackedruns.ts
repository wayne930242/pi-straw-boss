import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { artifacts } from "./netdata.ts";

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

/** A launch or resume script that names a session file: when it was generated, and the run id it starts. */
export interface Attempt { path: string; at: number; id?: string }
/** The run id in a subagent session file's name (`<time>_<run id>[-<suffix>].jsonl`, netdata.ts `ownFile`). */
const RUN = /_([^_]+?)(?:-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,4})?\.jsonl$/, ID = /\bPI_SUBAGENT_ID='([^']*)'/;

/**
 * The host's runs of session `file` (docs/how-it-works.md#a-subagent-that-dies-is-revived, the ownership table): every launch or resume script of `launcher` whose header names it, its newest, and
 * `owner`, the run id of any of them the host tracks (a resume takes a session over under a new id, review F007). Undefined: none; null: the runs cannot be read, or a script that may name the file
 * cannot while a tracked id is placed on no other session (review F009). Only the run's own first launch and the resumes can name its file, so a thousand scripts cost a few reads.
 */
export function sessionRuns(launcher: string, file: string, events?: RunEvents): { owner: string | undefined | null; newest?: Attempt } {
	const dir = join(artifacts(launcher), "subagent-scripts"), run = RUN.exec(basename(file))?.[1], named: Attempt[] = [], elsewhere = new Set<string>();
	let names: string[] = [], unread = false;
	try { names = readdirSync(dir).filter((n) => n.endsWith(".sh")); } catch { /* no script folder */ }
	for (const name of names.filter((n) => !run || n.endsWith(`-${run}.sh`) || n.includes("-resume-"))) {
		let text: string;
		try { text = readFileSync(join(dir, name), "utf8"); } catch { unread = true; continue; } // one file, not the scan
		const id = ID.exec(text)?.[1];
		if (/^# Session: (.+)$/m.exec(text)?.[1]?.trim() === file) named.push({ path: join(dir, name), at: Date.parse(/^# Generated: (.+)$/m.exec(text)?.[1] ?? "") || 0, ...(id ? { id } : {}) });
		else if (id) elsewhere.add(id);
	}
	const newest = named.reduce<Attempt | undefined>((a, b) => (!a || b.at >= a.at ? b : a), undefined), live = tracked(events);
	if (!live) return { owner: null, newest };
	// A first launch's script is `<name>-<id>.sh` and names its own run's session: a tracked id with one of those, or read on another session, cannot be the unreadable script's.
	const placed = (id: string) => elsewhere.has(id) || (id !== run && names.some((n) => n.endsWith(`-${id}.sh`) && !n.includes("-resume-")));
	const owner = named.find((a) => a.id !== undefined && live.has(a.id))?.id;
	return { owner: owner ?? (unread && [...live].some((id) => !placed(id)) ? null : undefined), newest };
}

export function runCount(events?: RunEvents): RunCount {
	const state = readRuns(events);
	return state.source === "unknown" ? { source: "unknown" } : { source: state.source, count: state.runs.length };
}
