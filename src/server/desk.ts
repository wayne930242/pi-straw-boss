import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type HerdrRun, report, result, TOWER_LABEL } from "../herdr.ts";
import type { Ctx } from "./client.ts";
import { fileOf, readOwnedText, writeJson } from "./record.ts";

// The desk steps of `cli.mjs up --dir <folder> --label <name>` (docs/specs/2026-10-26-desk-mode.md S5 and S6, as docs/specs/2026-10-26-sb-backend.md, Desk mode: what changes, has them):
// Herdr's pi integration, the shell's home base (`desk.json`), and the lock that keeps two runs from making two bases. The tower itself is the server's (`ensure-tower`): this file starts no pi.

export interface DeskRecord { workspace: string; dir: string; label: string }

// --- Herdr's pi integration ---

/** The state word of the `pi:` line of `herdr integration status` (`current (v9)`, `outdated (legacy < v9)`, `not installed`), before any parenthesis; undefined when the output has no such line. */
export function integrationState(output: string): string | undefined {
	const line = output.split(/\r?\n/).find((l) => l.startsWith("pi:"));
	return line ? line.slice(3).replace(/\s*\(.*$/, "").trim() || undefined : undefined;
}

/**
 * Makes sure Herdr's pi integration is in place for the agent directory (S6). In desk mode that directory is the shell's own, so writing to its `extensions/` touches nothing of the user's.
 * Herdr's install does nothing, and exits 0, when `extensions/` is not there (a fresh agent directory), so the folder is made first and the line is read again after the install.
 */
export async function ensureIntegration(run: HerdrRun, env: NodeJS.ProcessEnv): Promise<"current" | "installed"> {
	const status = async () => {
		const state = integrationState(await run(["integration", "status"], 10_000));
		if (state === undefined) throw new Error("`herdr integration status` has no pi line");
		return state;
	};
	if ((await status()) === "current") return "current";
	mkdirSync(join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "extensions"), { recursive: true });
	await run(["integration", "install", "pi"], 30_000);
	const after = await status();
	if (after !== "current") throw new Error(`Herdr's pi integration is still ${after} after \`herdr integration install pi\``);
	return "installed";
}

// --- the home base ---

/** `desk.json`: the home base, or `unreadable` when the file is there but is no record of this shape (it is made again, with a warning), or nothing. */
export function readDesk(slot: Ctx["slot"]): DeskRecord | "unreadable" | undefined {
	const text = readOwnedText(fileOf(slot, "desk"));
	if (text === undefined) return undefined;
	try {
		const v = JSON.parse(text) as Partial<DeskRecord> | null;
		return v && typeof v.workspace === "string" && typeof v.dir === "string" && typeof v.label === "string" ? { workspace: v.workspace, dir: v.dir, label: v.label } : "unreadable";
	} catch {
		return "unreadable";
	}
}

export const DESK_LOCK_MS = 10 * 60_000;
/**
 * `desk.lock`, created new (`wx`) with the run's pid and time. Another run's lock stands unless its process is gone or it is older than ten minutes. Returns the release (which removes
 * the file only while it is still this run's), or undefined when another run holds it.
 */
export function deskLockFor(ctx: Pick<Ctx, "slot" | "now" | "alive">): (() => void) | undefined {
	const file = fileOf(ctx.slot, "deskLock"), body = JSON.stringify({ pid: process.pid, at: ctx.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, body, { flag: "wx", mode: 0o600 });
			return () => { if (readOwnedText(file) === body) rmSync(file, { force: true }); };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const held = ((text) => { try { return text === undefined ? undefined : (JSON.parse(text) as { pid?: unknown; at?: unknown }); } catch { return undefined; } })(readOwnedText(file));
			const live = typeof held?.pid === "number" && typeof held.at === "number" && ctx.now() - held.at <= DESK_LOCK_MS && ctx.alive(held.pid);
			if (live) return undefined;
			rmSync(file, { force: true });
		}
	}
	return undefined;
}

/** The base's folder as the run gives it, absolute; a folder that is not there is the caller's to make (the notes for the shell say where to put it). */
export function baseFolder(dir: string): string {
	const path = resolve(dir);
	let isDir = false;
	try {
		isDir = statSync(path).isDirectory();
	} catch {} // absent or unreadable: not a folder
	if (!isDir) throw new Error(`${path} is not a folder; make it first (a visible one under the home folder, as the notes for the shell say)`);
	return path;
}

/**
 * Makes the home base: a workspace in `dir` with `label`, its first tab labelled as a tower tab and its root pane marked `sb_role=tower`, so the base has no stray shell tab and the
 * server's `ensure-tower` takes that pane as the standing pane. The shell gets no Straw Boss environment (a Herdr restore would drop it anyway). It is recorded by rename only once it is
 * marked; a base that could not be marked is closed again, so a failed run leaves no stray workspace.
 */
export async function makeBase(run: HerdrRun, ctx: Pick<Ctx, "slot">, dir: string, label: string): Promise<DeskRecord> {
	const made = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus"]);
	const workspace: string = made.workspace.workspace_id;
	try {
		await run(["tab", "rename", made.tab.tab_id, TOWER_LABEL]);
		await report(run, "pane", made.root_pane.pane_id, { sb_role: "tower" });
		const record: DeskRecord = { workspace, dir, label };
		writeJson(fileOf(ctx.slot, "desk"), record);
		return record;
	} catch (cause) {
		await run(["workspace", "close", workspace]).catch(() => {});
		throw cause;
	}
}
