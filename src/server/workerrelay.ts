import { bodyOf, fieldsOf } from "../header.ts";
import { closeWorktree, type Git } from "./workeropen.ts";
import { dropAsk, markFinal, type Route } from "./allyroute.ts";
import type { Slot } from "./record.ts";

// A worker's endings (docs/specs/2026-11-26-ally-workers.md, Relay and end): its one `call_tower` `why: milestone` goes back to the device by code, as the answer to the ask its slip came with, and no ally run
// handles it; the sweep then closes its tab and removes its worktree when nothing would be lost. A worker gone without a report, or idle 60 minutes without one, gets a code receipt instead.

export const WORKER_STOP_MS = 60 * 60_000;
const REPORT_MAX = 48_000;

export interface RelayDeps {
	slot: Slot;
	workspace: string;
	now(): number;
	/** A `tower-reply` to `ask` on `device`, as the workspace's tower identity. */
	send(device: string, text: string, ask: string): Promise<unknown>;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	/** A sweep soon, so the tab closes after the report. */
	sweep(): void;
}
const failed = (a: unknown) => (a as { ok?: unknown } | undefined)?.ok === false;

/**
 * A message from a session whose route is a worker's: its final report when the code-written header says `call_tower` `why=milestone` (its first; later ones go the ally-run way). Sent by code to the ask; `fallback` (the ally
 * answer of before) runs when the route has no ask or the send fails. True when the message was the final report.
 */
export function workerReport(d: RelayDeps, route: Route, text: string, fallback: () => void): boolean {
	const f = fieldsOf(text);
	if (!route.worker || route.final !== undefined || f?.kind !== "call_tower" || f.why !== "milestone") return false;
	markFinal(d.slot, d.workspace, route.to, d.now());
	const w = route.worker, body = bodyOf(text).trim(), report = `Worker ${w.label} (branch ${w.branch}) final report:\n${body.length > REPORT_MAX ? `${body.slice(0, REPORT_MAX)}…` : body}`;
	const ask = route.ask;
	if (!ask) return (fallback(), d.sweep(), true);
	void d.send(route.device, report, ask).then((a) => {
		if (failed(a)) throw new Error(String((a as { error?: unknown }).error ?? "refused"));
		dropAsk(d.slot, d.workspace, route.device, ask, d.now());
		d.log("worker-report", { main: route.to, branch: w.branch });
	}).catch((e: Error) => (d.log("worker-report-failed", { main: route.to, error: e.message.slice(0, 160) }), fallback())).finally(() => d.sweep());
	return true;
}

/** A worker row as the sweep sees it. */
export interface WorkerRow { workspace: string; route: Route }
export interface EndDeps {
	rows(): WorkerRow[];
	now(): number;
	/** The worker's session and pane as the net shows them: `listed` by the broker, its pane still in Herdr (undefined: the read failed), and whether its pane is working. */
	look(row: WorkerRow): Promise<{ listed: boolean; pane: boolean | undefined; working: boolean }>;
	close(workspace: string, main: string, mode: "quit" | "interrupt"): Promise<void>;
	send(workspace: string, device: string, text: string, ask: string): Promise<unknown>;
	forget(workspace: string, main: string): void;
	/** Marks the row ended without a report (it is then closed as a final one). */
	stopped(workspace: string, main: string): void;
	/** Tells the workspace's tower (its next local run) of a worktree kept. */
	notice(workspace: string, text: string, key: string): void;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	git?: Git;
}

export function createWorkerEnds(d: EndDeps) {
	const idleFrom = new Map<string, number>(), goneSeen = new Map<string, number>();
	/** The worktree at the end: removed when clean and pushed or untouched, else kept and the tower told. The line says which, for a receipt. */
	const tidy = async (row: WorkerRow): Promise<string> => {
		const w = row.route.worker!; // git finds the repository from the worktree itself
		const end = await closeWorktree({ dir: w.path, branch: w.branch, baseSha: w.baseSha, ...(d.git ? { git: d.git } : {}) }).catch((e: Error) => ({ removed: false as const, reason: e.message, head: undefined as string | undefined }));
		const head = end.head ? ` at ${end.head.slice(0, 12)}` : "";
		if (end.removed) return (d.log("worker-worktree-removed", { main: row.route.to, branch: w.branch }), `branch ${w.branch}${head}; its worktree was removed`);
		d.log("worker-worktree-kept", { main: row.route.to, branch: w.branch, why: end.reason.slice(0, 160) });
		d.notice(row.workspace, `The worker ${w.label} (branch ${w.branch}) closed and its worktree ${w.path} was kept: ${end.reason}.`, `worker-kept:${row.route.to}`);
		return `branch ${w.branch}${head}; its worktree was kept on the box (${end.reason})`;
	};
	const receipt = async (row: WorkerRow, what: string) => {
		const ask = row.route.ask, line = await tidyOrNot(row);
		if (ask) await d.send(row.workspace, row.route.device, `Worker ${row.route.worker!.label} ${what} without a final report: ${line}.`, ask).catch((e: Error) => d.log("worker-receipt-failed", { error: e.message.slice(0, 160) }));
	};
	let tidied = new Map<string, string>();
	const tidyOrNot = async (row: WorkerRow) => tidied.get(row.route.to) ?? (await tidy(row).then((l) => (tidied.set(row.route.to, l), l)));
	const one = async (row: WorkerRow): Promise<void> => {
		const { route } = row, main = route.to;
		const seen = await d.look(row);
		if (route.final !== undefined) {
			if (!seen.listed && seen.pane === false) return (await tidyOrNot(row), d.forget(row.workspace, main));
			try { await d.close(row.workspace, main, "quit"); } catch (e) { return void d.log("worker-close-waiting", { main, why: (e as Error).message.slice(0, 160) }); }
			await tidyOrNot(row);
			d.forget(row.workspace, main);
			return d.log("worker-closed", { main });
		}
		if (!seen.listed && seen.pane === false) {
			const n = (goneSeen.get(main) ?? 0) + 1;
			goneSeen.set(main, n);
			if (n < 2) return;
			await receipt(row, "is gone (its pi ended)");
			return d.forget(row.workspace, main);
		}
		goneSeen.delete(main);
		if (seen.working) return void idleFrom.delete(main);
		const since = idleFrom.get(main) ?? (idleFrom.set(main, d.now()), d.now());
		if (d.now() - since < WORKER_STOP_MS) return;
		await d.close(row.workspace, main, "interrupt").catch(() => undefined);
		d.stopped(row.workspace, main);
		idleFrom.delete(main);
		const ask = route.ask;
		if (ask) await d.send(row.workspace, route.device, `Worker ${route.worker!.label} (branch ${route.worker!.branch}) was idle ${WORKER_STOP_MS / 60_000} minutes without a final report: the box stopped it and keeps its worktree ${route.worker!.path}.`, ask).catch((e: Error) => d.log("worker-receipt-failed", { error: e.message.slice(0, 160) }));
		d.log("worker-stopped", { main });
	};
	return {
		async sweep(): Promise<void> {
			const rows = d.rows(), live = new Set(rows.map((r) => r.route.to));
			for (const k of [...idleFrom.keys()]) if (!live.has(k)) idleFrom.delete(k);
			tidied = new Map([...tidied].filter(([k]) => live.has(k)));
			for (const row of rows) await one(row).catch((e: Error) => d.log("worker-sweep-failed", { main: row.route.to, error: e.message.slice(0, 160) }));
		},
	};
}
