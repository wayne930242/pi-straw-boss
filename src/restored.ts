import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, FINAL, tracked } from "./orphan.ts";
import { artifacts, ownFile, readJson } from "./netdata.ts";
import { type HerdrRun, panes, type Sleep, waitFor } from "./herdr.ts";

// A subagent that a Herdr restart brought back as a plain pi is closed, and its launcher is asked to resume it.
//
// With `resume_agents_on_restore` (Herdr's default) a restart starts `pi --session <file>` in every pane that had reported an agent session, subagent panes
// included. That pi has none of what pi-herdr-agents gave the child (its `subagent-done.ts` extension, the PI_SUBAGENT_* environment, caller_ping, the auto-exit
// and the `.exit` sidecar), so it idles at its prompt with the work unfinished and never reports. The launcher is restored with the same session file, but its
// registry of launched children (see orphan.ts) starts empty and is never filled again, so it would not hear of the child either.
//
// pi-herdr-agents' own public way back is `subagent_resume`, which the launcher's model calls; this module does not start the child itself, import
// pi-herdr-agents, or write a result for it. It closes the restored pane (a second pi on the same session file must not run beside the resumed one), then hands
// the launcher one steering custom message that triggers a turn and names the runs with the arguments to resume them by. A message is how the extension drives
// a model: the same way pi-herdr-agents delivers `subagent_result`, and it reaches a busy launcher at its next step and an idle one at once.

export interface Restored {
	run: HerdrRun;
	sleep: Sleep;
	/** This session's file, and every entry of its transcript. */
	file(): string | undefined;
	entries(): Entry[];
	/** Whether this session may act: a tower is driven by the server's queue and never by a message of this kind. */
	active(): boolean;
	/** The session entry type that records a run, and the write of one. */
	type: string;
	remember(key: string): void;
	/** Hands the launcher's model the request; throws when the session cannot take it. */
	resume(text: string, details: unknown): void;
	tell(text: string, level?: "info" | "warning"): void;
}
interface Launch { name: string; session: string; surface: string }
interface Found extends Launch { id: string; pane: string; worktree?: { path?: string; branch?: string } }

const GIVE_UP = 8;
const CLOSE_MS = 5_000;
export const FOLLOW_UP = "Herdr restarted while you were working, and your pane came back without your subagent tooling. Read your session so far, finish the task you were given, and report your result.";
const SCRIPT = /\/subagent-scripts\/[^/]+\.sh$/;

/** The name, session file and pane in the header of the launch script of run `id`, or undefined for a persistent specialist (it cannot be resumed) or a script that is not there. */
function launchOf(file: string, id: string): Launch | undefined {
	const dir = join(artifacts(file), "subagent-scripts");
	try {
		const script = readdirSync(dir).find((name) => name.endsWith(`-${id}.sh`));
		if (!script) return undefined;
		const text = readFileSync(join(dir, script), "utf8"), field = (re: RegExp) => re.exec(text)?.[1]?.trim();
		const session = field(/^# Session: (.+)$/m), surface = field(/^# Surface: (.+)$/m);
		if (!session || !surface || !ownFile(session, id) || /\bPI_SUBAGENT_PERSISTENT=1\b/.test(text)) return undefined;
		return { name: field(/^# Subagent launch script for (.+)$/m) ?? id.slice(0, 8), session, surface };
	} catch {
		return undefined;
	}
}

export function restored(d: Restored) {
	// The runs already acted on (this module's `resumed`) or already asked to report (orphan.ts's `nudged`) are read back from the session.
	const done = new Set<string>();
	for (const e of d.entries()) {
		if (e.type !== "custom" || e.customType !== d.type) continue;
		const { resumed, nudged } = (e.data ?? {}) as { resumed?: unknown; nudged?: unknown };
		for (const key of [resumed, nudged]) if (typeof key === "string") done.add(key);
	}
	// A run counts as a miss when no pane of Herdr is the restored one; after GIVE_UP misses it is left alone until the next session start (a reload counts).
	const misses = new Map<string, number>(), launches = new Map<string, Launch | undefined>();
	let before = new Set<string>(), busy = false, stopped = false;
	const miss = (id: string) => void misses.set(id, (misses.get(id) ?? 0) + 1);

	/** What runs in the foreground of `pane`: a launch script (the child as pi-herdr-agents started it, or a run someone resumed), a pi on its own (a restored one), or unknown. */
	async function shape(pane: string): Promise<"script" | "plain" | "unknown"> {
		try {
			const list = JSON.parse(await d.run(["pane", "process-info", "--pane", pane])).result.process_info.foreground_processes as { argv?: string[] }[];
			if (!Array.isArray(list) || list.length === 0) return "unknown";
			return list.some((p) => p.argv?.some((arg) => SCRIPT.test(arg))) ? "script" : "plain";
		} catch {
			return "unknown";
		}
	}

	async function poll(): Promise<void> {
		if (busy || stopped) return;
		const file = d.file(), live = tracked();
		// A session that cannot say what it tracks cannot say what is lost; a tower and a session without a file have nothing to resume.
		if (!file || !live || !d.active()) return void (before = new Set());
		busy = true;
		try {
			let ids: string[] = [];
			try {
				ids = readdirSync(join(artifacts(file), "subagent-activity")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
			} catch {} // no subagent was ever launched from this session
			ids = ids.filter((id) => !live.has(id) && !done.has(id) && (misses.get(id) ?? 0) < GIVE_UP);
			const reported = ids.length ? d.entries().flatMap((e) => (e.type === "custom_message" && FINAL.includes(e.customType ?? "") ? [String((e.details as { sessionFile?: unknown } | undefined)?.sessionFile ?? "")] : [])) : [];
			const candidates: (Launch & { id: string })[] = [];
			for (const id of ids.filter((id) => !reported.some((f) => ownFile(f, id)))) {
				if (!launches.has(id)) launches.set(id, launchOf(file, id));
				const launch = launches.get(id);
				// A child that wrote its exit sidecar has finished: it is no stranded run, and its result is not ours to repeat.
				if (!launch || existsSync(`${launch.session}.exit`)) miss(id);
				else candidates.push({ id, ...launch });
			}
			if (!candidates.length) return void (before = new Set());
			const ps = await panes(d.run);
			const found: Found[] = [];
			for (const c of candidates) {
				// The restored pane keeps the pane id the launch script recorded; a run another session resumed, or a pi someone started on the file, sits in a pane of its own.
				const pane = ps.find((p) => p.pane_id === c.surface && p.agent === "pi" && ownFile(p.agent_session?.value, c.id));
				if (!pane) {
					miss(c.id);
					continue;
				}
				// Working or asking a question is not stranded; a pane someone has looked at is idle, not done.
				if (!["done", "idle"].includes(pane.agent_status ?? "")) continue;
				if (await shape(pane.pane_id) !== "plain") {
					miss(c.id);
					continue;
				}
				const manifest = readJson(join(artifacts(file), "worktree-runs", `${c.id}.json`));
				found.push({ ...c, pane: pane.pane_id, ...(Object.keys(manifest).length ? { worktree: { path: typeof manifest.path === "string" ? manifest.path : undefined, branch: typeof manifest.branch === "string" ? manifest.branch : undefined } } : {}) });
			}
			// Found so twice in a row, so that a pane still coming up after the restart is not taken for a restored one that stays.
			const ripe = found.filter((c) => before.has(c.id));
			before = new Set(found.map((c) => c.id));
			if (stopped) return;
			const resumable: Found[] = [], kept: Found[] = [];
			for (const c of ripe) {
				if (stopped) break;
				// Written down before anything is done: a run is acted on at most once, also when a step below fails or this process ends meanwhile.
				done.add(c.id);
				d.remember(c.id);
				// A managed worktree's pane is the root pane of the retained workspace: it stays, and subagent_resume is no way back for it.
				if (c.worktree) {
					kept.push(c);
					continue;
				}
				try {
					await d.run(["pane", "close", c.pane]);
					const gone = await waitFor(d.sleep, async () => !(await panes(d.run)).some((p) => p.pane_id === c.pane || p.agent_session?.value === c.session), CLOSE_MS, 250);
					if (!gone) throw new Error("the pane is still open");
					resumable.push(c);
				} catch (error) {
					d.tell(`Straw Boss: could not close the restored pane ${c.pane} of ${c.name}, so it was not resumed: ${(error as Error).message}`, "warning");
				}
			}
			if (!resumable.length && !kept.length) return;
			const runs = [...resumable.map((c) => ({ id: c.id, name: c.name, sessionPath: c.session, pane: c.pane })), ...kept.map((c) => ({ id: c.id, name: c.name, sessionPath: c.session, pane: c.pane, worktree: c.worktree }))];
			try {
				d.resume(message(resumable, kept), { runs });
				d.tell(`Straw Boss: ${[resumable.length ? `closed the restored pane of ${resumable.map((c) => c.name).join(", ")} and asked this session to resume ${resumable.length === 1 ? "it" : "them"}` : "", kept.length ? `told this session that ${kept.map((c) => c.name).join(", ")} ${kept.length === 1 ? "is a worktree run that stays" : "are worktree runs that stay"} in ${kept.length === 1 ? "its" : "their"} restored pane` : ""].filter(Boolean).join("; ")}`);
			} catch (error) {
				d.tell(`Straw Boss: could not ask this session to resume ${runs.map((r) => `${r.name} (${r.sessionPath})`).join(", ")}: ${(error as Error).message}`, "warning");
			}
		} finally {
			busy = false;
		}
	}
	return { poll, stop: () => void (stopped = true) };
}

/** What the launcher's model is told. The worktree paragraph is there because subagent_resume neither reattaches a worktree's lifecycle nor accepts such a session. */
export function message(resumable: Found[], kept: Found[]): string {
	const parts = ["Straw Boss: a Herdr restart brought back subagents that you launched as plain pi sessions, without the subagent extension, so they never report, and pi-herdr-agents does not re-adopt a run after a restart. Their results will not arrive by themselves."];
	if (resumable.length) {
		parts.push(`Straw Boss closed the restored pane of each run below. Resume each one now with the subagent_resume tool, one call per run, with the sessionPath and name listed and this message: ${JSON.stringify(FOLLOW_UP)} Each resumed run reports to you as a normal subagent_result; do nothing else for them, and resume a run only once.`, ...resumable.map((c) => `- ${c.name} (run ${c.id}): sessionPath ${c.session}`));
	}
	if (kept.length) {
		parts.push("These runs are managed-worktree runs. subagent_resume does not reattach a worktree run's lifecycle and refuses its session, so do not call it for them, and Straw Boss left their restored panes open: each is the retained workspace's pane. A restored pi is waiting there at its prompt with its session intact. Continue it in that pane (tell the user), or inspect the worktree with worktree_list.", ...kept.map((c) => `- ${c.name} (run ${c.id}): pane ${c.pane}, worktree ${c.worktree?.path ?? "unknown"}, branch ${c.worktree?.branch ?? "unknown"}`));
	}
	return parts.join("\n");
}
