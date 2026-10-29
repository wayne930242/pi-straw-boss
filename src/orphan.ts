import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { artifacts, ownFile, readJson } from "./netdata.ts";
import { type HerdrRun, panes, type Session } from "./herdr.ts";

// A subagent that has finished, while the session that launched it can no longer receive its result, is asked once to report over intercom.
//
// pi-herdr-agents delivers a child's result from the launcher's own process: its watchers, and its registry of launched children (`runningSubagents`, kept
// in the global `Symbol.for("pi-subagents/runtime")` slot so that a reloaded module adopts the map), live in that process's memory. /reload, /new, /resume
// and /fork keep them. Quitting pi suppresses the delivery, and a crash or restart drops them for good: a restarted pi does not adopt the children it launched
// before ("V1 does not automatically recover watchers after a full process restart", docs/tools.md). So a child of this session that the registry no longer
// holds, and whose result is not in the transcript, can no longer be delivered. A registry that cannot be read proves nothing, so nothing is sent then.

export interface Entry { type: string; customType?: string; data?: unknown; details?: unknown }
export interface Orphans {
	run: HerdrRun;
	/** This session's file, and every entry of its transcript. */
	file(): string | undefined;
	entries(): Entry[];
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	/** The session entry type that records a nudge, and the write of one. */
	type: string;
	remember(key: string): void;
	me(): string;
	tell(text: string, level?: "info" | "warning"): void;
}

const REGISTRY = Symbol.for("pi-subagents/runtime");
// The messages that carry a finished child's result into the launcher's transcript; their details name the child's session file.
export const FINAL = ["subagent_result", "subagent_ping"];
const GIVE_UP = 4;

/** The ids of the runs this process's pi-herdr-agents still tracks, or undefined when the registry cannot be read. */
export function tracked(): Set<string> | undefined {
	const map = (globalThis as Record<symbol, { runningSubagents?: unknown } | undefined>)[REGISTRY]?.runningSubagents;
	return map instanceof Map ? new Set(map.keys() as Iterable<string>) : undefined;
}

export function orphans(d: Orphans) {
	const nudged = new Set(d.entries().flatMap((e) => (e.type === "custom" && e.customType === d.type && typeof (e.data as { nudged?: unknown } | undefined)?.nudged === "string" ? [(e.data as { nudged: string }).nudged] : [])));
	// A child counts as a miss when its pane (running its own launch script) or its intercom session cannot be found; after GIVE_UP misses it is left alone.
	const misses = new Map<string, number>();
	let before = new Set<string>(), busy = false, stopped = false;
	const miss = (id: string) => void misses.set(id, (misses.get(id) ?? 0) + 1);
	/**
	 * Whether the foreground process of `pane` runs the launch script this session wrote for run `id`. A pane that only reuses the run's session file
	 * (a run another session resumed, or a pi someone started on that file) is not the run, and the run's activity file says nothing about it.
	 */
	async function runs(pane: string, id: string, session: string): Promise<boolean> {
		const quote = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), script = new RegExp(`/artifacts/${quote(session)}/subagent-scripts/[^/]*-${quote(id)}\\.sh$`);
		try {
			const info = JSON.parse(await d.run(["pane", "process-info", "--pane", pane])).result.process_info.foreground_processes as { argv?: string[] }[];
			return info.some((p) => p.argv?.some((arg) => script.test(arg)));
		} catch {
			return false;
		}
	}

	async function poll(): Promise<void> {
		if (busy || stopped) return;
		const file = d.file(), live = tracked();
		// Without its own session id, a session file, or a readable registry there is nothing to say or to judge by.
		if (!file || !live || !d.me()) return void (before = new Set());
		busy = true;
		try {
			const dir = join(artifacts(file), "subagent-activity");
			let ids: string[] = [];
			try {
				ids = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
			} catch {} // no subagent was ever launched from this session
			ids = ids.filter((id) => !live.has(id) && !nudged.has(id) && (misses.get(id) ?? 0) < GIVE_UP);
			const reported = ids.length ? d.entries().flatMap((e) => (e.type === "custom_message" && FINAL.includes(e.customType ?? "") ? [String((e.details as { sessionFile?: unknown } | undefined)?.sessionFile ?? "")] : [])) : [];
			const open = ids.filter((id) => !reported.some((f) => ownFile(f, id)));
			// Only a child whose own activity says it ended its turn and waits is looked up, and the broker has to list this session under its own
			// id first (the report is asked for there): that is cheaper than Herdr.
			const waiting = open.filter((id) => readJson(join(dir, `${id}.json`)).phase === "waiting");
			const list = waiting.length ? await d.sessions().catch(() => undefined) : undefined, self = list?.find((s) => s.id === d.me());
			const ps = self ? await panes(d.run) : [];
			const found: { id: string; pane: string; name: string }[] = [];
			for (const id of self ? waiting : []) {
				const pane = ps.find((p) => p.agent === "pi" && ownFile(p.agent_session?.value, id));
				if (!pane) miss(id);
				// Working or asking a question is not finished; a pane someone has looked at is idle, not done.
				else if (["done", "idle"].includes(pane.agent_status ?? "")) found.push({ id, pane: pane.pane_id, name: pane.label ?? id.slice(0, 8) });
			}
			// A child has to be found finished twice in a row, so that a delivery that is just going out is not mistaken for a lost one.
			const ripe = found.filter((c) => before.has(c.id));
			before = new Set(found.map((c) => c.id));
			if (!list || !self) return;
			for (const c of ripe) {
				const kid = list.find((s) => s.herdrLocation?.paneId === c.pane && s.id !== self.id);
				if (!kid) {
					miss(c.id);
					continue;
				}
				// Its own intercom status says it is idle; a child that went back to work is not asked.
				if (kid.status !== "idle" || stopped) continue;
				const own = await runs(c.pane, c.id, basename(artifacts(file)));
				if (!own) miss(c.id);
				// The session may have ended while Herdr was asked.
				if (!own || stopped) continue;
				// Written down before it is sent: a nudge is sent at most once per run, even when the send fails or this process ends meanwhile.
				nudged.add(c.id);
				d.remember(c.id);
				const result = await d.send(kid.id, `Straw Boss: the session that launched you ("${self.name ?? self.id}", intercom session ${self.id}) can no longer receive your result by itself; for example, its pi was restarted after it launched you. Send your final report to that session now, with the intercom tool (action "send", to "${self.id}"): the outcome, what changed, and the evidence. Then stop; start no new work. This is sent once and needs no reply.`);
				if (result.status === "sent") d.tell(`Straw Boss: asked ${c.name} to send its report here over intercom, because its result could no longer reach this session`);
				else d.tell(`Straw Boss: could not ask ${c.name} to send its report: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim(), "warning");
			}
		} finally {
			busy = false;
		}
	}
	return { poll, stop: () => void (stopped = true) };
}
