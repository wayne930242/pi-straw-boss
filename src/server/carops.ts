import { execFileExe } from "../exe.mjs";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { IntercomLike } from "./kit.ts";
import type { HerdrRun } from "../herdr.ts";
import { panes, workspaces } from "../herdr.ts";
import { trainFromToken } from "../trainrole.ts";
import { CarBook, type Look } from "./carbook.ts";
import { CarNotices } from "./carnotices.ts";
import { type Slot, towerId } from "./record.ts";
import type { Reply, Request } from "./socket.ts";

// The server's side of the car book (carbook.ts) and the notice sender (carnotices.ts): the control-socket commands `cars-register`, `cars-check`, `cars-set`, `cars-read`, and the wiring of both to the broker, Herdr and a timer.
// Kept out of main.ts, which carries a line budget.

export interface Cars { book: CarBook; notices: CarNotices }

// What git gets from the server's own environment (RR3-F002): an allow-list, so no GIT_* of the server (GIT_DEFAULT_HASH, GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_*, GIT_EXEC_PATH, GIT_TRACE...), proxy or ssl setting reaches it.
const KEEP_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|SSH_AUTH_SOCK|SSL_CERT_FILE|SSL_CERT_DIR|SystemRoot|SYSTEMROOT|USERPROFILE|APPDATA|LOCALAPPDATA|PATHEXT|COMSPEC)$/;
/**
 * git in a folder, for the checks the server makes on a train's word (CR-F002): git's environment is an allow-list of this process's (no GIT_*, proxy or ssl variable), the system and global configuration are not read, no prompt is made, and no hook, fsmonitor, `ext::` transport,
 * replace ref or submodule recursion can run something the folder chose. The folder's own `.git/config` is still read (the server reads the project's remote from the tower's checkout with it, at the open); the fetches run in a repository of the server's own. 60 s at most.
 */
export function runGit(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && KEEP_ENV.test(key)) env[key] = value;
	// git looks for no repository above the root of the file system: the `ls-remote` of `landed` runs at that root with none to find, so no repository configuration is read.
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: parse(resolve(cwd)).root, ...extra });
	const isolation = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "submodule.recurse=false", "--no-replace-objects"];
	return new Promise((resolvePromise, reject) => execFileExe("git", [...isolation, "-C", cwd, ...args], { encoding: "utf8", deadline: 60_000, env, windowsHide: true }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolvePromise(String(stdout).trim()))));
}

const reply = (error: unknown): Reply => ({ ok: false, error: (error as Error).message });

/** The cars' commands; undefined for a command that is not theirs. */
export function carsReply(cars: Cars | undefined, request: Request): Promise<Reply> | undefined {
	if (typeof request.cmd !== "string" || !request.cmd.startsWith("cars-")) return undefined;
	if (!cars) return Promise.resolve({ ok: false, error: "the server is still starting" });
	switch (request.cmd) {
		case "cars-register":
			return cars.book.register({ session: request.session, pid: request.pid, started: request.started, pane: request.pane }).then((r) => ({ ok: true, ...r }), reply);
		case "cars-check":
			return Promise.resolve(cars.book.check(request.secret) ? { ok: true } : { ok: false, error: "sb: this request is not from a registered session" });
		case "cars-set":
			return cars.book.set({ secret: request.secret, state: request.state as never, car: request.car as never, fields: request.fields as never }).then((r) => ({ ok: true, ...r }), reply);
		case "cars-read":
			return cars.book.readFor({ secret: request.secret, project: request.project }).then((list) => ({ ok: true, cars: list }), reply);
		default:
			return Promise.resolve({ ok: false, error: `unknown command ${request.cmd}` });
	}
}

export interface StartCars {
	slot: Slot;
	run: HerdrRun;
	now(): number;
	/** When the server started: the book's refusal of a forward made before it names it (todo #154). */
	startedAt?: number;
	/** The server's own intercom connection, when it is connected. */
	client(): IntercomLike | undefined;
	startOf(pid: number): string | undefined;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	stops: (() => void)[];
	/** Replaces the book's seams (tests). */
	over?: Partial<ConstructorParameters<typeof CarBook>[0]>;
}

/** What Herdr and the broker say about a session: its pane, the pane's tokens and folder, and the pids of the pane's foreground processes. */
async function look(o: StartCars, session: string): Promise<Look | undefined> {
	const client = o.client();
	if (!client) return undefined;
	const sessions = await client.listSessions();
	const found = sessions.find((s) => s.id === session), paneId = found?.herdrLocation?.paneId;
	if (!found || !paneId) return undefined;
	const pane = (await panes(o.run)).find((p) => p.pane_id === paneId);
	if (!pane) return undefined;
	let foreground: number[] = [];
	try {
		const info = JSON.parse(await o.run(["pane", "process-info", "--pane", paneId])).result?.process_info as { foreground_processes?: { pid?: number }[] } | undefined;
		foreground = (info?.foreground_processes ?? []).flatMap((p) => (Number.isSafeInteger(p.pid) ? [p.pid!] : []));
	} catch { foreground = []; }
	const token = pane.tokens?.sb_role;
	const train = trainFromToken(pane.tokens?.sb_train);
	return { id: session, name: (found.name ?? session), ...(token ? { role: token } : {}), ...(train ? { train } : {}), pane: paneId, ...(pane.workspace_id ? { workspace: pane.workspace_id } : {}), ...(pane.cwd ? { cwd: pane.cwd } : {}), foreground };
}

/** The user's known_hosts as it is now, read once when the server starts: the copy ssh trusts for the `landed` check (RR2-F002). Missing or unreadable, nothing is known and an ssh remote cannot be checked. */
function knownHostsOfUser(): string {
	try { return readFileSync(join(homedir(), ".ssh", "known_hosts"), "utf8").slice(0, 4_000_000); } catch { return ""; }
}

/** The book and the sender of this server; the sender runs on a 5 s timer until the server leaves. */
export function startCars(o: StartCars): Cars {
	let notices: CarNotices | undefined;
	const book = new CarBook({
		stateDir: o.slot.stateDir, dir: o.slot.dir, now: o.now, ...(o.startedAt !== undefined ? { startedAt: o.startedAt } : {}), look: (session) => look(o, session), git: runGit, knownHosts: knownHostsOfUser(), exists: existsSync, log: o.log,
		// The checkout of the session's workspace, as the tower's open reads it (towers.ts): where the check at `received` finds the project's remote and the app's base.
		checkoutOf: async (seen) => (seen.workspace ? (await workspaces(o.run)).find((w) => w.workspace_id === seen.workspace)?.worktree?.checkout_path : undefined) ?? seen.cwd,
		startOf: o.startOf, onChange: () => notices?.kick(), ...o.over,
	});
	notices = new CarNotices({ book, now: o.now, intercom: () => o.client(), tower: (workspace) => towerId(o.slot, workspace), log: o.log });
	notices.start();
	o.stops.push(() => notices?.stop());
	return { book, notices };
}
