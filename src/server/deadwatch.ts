import { join } from "node:path";
import type { HerdrRun, Session } from "../herdr.ts";
import { type DeadRow, diedText, gatherDead, LOOP_MS, readLedger, updateLedger } from "../revive.ts";

// The sweep of the resident tower (docs/specs/2026-11-23-tower-revive.md §3): once a minute it reads the role records of each workspace it serves, and a main or train that is dead in two looks a minute apart, outside
// Herdr's recovery window, becomes one `main_died` notice on that workspace's queue, once per death. The notice wakes a run, which decides (D1 A): the code never revives on its own.

export interface DeadWatchDeps {
	stateDir: string;
	run: HerdrRun;
	now(): number;
	sessions(): Promise<Session[]>;
	/** pi's sessions folder. */
	root: string;
	recovering(): boolean;
	/** The workspaces served now, each with its checkout. */
	workspaces(): Promise<{ workspace: string; checkout?: string }[]>;
	/** Queues a notice for a workspace's tower (runs.ts `notice`): false when none serves it. */
	notice(workspace: string, text: string, key: string): boolean;
	log(event: string, facts: Record<string, string | number | boolean>): void;
}

export function createDeadWatch(d: DeadWatchDeps) {
	/** The looks that found a file dead: the first one's time and how many there were. A look that finds it anything else forgets it. */
	const seen = new Map<string, { first: number; looks: number }>();
	/** What the last sweep found, by workspace: the brief's section. */
	const last = new Map<string, DeadRow[]>();
	let busy = false;
	async function sweep(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const served = await d.workspaces();
			const rows = new Map<string, DeadRow[]>();
			const sessions = await d.sessions();
			for (const { workspace, checkout } of served) {
				const found = await gatherDead({ stateDir: d.stateDir, run: d.run, now: d.now(), sessions: async () => sessions, sessionList: sessions, root: d.root, workspace, ...(checkout ? { checkout } : {}), recovering: d.recovering(), seen: (file) => seen.get(file) ?? { first: d.now(), looks: 0 } });
				rows.set(workspace, found);
			}
			const now = d.now(), dying = new Set<string>();
			for (const [workspace, found] of rows) {
				last.set(workspace, found.filter((r) => r.verdict.state !== "closed" && r.verdict.state !== "live"));
				for (const r of found) {
					if (r.verdict.state === "restoring" && !d.recovering()) {
						// Seen dead but not confirmed yet: this look counts.
						const was = seen.get(r.file);
						seen.set(r.file, was ? { first: was.first, looks: was.looks + 1 } : { first: now, looks: 1 });
						dying.add(r.file);
						continue;
					}
					if (r.verdict.state !== "dead") continue;
					dying.add(r.file);
					if (!r.key) continue;
					const ledger = readLedger(d.stateDir, r.file, r.session);
					if (ledger.detections.some((x) => x.key === r.key)) continue;
					// The crash-loop guard: a session that died within 10 minutes of a revive is listed, not raised.
					const revived = ledger.attempts.filter((a) => a.outcome === "revived").at(-1);
					const loop = revived !== undefined && r.ageMs !== undefined && now - r.ageMs - revived.at < LOOP_MS;
					updateLedger(d.stateDir, r.file, now, (l) => void l.detections.push({ key: r.key!, at: now }));
					if (loop) {
						d.log("main-died-loop", { workspace, session: r.session });
						continue;
					}
					const queued = d.notice(workspace, diedText(r, now), `main_died:${r.key}`);
					d.log("main-died", { workspace, session: r.session, queued });
				}
			}
			for (const file of [...seen.keys()]) if (!dying.has(file)) seen.delete(file);
		} catch (cause) {
			d.log("dead-sweep-failed", { why: (cause as Error).message.slice(0, 200) });
		} finally {
			busy = false;
		}
	}
	return { sweep, rows: (workspace: string): DeadRow[] => last.get(workspace) ?? [], ledgerDir: join(d.stateDir, "revive") };
}
export type DeadWatch = ReturnType<typeof createDeadWatch>;
