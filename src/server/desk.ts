import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type HerdrRun, panes, report, result, TOWER_LABEL, workspaces } from "../herdr.ts";
import type { Ctx } from "./client.ts";
import { fileOf, LockBusy, type LockDeps, readOwnedText, takeLock, writeJson } from "./record.ts";

// The desk steps of `cli.mjs up --dir <folder> --label <name>` (docs/specs/2026-10-26-desk-mode.md S5 and S6, as docs/specs/2026-10-26-sb-backend.md, Desk mode: what changes, has them):
// Herdr's pi integration, the shell's home base (`desk.json`), and the lock that keeps two runs from making two bases. The tower itself is the server's (`ensure-tower`): this file starts no pi.

export interface DeskRecord { workspace: string; dir: string; label: string }
/** What a run that made the base tells `ensure-tower`: the root pane it just made and when, so the server knows that pane is a bare shell nobody has used (towers.ts `ensure`, `made`). */
export interface MadePane { pane: string; at: number }
export interface MadeBase { record: DeskRecord; made: MadePane }

// --- Herdr's pi integration ---

/** The state word of the `pi:` line of `herdr integration status` (`current (v9)`, `outdated (legacy < v9)`, `not installed`), before any parenthesis; undefined when the output has no such line. */
export function integrationState(output: string): string | undefined {
	const line = output.split(/\r?\n/).find((l) => l.startsWith("pi:"));
	return line ? line.slice(3).replace(/\s*\(.*$/, "").trim() || undefined : undefined;
}

/** The path in the last parentheses of the `pi:` line of `herdr integration status`: the file Herdr installs to, or undefined when the line has none. */
export function integrationPath(output: string): string | undefined {
	const line = output.split(/\r?\n/).find((l) => l.startsWith("pi:"));
	return line?.match(/\(([^()]*)\)\s*$/)?.[1]?.trim() || undefined;
}

/**
 * Makes sure Herdr's pi integration is in place for the agent directory (S6). In desk mode that directory is the shell's own, so writing to its `extensions/` touches nothing of the user's.
 * Herdr's install fails (exit 1, "extension directory not found") when `extensions/` is not there (a fresh agent directory), so the folder is made first, and the line is read again after the install.
 * The folder is the one Herdr names in its own `pi:` line (the directory of that path), so it is where Herdr installs whatever the environment says. `within` bounds each Herdr call by the run's deadline.
 */
export async function ensureIntegration(run: HerdrRun, within: (ms: number) => number = (ms) => ms): Promise<"current" | "installed"> {
	const status = async () => {
		const output = await run(["integration", "status"], within(10_000)), state = integrationState(output);
		if (state === undefined) throw new Error("`herdr integration status` has no pi line");
		return { state, path: integrationPath(output) };
	};
	const before = await status();
	if (before.state === "current") return "current";
	if (!before.path) throw new Error("`herdr integration status` names no file for the pi integration");
	mkdirSync(dirname(before.path), { recursive: true });
	await run(["integration", "install", "pi"], within(30_000));
	const after = (await status()).state;
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
 * `desk.lock`, taken the way `server.lock` is (record.ts `takeLock`): created whole and linked into place, so it is never seen half written; a stale one (its process gone or started at another time than
 * recorded, or older than ten minutes) is removed by one looker at a time, under `desk.lock.stale`, and only while it still holds the text that looker read. Returns the release (which removes the file
 * only while it is still this run's), or undefined when another run holds it.
 */
export async function deskLockFor(ctx: Pick<Ctx, "slot" | "now" | "alive">, deps: Pick<LockDeps, "self" | "startOf"> = {}): Promise<(() => void) | undefined> {
	try {
		const lock = await takeLock(ctx.slot, "up --dir", { ...deps, now: ctx.now, alive: ctx.alive, files: { lock: fileOf(ctx.slot, "deskLock"), marker: fileOf(ctx.slot, "deskLockStale") }, maxMs: DESK_LOCK_MS });
		return lock.release;
	} catch (error) {
		if (error instanceof LockBusy) return undefined;
		throw error;
	}
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
 * marked; a base that could not be marked is closed again, so a failed run leaves no stray workspace. The answer carries the root pane and the time it was made, for `ensure-tower`.
 */
export async function makeBase(run: HerdrRun, ctx: Pick<Ctx, "slot" | "now">, dir: string, label: string): Promise<MadeBase> {
	const made = await result(run, ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus"]);
	const workspace: string = made.workspace.workspace_id;
	try {
		await run(["tab", "rename", made.tab.tab_id, TOWER_LABEL]);
		await report(run, "pane", made.root_pane.pane_id, { sb_role: "tower" });
		const record: DeskRecord = { workspace, dir, label };
		writeJson(fileOf(ctx.slot, "desk"), record);
		return { record, made: { pane: made.root_pane.pane_id, at: ctx.now() } };
	} catch (cause) {
		await run(["workspace", "close", workspace]).catch(() => {});
		throw cause;
	}
}

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Whether `workspace`, which Herdr lists under the recorded id, is still the home base the record describes. Herdr numbers workspaces from the highest it restored, so a base that was quit can have
 * its id given to a workspace of the person's. The base is told by what such a workspace does not share by accident: its label is the recorded one (a restore keeps it), or one of its panes starts
 * in the recorded folder (Herdr reports real paths, so both sides are compared as real paths; case-folded on Windows, which is not verified on a real machine: Herdr's Windows cwd form and the
 * case `realpathSync` gives are unknown). A label counts only when it is not the basename of one of the workspace\'s pane folders (Herdr gives an unlabelled workspace that name and follows a `cd`). A tower tab alone says nothing: every workspace's tower tab carries the same label, so a workspace of the person's with a tower of its own would pass.
 * A base whose tower was quit and whose other tabs work elsewhere keeps its label, so it is still the base; one renamed by hand and left with no pane in the folder is not.
 */
export async function stillBase(run: HerdrRun, record: DeskRecord): Promise<boolean> {
	const cwds = (await panes(run, record.workspace)).flatMap((p) => (p.cwd === undefined ? [] : [p.cwd])), dir = real(record.dir);
	const auto = cwds.some((c) => [basename(c), basename(real(c))].includes(record.label)); // Herdr's own label for an unlabelled workspace: no evidence
	return (!auto && (await workspaces(run)).some((w) => w.workspace_id === record.workspace && w.label === record.label)) || cwds.some((c) => same(real(c), dir));
}
