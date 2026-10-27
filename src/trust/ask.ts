import { randomUUID } from "node:crypto";
import { lstatSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { herdrSocket } from "../endpoint.ts";
import { answersLive, readRecord } from "../handover.ts";
import { startedLater, startOf } from "../startof.ts";
import type { Kit } from "../state.ts";
import { answerFile, answerOf, ensureDir, MAX_FILE, readJson, remove, requestFile, resultFile, sweep, trustDir, writeAtomic } from "./files.ts";
import { canonical, digestOf, foundIn } from "./found.ts";
import type { TrustChoice, TrustRequest, TrustResult } from "./types.ts";

// pi's own question "Trust project folder?" is drawn only in the pane's terminal, before this extension has joined any net. The `project_trust` handler asks the running GUI
// as well, through files in <state>/trust/ (docs/specs/2026-10-26-project-trust.md), and the first answer wins: a key in the terminal hands over to pi's prompt (which cannot be
// dismissed once drawn, so it is not drawn while the GUI asks), and an answer from the GUI is returned to pi as the decision. Whatever cannot be asked leaves pi's order untouched:
// the handler answers `undecided` and pi goes on as without it (a saved decision, `defaultProjectTrust`, then its own prompt).

export type Decision = { trusted: "yes" | "no" | "undecided"; remember?: boolean };
const UNDECIDED: Decision = { trusted: "undecided" };
const GONE_MS = 15_000, UP_EVERY_MS = 2000, POLL_MS = 500;
const STARTED = Symbol.for("pi-straw-boss.started");
const MAP: Record<TrustChoice, { decision: Decision; said: string }> = {
	trust: { decision: { trusted: "yes", remember: true }, said: "trusted, remembered" },
	once: { decision: { trusted: "yes" }, said: "trusted for this session" },
	no: { decision: { trusted: "no" }, said: "not trusted for this session" },
};
/** A path or name as it is printed to a terminal: control characters would be escape sequences. */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");

export interface Stdin { isTTY?: boolean; isRaw?: boolean; setRawMode?(on: boolean): void; resume(): void; pause(): void; on(event: "data", cb: () => void): void; off(event: "data", cb: () => void): void }
export interface Proc { on(event: string, cb: () => void): void; off(event: string, cb: () => void): void; listenerCount(event: string): number; kill(pid: number, signal: string): void; pid: number }
export interface AskDeps {
	env: NodeJS.ProcessEnv;
	/** <state>/trust */
	dir: string;
	stdin: Stdin;
	proc: Proc;
	write(text: string): void;
	/** The saved decision for the folder or a parent (null when none); throws for a broken trust.json. */
	saved(cwd: string): boolean | null;
	defaultTrust(cwd: string): string;
	/** Whether a GUI that reads trust requests runs for this Herdr and answers (condition 5). */
	up(): Promise<boolean>;
	first(): boolean;
	now(): number;
	sleep(ms: number): Promise<void>;
	watch(dir: string, wake: () => void): () => void;
	startOf(pid: number): string | undefined;
	uuid(): string;
}

/** The handler, as a function of the folder and pi's context. */
export function createAsk(d: AskDeps) {
	const relays = async (cwd: string, ctx: { mode: string; hasUI: boolean }) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || !d.stdin.isTTY || typeof d.stdin.setRawMode !== "function") return false;
		if (!d.first()) return false; // a replacement runtime (/new, /resume into another folder) is pi's own prompt (D10)
		try {
			if (d.saved(cwd) !== null) return false; // a saved decision: pi decides it
		} catch {
			return false; // a broken trust.json: pi reports it itself
		}
		return d.defaultTrust(cwd) === "ask" && d.up();
	};
	return async function decide(cwd: string, ctx: { mode: string; hasUI: boolean }): Promise<Decision> {
		try {
			if (!(await relays(cwd, ctx)) || !ensureDir(d.dir)) return UNDECIDED;
			return await ask(cwd);
		} catch {
			return UNDECIDED; // whatever fails here, pi asks as it would have
		}
	};

	async function ask(from: string): Promise<Decision> {
		sweep(d.dir, d.now());
		const cwd = canonical(from), id = d.uuid(), started = d.startOf(d.proc.pid);
		const role = d.env.PI_SUBAGENT_ID ? "subagent" : ["member", "main", "tower"].find((r) => r === d.env.STRAW_BOSS_ROLE) ?? "none";
		const head = { version: 1, id, pid: d.proc.pid, ...(started && { started }), herdr: herdrSocket(d.env), pane: d.env.HERDR_PANE_ID!, role, cwd, at: d.now() } as const;
		// What is found is capped against the whole request, so the file stays within what a reader accepts.
		const read = (): TrustRequest => { const found = foundIn(cwd, undefined, { from, max: MAX_FILE - Buffer.byteLength(JSON.stringify({ ...head, found: [], digest: "0".repeat(64) })) - 64 }); return { ...head, found, digest: digestOf(cwd, found) }; };
		let request = read();
		const gone = () => remove(d.dir, requestFile(id), answerFile(id));
		const result = (by: TrustResult["by"], answerId?: string) => writeAtomic(d.dir, resultFile(id), { version: 1, id, by, ...(answerId && { answerId }), at: d.now() });
		const missing = () => { try { return !lstatSync(join(d.dir, requestFile(id))).isFile(); } catch { return true; } };
		writeAtomic(d.dir, requestFile(id), request);
		const { stdin } = d, wasRaw = stdin.isRaw ?? false;
		let keyed = false, wake = () => {};
		const onKey = () => ((keyed = true), wake());
		const signal = (name: string) => () => {
			gone();
			d.proc.off(name, onSignal[name]!);
			if (!d.proc.listenerCount(name)) d.proc.kill(d.proc.pid, name); // nothing else handles it: end as it would have
		};
		const onSignal: Record<string, () => void> = { SIGINT: signal("SIGINT"), SIGTERM: signal("SIGTERM") }, onExit = gone;
		d.proc.on("exit", onExit);
		for (const [name, cb] of Object.entries(onSignal)) d.proc.on(name, cb);
		const unwatch = d.watch(d.dir, () => wake());
		d.write(`Trust project folder? ${plain(cwd)}\nThe question is in the Straw Boss window.\nPress any key to answer here instead.\n`);
		stdin.setRawMode!(true);
		stdin.resume();
		stdin.on("data", onKey);
		const leave = () => {
			stdin.off("data", onKey);
			stdin.setRawMode!(wasRaw);
			stdin.pause();
			unwatch();
			d.proc.off("exit", onExit);
			for (const [name, cb] of Object.entries(onSignal)) d.proc.off(name, cb);
		};
		let lastUp = d.now(), nextUp = lastUp + UP_EVERY_MS;
		try {
			for (;;) {
				await Promise.race([d.sleep(POLL_MS), new Promise<void>((r) => (wake = r))]);
				const file = keyed ? undefined : readJson(join(d.dir, answerFile(id))), answer = file && answerOf(file.value, request); // a key that came first wins, whatever is on disk
				if (keyed) return (leave(), result("terminal"), gone(), UNDECIDED);
				if (answer) {
					const now = read(); // the folder may have changed since the question was shown: an answer is for what was shown
					if (now.digest !== request.digest) {
						request = now;
						remove(d.dir, answerFile(id));
						result("changed", answer.answerId);
						writeAtomic(d.dir, requestFile(id), request);
						continue;
					}
					leave();
					d.write(`Answered in the Straw Boss window: ${MAP[answer.choice].said}.\n`);
					result("remote", answer.answerId);
					gone();
					return MAP[answer.choice].decision;
				}
				if (missing()) { // swept or removed by a signal path that did not end this pi: nobody can answer it any more
					leave();
					d.write("The question was withdrawn; answer here.\n");
					result("gone");
					return UNDECIDED;
				}
				if (d.now() >= nextUp) {
					nextUp = d.now() + UP_EVERY_MS;
					if (await d.up()) lastUp = d.now();
				}
				if (!keyed && d.now() - lastUp >= GONE_MS) {
					leave();
					d.write("The Straw Boss window is not running; answer here.\n");
					result("gone");
					gone();
					return UNDECIDED;
				}
			}
		} catch (error) {
			leave();
			gone();
			throw error;
		}
	}
}

/** Registers the handler (before the subagent return, so every pi in Herdr has it) and marks the process's first session start. */
export function registerTrust(pi: ExtensionAPI, { cfg, guiDir }: Pick<Kit, "cfg" | "guiDir">) {
	const { env } = cfg;
	void startedLater(readRecord(guiDir)?.pid ?? 0, { hold: false }).catch(() => undefined); // the server's start time is read now, so it is under way at pi's trust question (RC3-F001)
	// SAFETY: the process-wide flag is a boolean under a registered symbol that only this module sets.
	const state = globalThis as unknown as Record<symbol, boolean>;
	const decide = createAsk({
		env, dir: trustDir(guiDir), stdin: process.stdin, proc: process, write: (text) => void process.stderr.write(text),
		saved: (cwd) => new ProjectTrustStore(getAgentDir()).get(cwd),
		defaultTrust: (cwd) => SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getDefaultProjectTrust(),
		up: async () => {
			const record = readRecord(guiDir);
			return Boolean(record && !record.stopped && record.trust === 1 && record.herdr === herdrSocket(env) && (await answersLive(record)));
		},
		first: () => !state[STARTED], now: cfg.now, sleep: cfg.sleep, startOf, uuid: randomUUID,
		watch: (dir, wake) => {
			try {
				const w = fsWatch(dir, wake);
				w.on("error", () => {});
				return () => w.close();
			} catch {
				return () => {}; // the stat every 500 ms still sees an answer
			}
		},
	});
	pi.on("project_trust", (event, ctx) => decide(event.cwd, ctx));
	pi.on("session_start", () => void (state[STARTED] = true));
}
