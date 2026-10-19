import type { Bus } from "./owners.ts";

// The session's background monitors, from pi-loop-monitor's events on the session's bus (monitor:started, monitor:output,
// monitor:finished), for the GUI: the bridge relays the list with its dialogs (bridge.ts). pi-loop-monitor offers other extensions no
// way to stop one, so the list is read-only. An ended monitor stays 15 minutes, as long as pi-loop-monitor keeps its record.

/** `stale`: stopped for inactivity (pi-loop-monitor's timeout). `last`: its newest output line. */
export interface Monitor { id: string; what: string; status: "running" | "done" | "error" | "stale" | "stopped"; exit?: number; last?: string; lines: number; at: number; ended?: number }
export const MAX_MONITORS = 6, MONITOR_TEXT = 160;
const KEEP_MS = 15 * 60_000, STATUSES = new Set(["running", "done", "error", "stale", "stopped"]);
// Terminal escapes go, then any other control character; what is left is cut to MONITOR_TEXT.
const clean = (v: unknown) => {
	const s = String(v ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
	return s.length > MONITOR_TEXT ? `${s.slice(0, MONITOR_TEXT - 1)}…` : s;
};
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const text = (v: unknown, empty = false): v is string => typeof v === "string" && v.length <= MONITOR_TEXT && (empty || v.length > 0) && !CONTROL.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** What the hub accepts from a bridge. */
export function monitorsOk(list: unknown): list is Monitor[] {
	return Array.isArray(list) && list.length <= MAX_MONITORS && list.every((m: Partial<Monitor> | null) => m !== null && typeof m === "object" && text(m.id) && text(m.what) && STATUSES.has(m.status as string) && count(m.lines) && count(m.at) && (m.ended === undefined || count(m.ended)) && (m.exit === undefined || Number.isSafeInteger(m.exit)) && (m.last === undefined || text(m.last, true)));
}

/** `changed` runs on every change; output lines, which pi-loop-monitor sends at most once a second per monitor, at most once per `throttleMs`. */
export function trackMonitors(bus: Bus, changed: () => void, { now = Date.now, throttleMs = 2000 } = {}) {
	const all = new Map<string, Monitor>();
	let timer: ReturnType<typeof setTimeout> | undefined, prune: ReturnType<typeof setTimeout> | undefined;
	const soon = () => timer ?? ((timer = setTimeout(() => ((timer = undefined), changed()), throttleMs)), timer.unref?.());
	// One timer for the next ended monitor to leave, so its leaving is told too; it sets the one after.
	const schedule = () => {
		if (prune) clearTimeout(prune);
		const next = Math.min(...[...all.values()].map((m) => (m.ended === undefined ? Infinity : m.ended + KEEP_MS + 1000)));
		prune = Number.isFinite(next) ? setTimeout(() => ((prune = undefined), changed(), schedule()), Math.max(0, next - now())) : undefined;
		prune?.unref?.();
	};
	const id = (d: unknown) => ((x) => (typeof x === "string" && x.length > 0 && x.length <= 64 ? x : undefined))((d as { monitorId?: unknown } | null)?.monitorId);
	const offs = [
		bus.on("monitor:started", (d) => {
			const k = id(d), e = d as { command?: unknown; description?: unknown };
			if (!k) return;
			all.set(k, { id: k, what: clean(e.description) || clean(e.command) || `#${k}`, status: "running", lines: 0, at: now() });
			changed();
		}),
		bus.on("monitor:output", (d) => {
			const m = all.get(id(d) ?? ""), e = d as { line?: unknown; outputLines?: unknown };
			if (!m || m.status !== "running") return;
			[m.last, m.lines] = [clean(e.line), count(e.outputLines) ? (e.outputLines as number) : m.lines];
			if (throttleMs) soon();
			else changed();
		}),
		bus.on("monitor:finished", (d) => {
			const m = all.get(id(d) ?? ""), e = d as { status?: unknown; reason?: unknown; exitCode?: unknown; outputLines?: unknown };
			if (!m || m.status !== "running") return;
			m.status = e.status === "completed" ? "done" : e.status === "error" ? "error" : e.reason === "timeout" ? "stale" : "stopped";
			if (Number.isSafeInteger(e.exitCode)) m.exit = e.exitCode as number;
			if (count(e.outputLines)) m.lines = e.outputLines as number;
			m.ended = now();
			schedule();
			changed();
		}),
	];
	return {
		/** Running ones first, then the newest; at most MAX_MONITORS. */
		list(): Monitor[] {
			for (const [k, m] of all) if (m.ended !== undefined && now() - m.ended > KEEP_MS) all.delete(k);
			return [...all.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.at - a.at || Number(b.id) - Number(a.id)).slice(0, MAX_MONITORS).map((m) => ({ ...m }));
		},
		clear: () => all.clear(),
		off() {
			offs.forEach((off) => off());
			[timer, prune].forEach((t) => t && clearTimeout(t));
		},
	};
}
