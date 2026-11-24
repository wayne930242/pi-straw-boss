import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { classify, type Death, deathOf } from "./childdead.ts";
import { cutOf, describe } from "./cut.ts";
import { CONFIRM_MS, LOOKS } from "./dead.ts";
import { type HerdrRun, type Pane, panes, result, type Session, type Sleep } from "./herdr.ts";
import { encoded, lastText, RESULT } from "./inherit.ts";
import { artifacts, readJson } from "./netdata.ts";
import { tracked } from "./orphan.ts";
import { DAY_MS, LOOP_MS, sessionHeader } from "./revive.ts";
import { line } from "./safetext.ts";

// A subagent whose own pi dies while its launcher lives is revived by the launcher's Straw Boss (docs/specs/2026-11-24-worker-revive.md). pi-herdr-agents delivers the death as a failed
// `subagent_result` and lets the run go; childdead.ts tells a death from any other ending. This look, on the launcher's 15 s timer, confirms it in two looks a minute apart, starts the run's own launch
// command again in a new pane of the launcher's tab with a revive notice as its first message, and then watches the revived pi in pi-herdr-agents' place: its `.exit` is delivered as inherit.ts
// delivers an inherited run's. Every step is an entry in the launcher's session (`{workerRevive}`), written before it acts, keyed by the failure's own entry: a death is acted on once, across a reload.

export const REVIVED = "straw-boss-child-revived";
const KEY = "workerRevive", RESULT_TYPE = "subagent_result", START_MS = 60_000, CLOSE_LOOKS = 8, HEAD = 1024 * 1024;
const TAIL = "; echo '__SUBAGENT_DONE_'$?'__'";
/** The run id in a subagent session file's name (`<time>_<run id>[-<suffix>].jsonl`, netdata.ts `ownFile`). */
const RUN = /_([^_]+?)(?:-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,4})?\.jsonl$/;
const FOLLOW = "Your pi died while you were working and was not revived. Read your session so far, check the current state before re-running anything that changes state, finish the task you were given, and report your result.";

export interface Entry { type: string; id?: string; timestamp?: string; customType?: string; data?: unknown; details?: unknown }
type Step = "reviving" | "revived" | "delivered" | "failed" | "skipped";
interface Mark { death: string; file: string; step: Step; at: number; name: string; pane?: string; why?: string }
interface Open { id: string; at: number; death: Death }
/** A run as its newest launch or resume script says: the folder and the command a revive runs again. */
export interface Launch { name: string; id?: string; folder: string; command: string; worktree?: { path?: string; branch?: string } }

export interface ChildRevive {
	run: HerdrRun;
	sleep: Sleep;
	now(): number;
	/** The launcher's session file, and every entry of its transcript. */
	file(): string | undefined;
	entries(): Entry[];
	/** The launcher's own pane, beside which a revived run opens. */
	pane(): string | undefined;
	sessions(): Promise<Session[]>;
	/** A tower launches no subagents and revives none. */
	active(): boolean;
	type: string;
	remember(data: Record<string, unknown>): void;
	/** Hands the launcher's model a message; `wake` starts a turn. Throws when the session cannot take it. */
	deliver(customType: string, text: string, details: Record<string, unknown>, wake: boolean): void;
	tell(text: string, level?: "info" | "warning"): void;
	note?(text: string): void;
	/** How long the revived pi has to show in its pane (60 s). */
	startMs?: number;
}

const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const unq = (value: string) => value.replace(/'\\''/g, "'");
const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").slice(0, 48) || "subagent";
const said = (name: string) => JSON.stringify(line(name).slice(0, 60));

/** The newest launch or resume script of `launcher` whose header names `file`, read for a revive; a string is why it cannot be. */
export function launchOf(launcher: string, file: string): Launch | string {
	// Only the run's own first launch and the resumes can name its file: a launcher with a thousand scripts reads a few headers, not every script.
	const dir = join(artifacts(launcher), "subagent-scripts"), run = RUN.exec(basename(file))?.[1];
	let found: { path: string; at: number } | undefined;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".sh") || (run && !name.endsWith(`-${run}.sh`) && !name.includes("-resume-"))) continue;
			const top = head(join(dir, name), 4096);
			if (/^# Session: (.+)$/m.exec(top)?.[1]?.trim() !== file) continue;
			const at = Date.parse(/^# Generated: (.+)$/m.exec(top)?.[1] ?? "") || 0;
			if (!found || at >= found.at) found = { path: join(dir, name), at };
		}
	} catch { /* no script folder */ }
	if (!found) return "no launch script of this session names its session file";
	let text: string;
	try { text = readFileSync(found.path, "utf8"); } catch { return "its launch script cannot be read"; }
	const name = /^# Subagent (?:launch|resume) script for (.+)$/m.exec(text)?.[1]?.trim() ?? "subagent";
	if (/\bPI_SUBAGENT_PERSISTENT=1\b/.test(text)) return "it is a persistent specialist, which pi-herdr-agents cannot take back: launch a new one";
	const command = text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).at(-1) ?? "";
	// maestro's own shape (buildPiCommand, launch-resume): anything else would be edited on a guess.
	if (!command.endsWith(TAIL) || !/(?:^|\s)pi --session /.test(command)) return "its launch command is not one Straw Boss knows how to start again";
	const cd = /^cd '((?:[^']|'\\'')*)' && /.exec(command), folder = cd ? unq(cd[1]!) : sessionHeader(file)?.cwd;
	if (!folder || !isDir(folder)) return `its folder ${folder ?? "(none)"} is gone`;
	const policy = readJson(`${file}.pi-herdr-subagent-policy.json`) as { worktree?: { path?: unknown; branch?: unknown } };
	const worktree = policy.worktree && typeof policy.worktree === "object" ? { ...(typeof policy.worktree.path === "string" ? { path: policy.worktree.path } : {}), ...(typeof policy.worktree.branch === "string" ? { branch: policy.worktree.branch } : {}) } : undefined;
	const id = /\bPI_SUBAGENT_ID='([^']*)'/.exec(command)?.[1];
	return { name, folder, command: cd ? command : `cd ${q(folder)} && ${command}`, ...(id ? { id } : {}), ...(worktree ? { worktree } : {}) };
}

/** The launch command with the revive notice as its first message instead of the task, and the pane it runs in. */
export function reviveCommand(launch: Launch, notice: string, pane: string): string {
	let body = launch.command.slice(0, -TAIL.length);
	const last = / '((?:[^']|'\\'')*)'$/.exec(body), arg = q(`@${notice}`);
	body = last && last[1]!.startsWith("@") ? `${body.slice(0, last.index)} ${arg}` : `${body} ${arg}`;
	return body.replace(/\bPI_SUBAGENT_SURFACE='(?:[^']|'\\'')*'/, `PI_SUBAGENT_SURFACE=${q(pane)}`) + TAIL;
}

/** The first `bytes` of a file, or nothing when it cannot be read. */
function head(file: string, bytes: number): string {
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(bytes), n = readSync(fd, buffer, 0, bytes, 0);
			return buffer.subarray(0, n).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
/** Whether pi wrote any message into the session: one that never started failed to launch, and would fail again. */
const started = (file: string) => head(file, HEAD).includes('"type":"message"');

const worktreeWords = (l: Launch) => (l.worktree ? ` It is a managed worktree run (worktree ${l.worktree.path ?? "unknown"}, branch ${l.worktree.branch ?? "unknown"}), which subagent_resume refuses: launch a new run there instead.` : "");
const resumeWords = (name: string, file: string, l?: Launch) => (l?.worktree ? worktreeWords(l) : ` Resume it with subagent_resume {sessionPath: ${JSON.stringify(file)}, name: ${said(name)}, message: ${JSON.stringify(FOLLOW)}}, or launch a new run.`);
/** The paragraph a death's failure gets before the launcher's model reads it. */
export const noteText = (death: Death) =>
	`Straw Boss: this is no report of ${said(death.name)}'s own: ${death.why}. Straw Boss revives it from its session file in about a minute, once a second look shows nothing else runs it, in a new pane of your tab, and brings its report here. Do not resume, respawn, or cancel it meanwhile, and launch no replacement; go on with other work. If it cannot be revived, Straw Boss says so here.`;

type Looks = Map<string, { first: number; looks: number }>;
const counted = (looks: Looks, key: string, now: number) => looks.get(key) ?? { first: now, looks: 0 };
const count = (looks: Looks, key: string, now: number) => void looks.set(key, ((was) => ({ first: was.first, looks: was.looks + 1 }))(counted(looks, key, now)));
/** What Herdr, the broker, and the disk say of a session file now: the facts childdead.ts `classify` weighs. */
function factsOf(file: string, ps: Pane[], list: Session[] | undefined) {
	const id = sessionHeader(file)?.id, holder = ps.find((p) => p.agent_session?.value === file);
	let mtimeMs: number | undefined;
	try { mtimeMs = statSync(file).mtimeMs; } catch { /* gone */ }
	return { holder, held: Boolean(holder), listed: Boolean(id && list?.some((s) => s.id === id)), ...(mtimeMs !== undefined ? { mtimeMs } : {}) };
}

export function childRevive(d: ChildRevive) {
	// The looks that found a death dead (`seen`), held by someone else (`taken`), and a revived pi gone (`gone`); a reload starts them again.
	const seen: Looks = new Map(), taken: Looks = new Map(), gone: Looks = new Map();
	const closing = new Map<string, { pane: string; looks: number }>();
	let busy = false, stopped = false;

	/** The last mark of each death, as the session's entries say. */
	const marksOf = (): Map<string, Mark> => {
		const out = new Map<string, Mark>();
		for (const e of d.entries()) {
			const m = e.type === "custom" && e.customType === d.type ? (e.data as Record<string, unknown> | undefined)?.[KEY] as Mark | undefined : undefined;
			if (m && typeof m.death === "string" && typeof m.file === "string") out.set(m.death, m);
		}
		return out;
	};
	/** The deaths the transcript holds: failures that childdead.ts reads as a pi that ended without a report. */
	const deaths = (): Open[] => d.entries().flatMap((e) => {
		const death = e.type === "custom_message" && e.customType === RESULT_TYPE && e.id ? deathOf(e.details) : undefined;
		return death ? [{ id: e.id!, at: Date.parse(e.timestamp ?? "") || d.now(), death }] : [];
	});
	/** Why a death may not be revived, from the files and the marks alone; undefined when it may. */
	const refusal = (death: Death, at: number, marks: Map<string, Mark>, launch: Launch | string): string | undefined => {
		if (typeof launch === "string") return launch;
		if (!started(death.file)) return "its session never started: that is a launch failure, which a revive would repeat";
		const mine = [...marks.values()].filter((m) => m.file === death.file);
		if (mine.some((m) => m.step === "failed" && at - m.at < DAY_MS)) return "a revive of it failed in the last 24 hours";
		if (mine.some((m) => (m.step === "revived" || m.step === "delivered") && at - m.at < LOOP_MS)) return "it died again within 10 minutes of a revive";
		return undefined;
	};
	const mark = (m: Mark) => d.remember({ [KEY]: m });
	const send = (customType: string, text: string, details: Record<string, unknown>, wake: boolean) => {
		try {
			d.deliver(customType, text, details, wake);
		} catch (error) {
			d.tell(`Straw Boss: could not tell this session: ${(error as Error).message}`, "warning");
		}
	};

	async function revive(o: Open, launcher: string, launch: Launch): Promise<void> {
		const { death } = o, base = { death: o.id, file: death.file, name: launch.name };
		mark({ ...base, step: "reviving", at: d.now() });
		let pane: string | undefined;
		const close = async () => void (pane && (await d.run(["pane", "close", pane]).catch(() => {})));
		const fail = async (why: string) => {
			await close();
			mark({ ...base, step: "failed", at: d.now(), why });
			send(REVIVED, `Straw Boss: could not revive subagent ${said(launch.name)} (sessionPath ${death.file}), whose pi died (${death.why}): ${why}. Straw Boss does not try again.${resumeWords(launch.name, death.file, launch)}`, { name: launch.name, sessionFile: death.file }, true);
			d.tell(`Straw Boss: could not revive subagent ${launch.name}: ${why}`, "warning");
		};
		const holder = async () => {
			const p = (await panes(d.run)).find((x) => x.agent_session?.value === death.file && x.pane_id !== pane);
			const id = sessionHeader(death.file)?.id;
			return p ? `pane ${p.pane_id} runs its session now` : id && (await d.sessions().catch(() => [])).some((s) => s.id === id) ? "the broker lists its session now" : undefined;
		};
		try {
			const lead = d.pane();
			if (!lead || !(await panes(d.run)).some((p) => p.pane_id === lead)) return await fail("Herdr does not list this session's own pane, so there is no tab to open it in");
			pane = (await result(d.run, ["pane", "split", lead, "--direction", "right", "--cwd", launch.folder, "--no-focus"])).pane.pane_id as string;
			await d.run(["pane", "rename", pane, launch.name]).catch(() => {});
			// Once more, just before pi starts: two pis on one session file corrupt it.
			const other = await holder();
			if (other) {
				await close();
				mark({ ...base, step: "skipped", at: d.now(), why: other });
				return send(REVIVED, `Straw Boss: did not revive subagent ${said(launch.name)} (sessionPath ${death.file}): ${other}. Its result goes to whoever runs it.`, { name: launch.name, sessionFile: death.file }, false);
			}
			const dir = join(artifacts(launcher), "straw-boss-revive"), stamp = new Date(d.now()).toISOString().replace(/[:.]/g, "-");
			mkdirSync(dir, { recursive: true });
			const notice = join(dir, `${safeName(launch.name)}-${stamp}.md`), script = join(dir, `${safeName(launch.name)}-${launch.id ?? "run"}-${stamp}.sh`);
			const cut = cutOf(death.file);
			writeFileSync(notice, `Straw Boss: your pi died (${death.why}) while you were working on the task your launcher gave you, and Straw Boss revived you from your session file, in a new pane, with the same model and folder. Your launcher waits for your report.${cut ? ` Your last turn was cut: ${describe(cut)} (your last recorded step was at ${cut.at}).` : ""} Read your session so far, check the current state before re-running anything that changes state (a command may have run halfway), then finish the task you were given and report your result.`);
			writeFileSync(script, `#!/bin/bash\n# Straw Boss revive script for ${launch.name}\n# Generated: ${new Date(d.now()).toISOString()}\n# Session: ${death.file}\n# Surface: ${pane}\n${reviveCommand(launch, notice, pane)}\n`, { mode: 0o755 });
			await d.run(["pane", "run", pane, `bash ${q(script)}`]);
			const limit = d.now() + (d.startMs ?? START_MS);
			let up = false;
			while (!up && !stopped && d.now() <= limit) {
				up = (await panes(d.run).catch(() => [] as Pane[])).some((p) => p.pane_id === pane && p.agent_session?.value === death.file);
				if (!up) await d.sleep(1000);
			}
			if (stopped && !up) return; // the next start reads the `reviving` step
			if (!up) return await fail(`pi did not start on its session in pane ${pane} within ${Math.round((d.startMs ?? START_MS) / 1000)} s`);
		} catch (error) {
			return await fail((error as Error).message.slice(0, 300));
		}
		// From here the run is back: what tells of it may fail, and never undoes it (a live check closed a revived pane over a notice that threw).
		mark({ ...base, step: "revived", at: d.now(), pane });
		const where = launch.worktree ? `, in its worktree ${launch.worktree.path ?? launch.folder}${launch.worktree.branch ? ` (branch ${launch.worktree.branch})` : ""}` : "";
		send(REVIVED, `Straw Boss: subagent ${said(launch.name)} died (${death.why}) and was revived from its session file in pane ${pane} of this tab, with its own model, folder${where}, and tools. It goes on with its task, and its report comes here when it ends. Do not resume or respawn it.`, { name: launch.name, sessionFile: death.file, pane }, false);
		for (const tell of [() => d.tell(`Straw Boss: revived subagent ${launch.name} in pane ${pane} after its pi died (${death.why})`), () => d.note?.(`subagent ${line(launch.name).slice(0, 60)} died (${death.why}) and was revived in pane ${pane}`)]) try { tell(); } catch { /* a notice only */ }
	}

	/** A revived run: its `.exit` delivered, or its second death told. */
	function watch(m: Mark, ps: Pane[], list: Session[] | undefined, now: number): void {
		const exit = `${m.file}.exit`;
		if (existsSync(exit)) {
			const x = readJson(exit) as { type?: unknown; message?: unknown; errorMessage?: unknown };
			const type = x.type === "ping" || x.type === "error" ? x.type : "done";
			mark({ ...m, step: "delivered", at: now });
			const launch = launchOf(d.file() ?? "", m.file);
			const head = `Straw Boss: subagent ${said(m.name)}, which Straw Boss revived after its pi died, `;
			const text = type === "ping"
				? `${head}asked for help (sessionPath ${m.file}). pi-herdr-agents no longer watches it, so Straw Boss brings this. Its question:\n${encoded(m.name, typeof x.message === "string" ? x.message : "")}\n${typeof launch !== "string" && launch.worktree ? worktreeWords(launch).trim() : `Answer it with subagent_resume {sessionPath: ${JSON.stringify(m.file)}, name: ${said(m.name)}, message: <your answer>}.`}`
				: `${head}finished${type === "error" ? " with an error" : ""} (sessionPath ${m.file}). pi-herdr-agents no longer watches it, so Straw Boss brings its result.${type === "error" && typeof x.errorMessage === "string" ? ` Its error: ${line(x.errorMessage).slice(0, 400)}.` : ""} Its last message, which is its report:\n${encoded(m.name, lastText(m.file))}`;
			send(RESULT, text, { name: m.name, sessionFile: m.file, kind: type === "ping" ? "ping" : "finished", revived: true }, true);
			rmSync(exit, { force: true }); // pi-herdr-agents' watcher consumes it too
			if (m.pane) closing.set(m.file, { pane: m.pane, looks: 0 });
			return void gone.delete(m.death);
		}
		const verdict = classify({ now, ...factsOf(m.file, ps, list), seen: counted(gone, m.death, now) });
		if (verdict.state === "live") return void gone.delete(m.death);
		if (verdict.state === "confirming") return count(gone, m.death, now);
		gone.delete(m.death);
		mark({ ...m, step: "failed", at: now, why: "it ended again without a report" });
		const launch = launchOf(d.file() ?? "", m.file);
		send(REVIVED, `Straw Boss: subagent ${said(m.name)}, which Straw Boss revived after its pi died, ended again without a report: its pi is gone and left no .exit. Straw Boss revives a run once and does not try again. Its last message:\n${encoded(m.name, lastText(m.file))}\n${resumeWords(m.name, m.file, typeof launch === "string" ? undefined : launch).trim()}`, { name: m.name, sessionFile: m.file }, true);
		d.tell(`Straw Boss: subagent ${m.name} ended again after its revive, without a report`, "warning");
		if (m.pane) closing.set(m.file, { pane: m.pane, looks: 0 });
	}

	async function poll(): Promise<void> {
		const launcher = d.file();
		if (busy || stopped || !launcher || !d.active()) return;
		busy = true;
		try {
			const marks = marksOf(), now = d.now();
			const open = deaths().filter((o) => !marks.has(o.id));
			// A revive a reload cut off: back when a pane runs the file, given up when none does.
			const cutOff = [...marks.values()].filter((m) => m.step === "reviving");
			const revived = [...marks.values()].filter((m) => m.step === "revived");
			if (!open.length && !cutOff.length && !revived.length && !closing.size) return;
			const ps = await panes(d.run);
			const list = open.length || revived.length ? await d.sessions().catch(() => undefined) : undefined;
			for (const [file, c] of closing) {
				const p = ps.find((x) => x.pane_id === c.pane);
				if (!p || ++c.looks > CLOSE_LOOKS) closing.delete(file);
				else if (!p.agent) (closing.delete(file), await d.run(["pane", "close", c.pane]).catch(() => {}));
			}
			for (const m of cutOff) {
				const p = ps.find((x) => x.agent_session?.value === m.file);
				if (p) mark({ ...m, step: "revived", at: now, pane: p.pane_id });
				else {
					mark({ ...m, step: "failed", at: now, why: "the revive was cut off before its pi started" });
					send(REVIVED, `Straw Boss: the revive of subagent ${said(m.name)} (sessionPath ${m.file}) was cut off before its pi started (this session reloaded). Straw Boss does not try again.${resumeWords(m.name, m.file)}`, { name: m.name, sessionFile: m.file }, true);
				}
			}
			for (const m of revived) watch(m, ps, list, now);
			const live = tracked();
			for (const o of open) {
				if (stopped) return;
				const launch = launchOf(launcher, o.death.file), facts = factsOf(o.death.file, ps, list);
				const why = refusal(o.death, o.at, marks, launch) ?? (facts.mtimeMs === undefined ? "its session file is gone" : undefined);
				// pi-herdr-agents tracking the run's id again (a resume of its own) holds it as a pane does.
				const owned = typeof launch !== "string" && launch.id !== undefined && live?.has(launch.id) === true;
				const verdict = classify({ now, ...facts, ...(why ? { refusal: why } : {}), held: facts.held || owned, seen: counted(seen, o.id, now) });
				if (verdict.state === "refused") {
					seen.delete(o.id);
					mark({ death: o.id, file: o.death.file, name: o.death.name, step: "skipped", at: now, why: verdict.reason });
					d.tell(`Straw Boss: does not revive subagent ${o.death.name}: ${verdict.reason}`);
					continue;
				}
				if (verdict.state === "live") {
					seen.delete(o.id);
					// Held by a pane or listed by the broker in two looks a minute apart: someone runs it again (the launcher's own resume, a restore, the boss).
					if (!facts.held && !facts.listed && !owned) continue;
					const t = counted(taken, o.id, now);
					if (t.looks < LOOKS - 1 || now - t.first < CONFIRM_MS) {
						count(taken, o.id, now);
						continue;
					}
					taken.delete(o.id);
					mark({ death: o.id, file: o.death.file, name: o.death.name, step: "skipped", at: now, why: verdict.reason });
					send(REVIVED, `Straw Boss: did not revive subagent ${said(o.death.name)} (sessionPath ${o.death.file}): ${facts.holder ? `pane ${facts.holder.pane_id} runs its session again` : verdict.reason}. Its result goes to whoever runs it.`, { name: o.death.name, sessionFile: o.death.file }, false);
					continue;
				}
				taken.delete(o.id);
				if (verdict.state === "confirming") {
					count(seen, o.id, now);
					continue;
				}
				seen.delete(o.id);
				await revive(o, launcher, launch as Launch);
			}
		} catch { /* a Herdr that cannot answer is asked again at the next look */ } finally {
			busy = false;
		}
	}

	/** The failure of a death, with the paragraph that tells the launcher's model Straw Boss revives it (pi's `message_end`); undefined leaves the message as it is. */
	function annotate<M extends { role?: string; customType?: string; content?: unknown; details?: unknown }>(message: M): M | undefined {
		const launcher = d.file();
		if (!launcher || !d.active() || message.role !== "custom" || message.customType !== RESULT_TYPE) return undefined;
		const death = deathOf(message.details);
		if (!death || refusal(death, d.now(), marksOf(), launchOf(launcher, death.file))) return undefined;
		const note = noteText(death);
		const content = typeof message.content === "string" ? `${message.content}\n\n${note}` : Array.isArray(message.content) ? [...message.content, { type: "text", text: note }] : note;
		return { ...message, content };
	}

	return { poll, annotate, stop: () => void (stopped = true) };
}
