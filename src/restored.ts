import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, FINAL } from "./orphan.ts";
import { tracked, type RunHost } from "./trackedruns.ts";
import { artifacts, ownFile, readJson } from "./netdata.ts";
import { type Cut, continueText, cutOf, describe } from "./cut.ts";
import { type HerdrRun, panes, type Session, type Sleep, waitFor } from "./herdr.ts";

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
//
// A child whose session ends mid-turn (cut.ts: a tool call with no result, a result nobody read, a message nobody answered) is told so, once: a resumed run in its follow-up, which the
// launcher passes to `subagent_resume`, and a worktree run, whose pane stays, over intercom (never typed, so whatever the boss has in the prompt stays; a draft in the editor does not stop the child from
// starting its turn, see docs/how-it-works.md), with the launcher's id to send its report to, and only while its intercom status is idle and its transcript still ends in the cut. The launcher's message says which runs
// were cut and whether the child was told.

export interface Restored extends RunHost {
	run: HerdrRun;
	sleep: Sleep;
	/** This session's file, and every entry of its transcript. */
	file(): string | undefined;
	entries(): Entry[];
	/** Whether this session may act: a tower is driven by the server's queue and never by a message of this kind. */
	active(): boolean;
	/** This session as the broker knows it: the one a told worktree run sends its report to (none while it has no intercom id). */
	launcher(): { id: string; name: string } | undefined;
	/** The broker's live sessions, and one message to one of them: the way to a restored worktree run that stays in its pane. */
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	/** The session entry type that records a run, and the write of one (`{ resumed }`, `{ closing }`, `{ gaveUp }`, `{ continued }`, or `{ seen, terminal }`). */
	type: string;
	remember(data: Record<string, string>): void;
	/** The platform whose process lists are read (the host's by default). */
	platform?: string;
	/** Hands the launcher's model the request; throws when the session cannot take it. */
	resume(text: string, details: unknown): void;
	tell(text: string, level?: "info" | "warning"): void;
}
interface Launch { name: string; session: string; surface: string; autoExit?: false }
/** `cut`: the session ends mid-turn. `told`: a worktree run was told over intercom to continue; `why`: what stopped it when it was not. */
interface Found extends Launch { id: string; pane: string; worktree?: { path?: string; branch?: string }; cut?: Cut; told?: boolean; why?: string }

const GIVE_UP = 8, REACH = 4;
const CLOSE_MS = 5_000;
export const FOLLOW_UP = "Herdr restarted while you were working, and your pane came back without your subagent tooling. Read your session so far, finish the task you were given, and report your result.";
const SCRIPT = /[\\/]subagent-scripts[\\/][^\\/]+\.sh$/;
const POLICY = ".pi-herdr-subagent-policy.json";

/** The name, session file and pane in the header of the launch script of run `id`, or undefined for a persistent specialist (it cannot be resumed) or a script that is not there. */
function launchOf(file: string, id: string): Launch | undefined {
	const dir = join(artifacts(file), "subagent-scripts");
	try {
		const script = readdirSync(dir).find((name) => name.endsWith(`-${id}.sh`));
		if (!script) return undefined;
		const text = readFileSync(join(dir, script), "utf8"), field = (re: RegExp) => re.exec(text)?.[1]?.trim();
		const session = field(/^# Session: (.+)$/m), surface = field(/^# Surface: (.+)$/m);
		if (!session || !surface || !ownFile(session, id) || /\bPI_SUBAGENT_PERSISTENT=1\b/.test(text)) return undefined;
		return { name: field(/^# Subagent launch script for (.+)$/m) ?? id.slice(0, 8), session, surface, ...(/\bPI_SUBAGENT_AUTO_EXIT=0\b/.test(text) ? { autoExit: false as const } : {}) };
	} catch {
		return undefined;
	}
}

/** Whether a run of the host or a result in `entries` has `session` now: a resume takes it under a new run id, so a run is matched by its script's session file (review F009). */
function taken(file: string, session: string, entries: Entry[], events: Restored["events"]): boolean | null {
	const live = tracked(events), dir = join(artifacts(file), "subagent-scripts");
	if (!live) return null;
	if (entries.some((e) => e.type === "custom_message" && FINAL.includes(e.customType ?? "") && (e.details as { sessionFile?: unknown } | undefined)?.sessionFile === session)) return true;
	try {
		return readdirSync(dir).some((name) => {
			const text = name.endsWith(".sh") ? readFileSync(join(dir, name), "utf8") : "", id = /\bPI_SUBAGENT_ID='([^']*)'/.exec(text)?.[1];
			return id !== undefined && live.has(id) && /^# Session: (.+)$/m.exec(text)?.[1]?.trim() === session;
		});
	} catch {
		return false;
	}
}

/** The sidecar pi-herdr-agents writes beside a subagent session file, or undefined when there is none or it cannot be read. */
function policyOf(file: string): { owner?: unknown; persistent?: unknown } | undefined {
	try {
		return JSON.parse(readFileSync(`${file}${POLICY}`, "utf8"));
	} catch {
		return undefined;
	}
}

export function restored(d: Restored) {
	// The runs already acted on (this module's `resumed`) or already asked to report (orphan.ts's `nudged`) are read back from the session.
	// `closing` is written before a pane is closed and `resumed` once the launcher has the request, so a run with the first and not the second was cut off in between.
	// `unclosed` takes `closing` back, for a run whose pane was found open: the close never took effect.
	// `seen` is the terminal a run's pane had while the child ran as pi-herdr-agents started it: Herdr gives a restored pane a new terminal, so a pane in another one is proof of a restore.
	// `continued` is written before the child is told, so a child is told at most once, whatever happens to the send.
	const done = new Set<string>(), closing = new Set<string>(), continued = new Set<string>(), terminals = new Map<string, string>();
	for (const e of d.entries()) {
		if (e.type !== "custom" || e.customType !== d.type) continue;
		const { resumed, nudged, gaveUp, inherited, closing: closed, unclosed, seen, terminal, continued: told } = (e.data ?? {}) as Record<string, unknown>;
		for (const key of [resumed, nudged, gaveUp, inherited]) if (typeof key === "string") done.add(key);
		if (typeof closed === "string") closing.add(closed);
		if (typeof told === "string") continued.add(told);
		if (typeof unclosed === "string") closing.delete(unclosed);
		if (typeof seen === "string" && typeof terminal === "string") terminals.set(seen, terminal);
	}
	const windows = (d.platform ?? process.platform) === "win32";
	// A run counts as a miss when no pane of Herdr is the restored one; after GIVE_UP misses it is left alone until the next session start (a reload counts).
	// A run whose `closing` was taken back (`reopened`) was meant to be closed, so giving up on it is said.
	const misses = new Map<string, number>(), reaches = new Map<string, number>(), launches = new Map<string, Launch | undefined>(), reopened = new Set<string>();
	let before = new Set<string>(), busy = false, stopped = false;
	const launchFor = (file: string, id: string) => {
		if (!launches.has(id)) launches.set(id, launchOf(file, id));
		return launches.get(id);
	};
	const miss = (id: string) => {
		const n = (misses.get(id) ?? 0) + 1;
		misses.set(id, n);
		if (n === GIVE_UP && reopened.has(id)) d.tell(`Straw Boss: the pane of a restored subagent run was meant to be closed, but the close did not take effect and the pane no longer qualifies, so it is left open and not resumed: ${launches.get(id)?.session ?? id}`, "warning");
	};

	/**
	 * What runs in the foreground of `pane`: a launch script (the child as pi-herdr-agents started it, or a run someone resumed), a pi on its own, or unknown.
	 * Plain needs proof: exactly one pi, and an argv for every other process, so that a process whose script cannot be seen is not taken for none.
	 * Windows lists no reliable argv for the bash that runs the script, so there nothing is plain.
	 */
	async function shape(pane: string): Promise<"script" | "plain" | "unknown"> {
		try {
			const info = JSON.parse(await d.run(["pane", "process-info", "--pane", pane])).result.process_info;
			const list = info.foreground_processes as { pid?: number; argv?: string[]; argv0?: string; name?: string }[];
			if (!Array.isArray(list) || list.length === 0) return "unknown";
			if (list.some((p) => p.argv?.some((arg) => SCRIPT.test(arg)))) return "script";
			if (windows) return "unknown";
			// macOS lists pi as argv0 "pi". Linux lists no argv0 and pi's process title makes its name "pi": one such process, or the foreground group's leader among several; anything else is unknown.
			const pis = list.filter((p) => p.argv0 === "pi" || (p.argv0 === undefined && p.name === "pi"));
			const lead = pis.length > 1 ? pis.filter((p) => typeof p.pid === "number" && p.pid === info.foreground_process_group_id) : pis;
			if (lead.length !== 1 || pis.some((p) => p.argv0 === "pi") && pis.length > 1 || list.some((p) => p !== lead[0] && !(Array.isArray(p.argv) && p.argv.length))) return "unknown";
			return "plain";
		} catch {
			return "unknown";
		}
	}

	/**
	 * Tells the restored pi of a worktree run, once, that its turn was cut: `sent`, `wait` (it cannot be reached yet: asked again at the next look, REACH looks at most), or `no` (`why` says).
	 * The broker's own status must say it is idle, and the transcript is read again just before: a child someone went on with is not told, and its `cut` is dropped.
	 */
	async function tellChild(c: Found): Promise<"sent" | "wait" | "no"> {
		const cut = c.cut;
		if (!cut) return "no";
		if (continued.has(c.id)) return "sent";
		// Its location has to be the current one: an unavailable one keeps the pane id of the registration, which another session may have by now.
		const to = d.launcher(), list = await d.sessions().catch(() => undefined), kid = list?.find((s) => s.herdrLocation?.status === "current" && s.herdrLocation.paneId === c.pane);
		if (kid?.status !== "idle" || !to) {
			const n = (reaches.get(c.id) ?? 0) + 1;
			reaches.set(c.id, n);
			if (n < REACH) return "wait";
			c.why = !to ? "this session has no intercom id to give it for its report" : kid ? `its intercom status is ${kid.status ?? "unknown"}` : list?.some((s) => s.herdrLocation?.paneId === c.pane) ? "its intercom session of the pane has no current Herdr location yet" : "no intercom session of its pane is listed";
			return "no";
		}
		const now = cutOf(c.session);
		if (now?.at !== cut.at) {
			c.cut = now;
			return "no";
		}
		if (stopped) return "wait";
		continued.add(c.id);
		d.remember({ continued: c.id });
		const result = await d.send(kid.id, continueText(cut, to));
		if (result.status === "sent") return "sent";
		c.why = `the send failed: ${[result.status, result.code, result.detail].filter(Boolean).join(" ")}`;
		return "no";
	}

	/** Records the terminal of the pane of each run whose child is seen running as pi-herdr-agents started it: the proof, later, that a pane in another terminal was restored. */
	async function observe(file: string, ids: string[], ps: Awaited<ReturnType<typeof panes>>): Promise<void> {
		for (const id of ids) {
			if (terminals.has(id)) continue;
			const launch = launchFor(file, id);
			const pane = launch && ps.find((p) => p.pane_id === launch.surface && p.agent === "pi" && ownFile(p.agent_session?.value, id));
			if (!pane?.terminal_id || await shape(pane.pane_id) !== "script") continue;
			terminals.set(id, pane.terminal_id);
			d.remember({ seen: id, terminal: pane.terminal_id });
		}
	}

	async function poll(): Promise<void> {
		if (busy || stopped) return;
		const file = d.file(), live = tracked(d.events);
		// A session that cannot say what it tracks cannot say what is lost; a tower and a session without a file have nothing to resume.
		// A subagent session (it has a policy sidecar) is no launcher of its own runs: a restored nested subagent must not act for them.
		if (!file || !live || !d.active() || existsSync(`${file}${POLICY}`)) return void (before = new Set());
		busy = true;
		try {
			let all: string[] = [];
			try {
				all = readdirSync(join(artifacts(file), "subagent-activity")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
			} catch {} // no subagent was ever launched from this session
			const open = all.filter((id) => !done.has(id) && (misses.get(id) ?? 0) < GIVE_UP);
			const reported = open.length ? d.entries().flatMap((e) => (e.type === "custom_message" && FINAL.includes(e.customType ?? "") ? [String((e.details as { sessionFile?: unknown } | undefined)?.sessionFile ?? "")] : [])) : [];
			const unfinished = open.filter((id) => !reported.some((f) => ownFile(f, id)));
			// The terminal of a running child's pane is noted while it runs as pi-herdr-agents started it; that is what a restored pane is told apart by.
			// A run that cannot be resumed (a persistent specialist, a script or session that is not the run's own) can never be noted, so it does not keep the pane list read.
			const unseen = unfinished.filter((id) => {
				const launch = terminals.has(id) ? undefined : launchFor(file, id);
				return launch && !existsSync(`${launch.session}.exit`);
			});
			let ps: Awaited<ReturnType<typeof panes>> | undefined;
			if (unseen.length) {
				ps = await panes(d.run);
				await observe(file, unseen, ps);
			}
			const candidates: (Launch & { id: string })[] = [];
			for (const id of unfinished.filter((id) => !live.has(id))) {
				const launch = launchFor(file, id);
				// A child that wrote its exit sidecar has finished: it is no stranded run, and its result is not ours to repeat.
				if (!launch || existsSync(`${launch.session}.exit`)) miss(id);
				else candidates.push({ id, ...launch });
			}
			if (!candidates.length) return void (before = new Set());
			if (!ps) ps = await panes(d.run);
			const found: Found[] = [], recovered: Found[] = [];
			for (const c of candidates) {
				// The restored pane keeps the pane id the launch script recorded; a run another session resumed, or a pi someone started on the file, sits in a pane of its own.
				const pane = ps.find((p) => p.pane_id === c.surface && p.agent === "pi" && ownFile(p.agent_session?.value, c.id));
				// Cut off between the close and the request (a reload, a quit): the pane is gone and the launcher was never asked.
				if (closing.has(c.id)) {
					if (!ps.some((p) => p.pane_id === c.surface || ownFile(p.agent_session?.value, c.id))) {
						recovered.push({ ...c, pane: c.surface });
						continue;
					}
					// The pane is still open: the process died before the close took effect, so nothing was closed. The run goes through the proof of a restore again.
					closing.delete(c.id);
					reopened.add(c.id);
					d.remember({ unclosed: c.id });
				}
				if (!pane) {
					miss(c.id);
					continue;
				}
				// Working or asking a question is not stranded; a pane someone has looked at is idle, not done.
				if (!["done", "idle"].includes(pane.agent_status ?? "")) continue;
				// Proof of a restore: the pane is in another terminal than the one the running child was seen in. Without it a pi someone started by hand in the same pane stays.
				const seen = terminals.get(c.id);
				if (!seen || !pane.terminal_id || pane.terminal_id === seen || await shape(pane.pane_id) !== "plain") {
					miss(c.id);
					continue;
				}
				const manifest = readJson(join(artifacts(file), "worktree-runs", `${c.id}.json`)), policy = policyOf(c.session);
				const worktree = Object.keys(manifest).length || (policy && policy.owner !== undefined && policy.owner !== "public");
				if (policy?.persistent === true) {
					miss(c.id);
					continue;
				}
				found.push({ ...c, pane: pane.pane_id, ...(worktree ? { worktree: { path: typeof manifest.path === "string" ? manifest.path : undefined, branch: typeof manifest.branch === "string" ? manifest.branch : undefined } } : {}) });
			}
			// Found so twice in a row, so that a pane still coming up after the restart is not taken for a restored one that stays.
			const ripe = found.filter((c) => before.has(c.id));
			before = new Set(found.map((c) => c.id));
			if (stopped) return;
			const resumable: Found[] = [...recovered], kept: Found[] = [];
			for (const c of recovered) {
				done.add(c.id);
				c.cut = cutOf(c.session);
			}
			for (const c of ripe) {
				if (stopped) break;
				c.cut = cutOf(c.session);
				// A managed worktree's pane is the root pane of the retained workspace: it stays, and subagent_resume is no way back for it. Its restored pi is told over intercom to go on.
				if (c.worktree && c.cut) {
					const told = await tellChild(c).catch((error) => (c.why = (error as Error).message, "no" as const));
					if (told === "wait") continue;
					c.told = told === "sent";
				}
				done.add(c.id);
				if (c.worktree) {
					kept.push(c);
					continue;
				}
				// Written down before the close: it cannot be undone, and a run cut off after it is found again by this record.
				d.remember({ closing: c.id });
				try {
					await d.run(["pane", "close", c.pane]);
					const gone = await waitFor(d.sleep, async () => !(await panes(d.run)).some((p) => p.pane_id === c.pane || p.agent_session?.value === c.session), CLOSE_MS, 250);
					if (!gone) throw new Error("the pane is still open");
					resumable.push(c);
				} catch (error) {
					d.remember({ gaveUp: c.id });
					d.tell(`Straw Boss: could not close the restored pane ${c.pane} of ${c.name}, so it was not resumed: ${(error as Error).message}`, "warning");
				}
			}
			// Read again after the waits: a run the host or the model resumed meanwhile, under any run id, is not asked for twice; an unreadable host proves nothing, so it waits for the next start.
			for (const c of [...resumable]) {
				const t = taken(file, c.session, d.entries(), d.events);
				if (t !== false) resumable.splice(resumable.indexOf(c), 1);
				if (t) d.remember({ resumed: c.id });
			}
			// A stopped session sends nothing: a closed pane's record says `closing`, and the next session start asks.
			if (stopped || (!resumable.length && !kept.length)) return;
			const runs = [...resumable.map((c) => ({ id: c.id, name: c.name, sessionPath: c.session, pane: c.pane, ...(c.autoExit === false ? { autoExit: false } : {}), ...(c.cut ? { cut: c.cut } : {}) })), ...kept.map((c) => ({ id: c.id, name: c.name, sessionPath: c.session, pane: c.pane, worktree: c.worktree, ...(c.cut ? { cut: c.cut, told: c.told === true } : {}) }))];
			try {
				d.resume(message(resumable, kept), { runs });
				for (const r of runs) d.remember({ resumed: r.id });
				d.tell(`Straw Boss: ${[resumable.length ? `closed the restored pane of ${resumable.map((c) => c.name).join(", ")} and asked this session to resume ${resumable.length === 1 ? "it" : "them"}` : "", kept.length ? `told this session that ${kept.map((c) => c.name).join(", ")} ${kept.length === 1 ? "is a worktree run that stays" : "are worktree runs that stay"} in ${kept.length === 1 ? "its" : "their"} restored pane` : ""].filter(Boolean).join("; ")}`);
			} catch (error) {
				for (const r of runs) d.remember({ gaveUp: r.id });
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
		parts.push(`Straw Boss closed the restored pane of each run below. Resume each one now with the subagent_resume tool, one call per run, with the sessionPath and name listed and this message: ${JSON.stringify(FOLLOW_UP)}${resumable.some((c) => c.cut) ? " (a run listed as restored mid-turn has a message of its own: pass that one instead)" : ""} Each resumed run reports to you as a normal subagent_result; do nothing else for them, and resume a run only once.`, ...resumable.map((c) => `- ${c.name} (run ${c.id}): sessionPath ${c.session}${c.autoExit === false ? ", autoExit false (it was launched with auto-exit off)" : ""}${c.cut ? `; restored mid-turn: ${describe(c.cut)}. Pass this message for it: ${JSON.stringify(continueText(c.cut))}` : ""}`));
	}
	if (kept.length) {
		// A run Straw Boss told to continue is working again and reports over intercom; only for the others is the launcher sent to the pane.
		const told = kept.filter((c) => c.told && c.cut).length;
		const next = told === kept.length ? "Straw Boss told each of them to continue, and each reports to you over intercom: wait for its report, or inspect the worktree with worktree_list." : `${told ? "Straw Boss told some of them to continue (marked below); wait for their report over intercom. For the others: " : ""}Continue it in that pane (tell the user), or inspect the worktree with worktree_list.`;
		parts.push(`These runs are managed-worktree runs. subagent_resume does not reattach a worktree run's lifecycle and refuses its session, so do not call it for them, and Straw Boss left their restored panes open: each is the retained workspace's pane. A restored pi is waiting there at its prompt with its session intact. ${next}`, ...kept.map((c) => `- ${c.name} (run ${c.id}): pane ${c.pane}, worktree ${c.worktree?.path ?? "unknown"}, branch ${c.worktree?.branch ?? "unknown"}${c.cut ? midTurn(c) : ""}`));
	}
	return parts.join("\n");
}

/** What the launcher hears of a worktree run whose session ends mid-turn: that it was cut, and whether Straw Boss told the child to continue. */
function midTurn(c: Found & { cut?: Cut }): string {
	const cut = c.cut!;
	return c.told
		? `; restored mid-turn: ${describe(cut)}. Straw Boss told it, once, to check the state and continue and to send its report to you over intercom, so it is not idle: do not re-run its work or that tool call yourself, and wait for its report over intercom.`
		: `; restored mid-turn: ${describe(cut)}. Straw Boss could not tell it to continue${c.why ? ` (${c.why})` : ""}: continue it in its pane, and tell it to check the current state before it re-runs anything that changes state.`;
}
