import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { carsDir, trainboardDir } from "../train/board.ts";
import { readApps } from "../train/appsconfig.ts";
import { addState, type CarFile, carFileName, type CarState, type CarView, coordinatorWord, emptyCar, endOf, headsIn, landedWord, type NoticeRecord, type Setter, type SlipFacts, slipsInText, type StateEntry, stateLine, type StateNotice, validateStateFields } from "../train/cars.ts";
import { isCode, isName, isObject, SHA_RE } from "../train/spec.ts";
import { writePrivate } from "../trainboard.ts";

// The server's book of cars (docs/specs/2026-11-07-train-workers.md §5.5, §24; todo #125 task 5a). Every car state is set here, and every check that rests on a state or a notice asks here. The train's shell runs as the same user as pi and this server: it can
// open the control socket, name any session, pid and pane, and write any file under the state folder. Node gives the server no peer credentials of a socket. So no secret and no file proves who a caller is, and nothing the guard or the integrator relies on
// rests on a caller's word. The book holds three kinds of thing:
//   - Facts the server establishes itself. A car's identity (app, tickets, branch, head, coordinator) is read from the slip the tower forwarded, which the tower's code stamped (the forward record, in memory). `landed` is a commit that git finds on the real
//     remote branch of the base: its tip read by `ls-remote` with no repository, then fetched into a repository this server makes for that check alone (inspected, then removed) from a URL the server read at the open. The cars a train may touch are the heads of the manifest the server was handed at the open. A notice is told when the broker answered.
//     A car lands once (#15): `received` is refused for a head the same git check finds on the base's remote branch already, which holds after a restart because it rests on nothing the book remembers.
//   - A car's lives (#14). A car ends `returned`, `dropped` or `landed`. A forward of the same head that the tower made after that end is its coordinator sending the slip again, so the integrator's next state starts a new life of the car: a new car file under
//     the same name, with notices of its own. The life before stays in the book under `<name>#<n>` (its notice is still sent, and the train that dropped it still reads it); the journal shows the current life.
//   - Claims, each limited to the claimer's own train and granting nothing: `dropped` and `returned` of a car on the claimer's train (it only ends that car's ride), the `version` text of `landed`, and the integrator's `train`, `departs` and `reason` text. A
//     process that claims a role it is not can, at worst, end the rides of the cars of the train it registered as (it must be that train's session by Herdr's pane record and the server's own open), or put those words in the notice of a car the tower
//     forwarded to the integrator it registered as.
//   - A per-session secret that `register` hands the pi process, once. It is defense in depth, not proof: a registration is not replaced while its process lives, the start time of the process is required, and nothing above depends on it.
// The car files and notice records on disk are a display journal for the yard (they are written here, never read here). A restart starts with an empty book: what the disk holds, a train could have written. So a forward made before a restart is gone, and the
// integrator's refusal says so (todo #154): for as long as such a forward would have been kept, it names the server's start and the way back, which is the fact again (the coordinator sends the slip, the tower forwards it).

const KEEP_MS = 24 * 3600_000, MAX_FORWARDS = 512, MAX_FILES = 256;
const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/**
 * What the server fetches from: an `https://host/...` or `ssh://host/...` URL, or an scp-like `user@host:path` (no slash before the colon, so git reads it as ssh and never as a path). Anything git could read on this computer (an absolute or relative path, `~`,
 * `file://`, `x:y`), any other transport (`http`, `git`, `ext::`, `fd::`), an option, a host that begins with a dash, a user or scp path that begins with a dash, and white space are no remote: a train that reaches the checkout's configuration can point it at a
 * repository on this computer that it controls (RR-F002). So is a host that is this computer (RR2-F002): `localhost`, `*.localhost`, a loopback or `0.` address in any spelling, `0.0.0.0`, this machine's own host name and its `.local` name; an ssh to
 * those reaches a repository the train can write.
 */
const HOST = "(?<host>[A-Za-z0-9][A-Za-z0-9.-]*)", USER = "(?:[^\\s/@:-][^\\s/@:]*@)?";
const URL_OK = [new RegExp(`^https://${USER}${HOST}(?::\\d{1,5})?(?:/[^\\s]*)?$`, "i"), new RegExp(`^ssh://${USER}${HOST}(?::\\d{1,5})?(?:/[^\\s]*)?$`, "i"), new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*@${HOST}:[^\\s-][^\\s]*$`)];
/** True for a host that is this computer, or spelled so that a resolver could read it as such (a number that is not a plain dotted quad, a quad that starts with 127 or 0). */
function localHost(host: string): boolean {
	const h = host.toLowerCase().replace(/\.+$/, "");
	if (h === "localhost" || h.endsWith(".localhost") || h === "localhost.localdomain") return true;
	const labels = h.split(".");
	if (labels.every((l) => /^(?:0x[0-9a-f]+|[0-9]+)$/.test(l))) {
		const quad = labels.length === 4 && labels.every((l) => /^(?:0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255);
		return !quad || labels[0] === "127" || labels[0] === "0";
	}
	const mine = hostname().toLowerCase().replace(/\.+$/, ""), short = mine.split(".")[0]!;
	return [mine, short, `${short}.local`, `${mine}.local`].includes(h);
}
export const safeUrl = (url: string): string | undefined => {
	if (url.length > 500 || url.startsWith("-") || /\/\/[^/@]*@-/.test(url)) return undefined;
	for (const re of URL_OK) {
		const host = re.exec(url)?.groups?.host;
		if (host !== undefined) return localHost(host) ? undefined : url;
	}
	return undefined;
};
/** The host of a remote `safeUrl` accepts, and nothing else of it: no userinfo, port, or path (the unchecked notice names it, U1). */
export const hostOf = (url: string): string | undefined => {
	for (const re of URL_OK) { const host = re.exec(url)?.groups?.host; if (host !== undefined) return host.toLowerCase(); }
	return undefined;
};
/** What the server reads from the manifest text the tower opens a train on: the base it names and the heads of its cars. */
export function openingFacts(request: string): { base?: string; heads: string[] } {
	const head = request.split(/\r?\n(?=\s*car:)/i)[0] ?? request;
	const base = /(?:^|\n)[ \t>*-]*["']?base["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9][A-Za-z0-9._/-]{0,199})/i.exec(head)?.[1];
	return { ...(base ? { base } : {}), heads: headsIn(request).slice(0, 64) };
}

export const refusal = (text: string) => new Error(text);

/** What the server knows of a session from the broker and Herdr: the pane token role, the train token, the pane and its folder, and the pids of the pane's foreground processes (pi is one). */
export interface Look { id: string; name: string; role?: string; train?: { project: string; code: string }; pane: string; workspace?: string; cwd?: string; foreground: number[] }

export interface BookDeps {
	/** The state folder: the trainboard (the display journal) lives under it. */
	stateDir: string;
	/** The server's own folder: the mirror each `landed` check fetches into is made under it and removed after the check. */
	dir: string;
	/** The user's known_hosts as the server read it when it started: each check writes it for ssh to use (RR2-F002). Absent, ssh knows no host and an ssh remote cannot be checked. */
	knownHosts?: string;
	now(): number;
	/** When this server started, as the refusal of a forward it does not hold tells it (todo #154); the moment the book was made when absent. */
	startedAt?: number;
	look(session: string): Promise<Look | undefined>;
	/** The checkout folder of the Herdr workspace a session runs in (where the open reads a project's remote); left out, or undefined, the session's own folder is used. */
	checkoutOf?(look: Look): Promise<string | undefined>;
	/** The start time of a process, in the form `register` is given; undefined when it cannot be told. */
	startOf(pid: number): string | undefined;
	/** git in a folder, with the folder's own configuration kept out of it (carops.ts `runGit`), and `env` added to the environment the server scrubbed; rejects when git exits non-zero. */
	git(cwd: string, args: string[], env?: Record<string, string>): Promise<string>;
	exists(path: string): boolean;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
	/** 32 random bytes in hex (tests give a fixed one). */
	secret?(): string;
	/** Called when a state was added: the sender looks at once. */
	onChange?(): void;
}

/**
 * A train the tower opened: what the server read from the manifest it was handed (the base and the heads of the cars) and from the tower's checkout (the remote), both before the train's process existed, and the open's own result.
 * `url` is absent for a train the server only learns of from a repeated open after a restart: the checkout may have been changed by the train since.
 */
export interface TrainRecord { project: string; code: string; session: string; pane: string; integrator: string; base?: string; heads: string[]; url?: string; at: string }
/** A forward the tower's code stamped (runtools.ts): the event it came in, the session that sent it there, the sessions it went to, and the slips it carries as the server read them. */
export interface ForwardRecord { fwd: string; from: string; to: string[]; slips: SlipFacts[]; at: number }
interface Registration { session: string; pid: number; started: string; pane: string; at: number }

/** What a caller says of a car. For the integrator only the head (and the project) count: the rest is read from the forward, and a claim that differs from it is refused. */
export interface CarRef { project?: string; app?: string; head: string; tickets?: string[]; branch?: string; coordinator?: string }
export interface SetRequest { secret: unknown; state: CarState; car: CarRef; fields?: Record<string, unknown> }
/** `notice` is the line the coordinator is sent for the state: the integrator's wait for a `returned` notice hands it to the tower when this server's book is gone before it was delivered (#13). */
export interface SetResult { state: CarState; at: string; file: string; coordinator: string; notice?: string; /** Set on a `received` the server could not check against the base (the remote of the checkout was not read): why. */ unchecked?: string }
interface Held { file: CarFile; notice?: NoticeRecord }
/** The check at `received` run before the queue (`precheck`): for which car, and why it was not checked when it could not be. */
interface Checked { head: string; app: string; unchecked?: string }

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const iso = (ms: number) => new Date(ms).toISOString();
const noticeName = (name: string) => name.replace(/\.json$/, ".notice.json");
/** What follows a car file's name in the key of an earlier life (`<name>#<n>`); no file name holds it. */
const PAST = "#";
const changedAt = (held: Held) => held.file.states.at(-1)?.at ?? "";
/** git's first line of stderr, else the error's message (sb's own timeout names the command and its URL), with a URL's userinfo blanked (`blankUser`, also on the remotes a moved-remote refusal names): a token used as the https username goes into no tool text or log (R0772-F002, R0773-F001). */
const blankUser = (text: string) => text.replace(/\/\/[^/@\s'"]+@/g, "//***@");
const firstLine = (error: unknown) => blankUser(String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split("\n")[0]!).slice(0, 200);
/** Why git could not reach a remote, read from its first line of stderr; undefined for any other failure. Only `received` acts on it (0.77.2). */
export function reachClass(line: string): "auth" | "connection" | "repository-not-found" | undefined {
	if (/could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|Access denied|Permission denied \(publickey|returned error: 40[13]|Host key verification failed/i.test(line)) return "auth";
	// A repository the remote says is not there, and no other "not found" (`ssh: command not found` is a broken server, not a gone repository; R0772-F003).
	if (/Repository not found|repository '[^']*' not found|does not appear to be a git repository|returned error: 404/i.test(line)) return "repository-not-found";
	if (/Could not resolve host|Connection refused|Connection timed out|timed out|Failed to connect|Network is unreachable|Could not read from remote repository|unable to access|Connection reset|Connection closed/i.test(line)) return "connection";
	return undefined;
}
/** A refusal of a remote git could not reach: `reach` names the class. */
const unreached = (text: string, line: string) => Object.assign(refusal(text), { reach: reachClass(line) });
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** git's settings for the mirror: no commit-graph, multi-pack-index, or automatic gc is read or written, so nothing but the objects the fetch hashed itself decides the answer. */
const MIRROR_FLAGS = ["-c", "core.commitGraph=false", "-c", "fetch.writeCommitGraph=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.multiPackIndex=false"];
/**
 * What the fetch does not trust (RR2-F001): every object is checked as it comes in, and a pack is always kept (`unpackLimit=1`), so the mirror holds no loose object and the check below can refuse any. No proxy and a certificate check, whatever the global settings say.
 */
const FETCH_FLAGS = ["-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "fetch.unpackLimit=1", "-c", "transfer.unpackLimit=1"];
const REMOTE_FLAGS = ["-c", "http.proxy=", "-c", "http.sslVerify=true"];
/** Failed `landed` checks of one car on one train that close it (RR2-F001), within this window; the failures older than it are forgotten. */
const FAIL_LIMIT = 3, FAIL_WINDOW_MS = 10 * 60_000;
/**
 * ssh for the fetch (RR2-F002): no user configuration (`-F /dev/null`: the train writes `~/.ssh/config`), the known_hosts file the server wrote itself and no other, a host key that must match, no prompt, no proxy, and only the identity files of the user (and the agent keys that match
 * them). The agent and the key files stay reachable by the train: the identity is the user's and the check needs it.
 */
export function sshCommand(knownHosts: string): string {
	const nul = process.platform === "win32" ? "NUL" : "/dev/null";
	const word = (v: string) => (/^[\w./:@+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
	return ["ssh", "-F", nul, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", word(`UserKnownHostsFile=${knownHosts}`), "-o", `GlobalKnownHostsFile=${nul}`, "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "IdentitiesOnly=yes"].join(" ");
}

type Kind = "dir" | "file" | "link" | "other" | "none";
const kindOf = (path: string): Kind => { try { const st = lstatSync(path); return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; } catch { return "none"; } };
const entries = (path: string): string[] => { try { return readdirSync(path).sort(); } catch { return []; } };
const filesUnder = (dir: string, prefix = ""): string[] => entries(dir).flatMap((n) => (kindOf(join(dir, n)) === "dir" ? filesUnder(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));
/** The settings `git init --bare` writes into a config, and nothing else: a train that wrote one first (a `url.*.insteadOf`, an `include`, a `core.sshCommand`) is seen at once, with no earlier copy to compare to. */
const INIT_KEYS = new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"]);
function strangeConfig(text: string): string | undefined {
	let core = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (/^\[core\]$/i.test(line)) { core = true; continue; }
		const m = /^([A-Za-z]+)\s*=\s*(\S+)$/.exec(line);
		if (!core || !m || !INIT_KEYS.has(m[1]!.toLowerCase()) || (m[1]!.toLowerCase() === "repositoryformatversion" && m[2] !== "0") || (m[1]!.toLowerCase() === "bare" && m[2] !== "true")) return line.slice(0, 60);
	}
	return core ? undefined : "no [core]";
}
const PACK_FILE = /^pack-[0-9a-f]{40,64}\.(?:pack|idx|rev)$/;
interface Look1 { refs: string; config: string; head: string; packs: string }
/**
 * What the mirror the server made may hold at each stage of a check (RR2-F001): after `init` nothing but HEAD, config, the empty `objects/info` and `objects/pack`, and `refs`; after the fetch the same plus FETCH_HEAD, the one pack git wrote (its `.pack` and `.idx`), and
 * the one ref `refs/sb/base/<code>`; never an alternates file, a hooks folder, a loose object, `commondir`, `shallow`, a link, or a config or HEAD that is not byte for byte what it was. `before` is the earlier stage's look. Returns what was found wrong, and the look.
 */
function inspectMirror(dir: string, code: string, stage: "init" | "fetch" | "check", before?: Look1): { problems: string[]; look?: Look1 } {
	if (kindOf(dir) !== "dir") return { problems: ["the folder itself"] };
	const bad: string[] = [];
	const top = new Set(["HEAD", "config", "objects", "refs", ...(stage === "init" ? [] : ["FETCH_HEAD"])]);
	for (const n of entries(dir)) if (!top.has(n)) bad.push(n);
	for (const n of ["HEAD", "config"]) if (kindOf(join(dir, n)) !== "file") bad.push(n);
	const objects = join(dir, "objects");
	if (kindOf(objects) !== "dir") bad.push("objects");
	for (const n of entries(objects)) if (n !== "info" && n !== "pack") bad.push(`objects/${n}`);
	if (kindOf(join(objects, "info")) !== "dir") bad.push("objects/info");
	for (const n of entries(join(objects, "info"))) bad.push(`objects/info/${n}`);
	const packDir = join(objects, "pack");
	if (kindOf(packDir) !== "dir") bad.push("objects/pack");
	const packs = entries(packDir);
	for (const n of packs) if (!PACK_FILE.test(n) || kindOf(join(packDir, n)) !== "file") bad.push(`objects/pack/${n}`);
	const names = packs.filter((n) => n.endsWith(".pack"));
	for (const n of names) if (!packs.includes(n.replace(/\.pack$/, ".idx"))) bad.push(`objects/pack/${n} (no index)`);
	if (stage === "init" ? packs.length : names.length !== 1) bad.push(stage === "init" ? "objects/pack (not empty)" : `objects/pack (the fetch of one branch writes one pack, found ${names.length})`);
	const refs = join(dir, "refs");
	if (kindOf(refs) !== "dir") bad.push("refs");
	const refFiles = kindOf(refs) === "dir" ? filesUnder(refs) : [];
	const wanted = stage === "init" ? [] : [`sb/base/${code}`];
	for (const f of refFiles) if (!wanted.includes(f)) bad.push(`refs/${f}`);
	if (stage !== "init" && !refFiles.includes(wanted[0]!)) bad.push(`refs/${wanted[0]} (missing)`);
	if (bad.length) return { problems: bad };
	if (stage === "init") {
		const odd = strangeConfig(readFileSync(join(dir, "config"), "utf8"));
		if (odd) return { problems: [`config: ${odd}`] };
		if (!/^ref: refs\/heads\/[A-Za-z0-9._/-]+\r?\n?$/.test(readFileSync(join(dir, "HEAD"), "utf8"))) return { problems: ["HEAD"] };
	}
	const refValue = refFiles.length ? refFiles.map((f) => readFileSync(join(refs, f), "latin1")).join("|") : "";
	const look: Look1 = { refs: refValue, config: readFileSync(join(dir, "config")).toString("latin1"), head: readFileSync(join(dir, "HEAD")).toString("latin1"), packs: packs.map((n) => `${n}:${lstatSync(join(packDir, n)).size}`).join(",") };
	if (before) {
		if (look.config !== before.config) bad.push("config (changed)");
		if (look.head !== before.head) bad.push("HEAD (changed)");
		if (stage === "check" && look.refs !== before.refs) bad.push("refs (changed)");
		if (stage === "check" && look.packs !== before.packs) bad.push("objects/pack (changed)");
	}
	return { problems: bad, look };
}

/** What of the mirror's config and HEAD differs from the look taken after its init (a file that cannot be read differs). */
function mirrorMoved(dir: string, look: Look1 | undefined): string[] {
	const read = (name: string) => { try { return readFileSync(join(dir, name)).toString("latin1"); } catch { return undefined; } };
	return look ? [...(read("config") !== look.config ? ["config (changed)"] : []), ...(read("HEAD") !== look.head ? ["HEAD (changed)"] : [])] : ["config (no look)"];
}

export class CarBook {
	private readonly cars = new Map<string, Map<string, Held>>();
	private readonly regs = new Map<string, Registration>();
	private readonly bySession = new Map<string, string>();
	private forwards: ForwardRecord[] = [];
	private readonly trains = new Map<string, TrainRecord>();
	/** The remote the first train of each project was opened on in this server's life: a later open that read another one is not trusted for `landed`. */
	private readonly remotes = new Map<string, string>();
	/** When each failed `landed` check of a car (project/train/head) happened, within the window. */
	private readonly failures = new Map<string, number[]>();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly d: BookDeps;
	/** Since when this book holds forwards: none made before it is here, whatever the disk holds. */
	private readonly since: number;

	constructor(deps: BookDeps) { this.d = deps; this.since = deps.startedAt ?? deps.now(); }

	// ---- the display journal: written here, read by the yard, never read back (CR-F003)

	private writeCar(project: string, name: string, held: Held) {
		if (name.includes(PAST)) return; // an earlier life of a car: the file of that name shows the life it lives now
		const dir = carsDir(this.d.stateDir, project), root = trainboardDir(this.d.stateDir);
		try {
			writePrivate(join(dir, name), `${JSON.stringify(held.file)}\n`, root);
			if (held.notice) writePrivate(join(dir, noticeName(name)), `${JSON.stringify(held.notice)}\n`, root);
		} catch (error) { this.d.log?.("cars-journal", { error: (error as Error).message.slice(0, 200) }); }
	}

	// ---- facts the server itself records

	/** A forward the tower's code stamped. Called by the tower tools of the server, never by a session. Only a text that carries slips is kept. */
	noteForward(f: { fwd: string; from: string; to: string[]; text: string }): void {
		const slips = slipsInText(f.text);
		if (!slips.length) return;
		this.forwards = [...this.forwards.filter((x) => this.d.now() - x.at < KEEP_MS), { fwd: f.fwd, from: f.from, to: f.to.slice(0, 20), slips, at: this.d.now() }].slice(-MAX_FORWARDS);
	}
	/** The newest forward of this head to this session, with the slip it carries. */
	forwardOf(head: string, to: string): (ForwardRecord & { slip: SlipFacts }) | undefined {
		for (const f of [...this.forwards].reverse()) {
			const slip = f.slips.find((x) => x.head === head);
			if (slip && this.d.now() - f.at < KEEP_MS && f.to.includes(to)) return { ...f, slip };
		}
		return undefined;
	}
	/** The remote of the project whose checkout is `checkout`, read the way `landed` will fetch it; undefined when there is none or it is no safe URL. Read at the open, before the train exists. */
	async remoteOf(checkout: string | undefined): Promise<string | undefined> {
		if (!checkout || !isAbsolute(checkout)) return undefined;
		try { return safeUrl((await this.d.git(checkout, ["config", "--get", "remote.origin.url"])).trim()); } catch { return undefined; }
	}
	/** A train the tower opened. The first note of a code is kept: a repeated open (the opener's ledger answers it) does not change what was read at the first. */
	noteTrain(t: Omit<TrainRecord, "at">): void {
		const key = `${t.project}/${t.code}`;
		if (this.trains.has(key)) return;
		this.trains.set(key, { ...t, heads: [...new Set(t.heads)].slice(0, 64), at: iso(this.d.now()) });
		if (t.url && !this.remotes.has(t.project)) this.remotes.set(t.project, t.url);
	}
	trainOf(project: string, code: string): TrainRecord | undefined { return this.trains.get(`${project}/${code}`); }
	/**
	 * What the refusal of a forward this book does not hold adds while a forward made before the server's start would still be kept (todo #154; live, 0.75.0: a slip forwarded 8 minutes before an install restarted the server could be neither received nor
	 * returned, and the refusal named no cause). Nothing is restored: the tower's forward to this server is the fact, so the way back is that forward again. After `KEEP_MS` no earlier forward would count, and nothing is added.
	 */
	private restartWord(): string {
		if (this.d.now() - this.since >= KEEP_MS) return "";
		return ` The sb server started at ${iso(this.since)} and keeps a tower's forwards in memory only, so a forward made before that is gone with the restart: ask the car's coordinator to send its slip to the tower again (call_tower why=shared); the tower forwards it again, and then the state is set.`;
	}

	// ---- the registration: defense in depth

	/**
	 * Hands the pi process its secret, once. The session must be live, in a pane Herdr knows, and `pid` one of that pane's foreground processes with the start time the server reads for it. A registration whose process still runs in the pane is not replaced
	 * (by that process or by another); a pi that started again (a new pid) replaces the old one. This proves nothing about who asks (the caller can name all of it); see the header.
	 */
	async register(req: { session: unknown; pid: unknown; started?: unknown; pane: unknown }): Promise<{ secret: string }> {
		const session = req.session, pid = req.pid, pane = req.pane;
		if (!text(session, 128) || !Number.isSafeInteger(pid) || (pid as number) <= 1 || !text(pane, 64)) throw refusal("sb: cars-register needs the session id, the pid of the pi and its pane");
		if (!text(req.started, 128)) throw refusal("sb: cars-register needs the start time of the pi process (started)");
		const started = req.started;
		const look = await this.d.look(session);
		if (!look) throw refusal(`sb: session ${session} is not live on the net, so it cannot register`);
		if (look.pane !== pane) throw refusal(`sb: session ${session} does not run in pane ${pane}`);
		if (!look.foreground.includes(pid as number)) throw refusal(`sb: pid ${pid} is not a foreground process of pane ${pane}; only the pi of the pane registers`);
		const real = this.d.startOf(pid as number);
		if (real === undefined) throw refusal(`sb: the start time of pid ${pid} cannot be read, so it cannot register`);
		if (real !== started) throw refusal(`sb: pid ${pid} started at ${real}, not ${started}`);
		const known = this.bySession.get(session), old = known ? this.regs.get(known) : undefined;
		if (old && look.foreground.includes(old.pid) && this.d.startOf(old.pid) === old.started) throw refusal(`sb: session ${session} is already registered to a live process (pid ${old.pid}); a registration is not replaced while that process runs`);
		if (known) this.regs.delete(known);
		const secret = this.d.secret?.() ?? randomBytes(32).toString("hex");
		this.regs.set(secret, { session, pid: pid as number, started, pane, at: this.d.now() });
		this.bySession.set(session, secret);
		this.d.log?.("cars-register", { session: session.slice(0, 40), pid: pid as number });
		return { secret };
	}
	/** Whether the server holds this secret (a pi asks, to register again after a restart). */
	check(secret: unknown): boolean { return typeof secret === "string" && this.regs.has(secret); }

	/** Who a secret is: the registration, checked against what Herdr and the broker say now. */
	private async who(secret: unknown): Promise<{ reg: Registration; setter: Setter; look: Look; train?: { project: string; code: string } }> {
		const reg = typeof secret === "string" ? this.regs.get(secret) : undefined;
		if (!reg) throw refusal("sb: this request is not from a registered session: a car state is set from the pi session itself with the train_car tool");
		const look = await this.d.look(reg.session);
		if (!look || look.pane !== reg.pane || !look.foreground.includes(reg.pid)) throw refusal(`sb: session ${reg.session} is not the process that registered (it ended or moved)`);
		const role = look.role === "train" ? "train" : look.role === "main" ? "main" : undefined;
		if (!role) throw refusal(`sb: session ${look.name} is neither a train nor a main (its role is ${look.role ?? "none"})`);
		if (role === "train" && !look.train) throw refusal(`sb: session ${look.name} is a train with no train token`);
		// A pane token is Herdr state any process of the user can write: the train is the session this server opened for that code, not the one whose pane says so.
		if (role === "train" && this.trainOf(look.train!.project, look.train!.code)?.session !== reg.session) throw refusal(`sb: this server did not open train ${look.train!.code} of project ${look.train!.project} for session ${reg.session}`);
		return { reg, setter: { role, name: look.name, session: reg.session, ...(look.workspace ? { workspace: look.workspace } : {}) }, look, ...(look.train ? { train: look.train } : {}) };
	}

	// ---- reading

	/** Every car file of a project with its notice record, unbounded: for the sender's own bookkeeping and the tests. A caller over the socket gets `readFor`. */
	read(project: string): CarView[] {
		return [...(this.cars.get(project)?.values() ?? [])].slice(0, MAX_FILES).map((h) => ({ file: structuredClone(h.file), ...(h.notice ? { notice: structuredClone(h.notice) } : {}) }));
	}
	/** The book's own record of one car (no copy; read only): the yard's notice line comes from here, and from the journal on disk only for a car this server's life has not seen (TB-F005). */
	viewOf(project: string, app: string, head: string): CarView | undefined {
		let name: string;
		try { name = carFileName(app, head); } catch { return undefined; }
		const held = this.cars.get(project)?.get(name);
		return held && held.file.app === app && held.file.car.head === head ? { file: held.file, ...(held.notice ? { notice: held.notice } : {}) } : undefined;
	}
	/**
	 * The cars a registered session may see (`cars-read`): a train sees, in its own project, the cars of its manifest, each in the life it acts on (`lifeFor`); the integrator sees the cars a tower forwarded to it and the ones it set, every life of each,
	 * the newest `MAX_FILES` of them. The guard asks for nothing else.
	 */
	async readFor(req: { secret: unknown; project: unknown }): Promise<CarView[]> {
		const { setter, train } = await this.who(req.secret);
		if (!isName(req.project)) throw refusal("sb: cars-read needs a project (a path-safe name)");
		const project = req.project, view = (h: Held): CarView => ({ file: structuredClone(h.file), ...(h.notice ? { notice: structuredClone(h.notice) } : {}) });
		if (setter.role === "train") {
			if (project !== train!.project) throw refusal(`sb: this train works for project ${train!.project}, not ${project}`);
			return [...new Set(this.trainOf(project, train!.code)?.heads ?? [])].flatMap((head) => { const life = this.lifeFor(project, head, train!.code); return life ? [view(life[1])] : []; });
		}
		const mine = (h: Held) => h.file.states.some((s) => s.by.session === setter.session) || this.forwardOf(h.file.car.head, setter.session) !== undefined;
		return [...(this.cars.get(project)?.values() ?? [])].filter(mine).slice(-MAX_FILES).map(view);
	}
	/**
	 * The life of a car (by its head) a train acts on and reads: the newest one the integrator received for this train, else the life the car lives now. A car that was dropped and then sent again rides another train in a new life (#14),
	 * and the train that dropped it still reads, and waits for, the state it set.
	 */
	private lifeFor(project: string, head: string, code: string): [string, Held] | undefined {
		const lives = [...(this.cars.get(project)?.entries() ?? [])].filter(([, h]) => h.file.car.head === head);
		const newest = (list: typeof lives) => list.reduce<(typeof lives)[number] | undefined>((top, life) => (top && changedAt(top[1]) >= changedAt(life[1]) ? top : life), undefined);
		return newest(lives.filter(([, h]) => h.file.states.some((s) => s.state === "received" && s.train === code))) ?? newest(lives);
	}
	/** Every state whose notice is not yet told, oldest first, for the sender. */
	pending(): { project: string; name: string; file: CarFile; entry: StateEntry; notice?: StateNotice }[] {
		const out: { project: string; name: string; file: CarFile; entry: StateEntry; notice?: StateNotice }[] = [];
		for (const [project, held] of this.cars) {
			for (const [name, h] of held) {
				for (const entry of h.file.states) {
					const notice = h.notice?.states[entry.state];
					if (notice?.deliveredAt) continue;
					out.push({ project, name, file: h.file, entry, ...(notice ? { notice } : {}) });
				}
			}
		}
		return out.sort((a, b) => a.entry.at.localeCompare(b.entry.at));
	}
	/**
	 * The life a state entry belongs to, wherever the book keeps it now: a new life of the car moves the one before to `<name>#<n>` (#14), maybe while the sender awaits a send of that earlier life (car-forward-F001). A life's later states keep the entries of its
	 * earlier ones (`addState` copies the list, not the entries), so the entry names its life and no other.
	 */
	private lifeOf(project: string, name: string, entry: StateEntry): [string, Held] | undefined {
		for (const [key, held] of this.cars.get(project) ?? []) if ((key === name || key.startsWith(`${name}${PAST}`)) && held.file.states.includes(entry)) return [key, held];
		return undefined;
	}
	/** The notice record of one state of the life `entry` was set in, as it is now. */
	noticeOf(project: string, name: string, entry: StateEntry): StateNotice | undefined { return this.lifeOf(project, name, entry)?.[1].notice?.states[entry.state]; }
	/** Changes the notice record of one state of the life `entry` was set in (the sender is the only caller) and writes it. */
	updateNotice(project: string, name: string, entry: StateEntry, change: (record: StateNotice) => void): void {
		const life = this.lifeOf(project, name, entry);
		if (!life) return;
		const [key, held] = life, state = entry.state;
		const notice: NoticeRecord = held.notice ?? { v: 1, states: {} };
		const record: StateNotice = notice.states[state] ?? { attempts: [] };
		change(record);
		notice.states[state] = record;
		held.notice = notice;
		this.writeCar(project, key, held);
	}

	// ---- setting a state

	/**
	 * Sets are taken one at a time. The git check at `received` (`unlanded`, a fetch of the base) runs before the request joins that queue, since it reads nothing the book holds: a train's `landed` behind a few receipts is not held up by their fetches
	 * (car-forward-F002). Inside the queue the check runs again only when the book changed in between so that the receipt needs it and it was not run.
	 */
	set(req: SetRequest): Promise<SetResult> {
		const run = this.precheck(req).then((checked) => {
			const next = this.chain.then(() => this.setNow(req, checked));
			this.chain = next.catch(() => undefined);
			return next;
		});
		return run;
	}
	/** The check at `received` of a receipt that would start a car or a life, run outside the queue. Anything other than the check's own refusal is left for `setNow` to say. */
	private async precheck(req: SetRequest): Promise<Checked | undefined> {
		if (req.state !== "received" || !isObject(req.car) || !SHA_RE.test(String(req.car.head))) return undefined;
		const head = String(req.car.head);
		let found: { setter: Setter; look: Look } | undefined;
		try { found = await this.who(req.secret); } catch { return undefined; }
		const project = req.car.project, sent = this.forwardOf(head, found.setter.session);
		if (found.setter.role !== "main" || !isName(project) || !sent || sent.slip.over) return undefined;
		const name = carFileName(sent.slip.app, head);
		if (!this.startsLife(project, name, sent.at)) return undefined;
		return { head, app: sent.slip.app, ...(await this.unlanded(project, sent.slip.app, head, sent.slip.tickets[0] ?? name, found.look)) };
	}
	/** Whether a receipt now would start the car or a new life of it (no car under `name`, or one that ended before the forward). */
	private startsLife(project: string, name: string, sentAt: number): boolean {
		const file = this.cars.get(project)?.get(name)?.file, ended = file ? endOf(file) : undefined;
		return !file || (ended !== undefined && sentAt > Date.parse(ended.at));
	}

	private async setNow(req: SetRequest, checked?: Checked): Promise<SetResult> {
		const { setter, train, look } = await this.who(req.secret);
		const state = req.state, fields = isObject(req.fields) ? { ...req.fields } : {};
		const bad = validateStateFields(state, fields);
		if (bad.length) throw refusal(bad.join("; "));
		const car = req.car;
		if (!isObject(car) || !SHA_RE.test(String(car.head))) throw refusal("sb: car needs a 40-hex head");
		const head = car.head;
		const project = setter.role === "train" ? train!.project : car.project;
		if (!isName(project)) throw refusal("sb: car needs a project (a path-safe name)");
		if (setter.role === "train" && car.project !== undefined && car.project !== project) throw refusal(`sb: this train works for project ${project}, not ${String(car.project)}`);
		if (setter.role === "main" && (state === "dropped" || state === "landed")) throw refusal(`sb: only a train sets ${state}; the integrator sets received and returned`);
		if (setter.role === "train" && state === "received") throw refusal("sb: only the integrator sets received");

		let file: CarFile | undefined, name: string, held: Held | undefined, label: string, before: Held | undefined, unchecked: string | undefined;
		if (setter.role === "main") {
			// The integrator's: the slip arrived as a tower's forward to this session; the car is what that slip says, and the session that sent it to the tower is the coordinator. Nothing of the car comes from the caller.
			const sent = this.forwardOf(head, setter.session);
			if (!sent) throw refusal(`sb: no forward by a tower carries head ${head.slice(0, 12)} to this session: a car slip reaches the integrator only as the tower's tower_send or tower_reply with forward: (the code stamps fwd-from).${this.restartWord()}`);
			const slip = sent.slip;
			if (slip.over) throw refusal(slip.over);
			name = carFileName(slip.app, head);
			held = this.cars.get(project)?.get(name);
			file = held?.file;
			label = slip.tickets[0] ?? name;
			const claims: [string, boolean][] = [["app", car.app === undefined || car.app === slip.app], ["tickets", car.tickets === undefined || same(car.tickets, slip.tickets)], ["branch", car.branch === undefined || car.branch === slip.branch], ["coordinator", car.coordinator === undefined || car.coordinator === slip.coordinator]];
			const off = claims.find(([, ok]) => !ok);
			if (off) throw refusal(`sb: car ${label} does not match the forwarded slip: ${off[0]} differs from what the slip the tower forwarded says`);
			// A forward the tower made after the car ended is its coordinator sending the same head again (#14): the car starts a new life, and the state set here is its first. A landed car is not received again in any life (#15); returned, it tells the coordinator so.
			const ended = file ? endOf(file) : undefined;
			if (ended && sent.at > Date.parse(ended.at)) {
				if (ended.state === "landed" && state === "received") throw refusal(landedWord(label, head, `landed in ${String(ended.version).slice(0, 60)}`));
				// A train reads the life received for its own code (`lifeFor`), so a new life does not ride a train an earlier life of the car left.
				const rode = [...(this.cars.get(project)?.entries() ?? [])].some(([key, h]) => (key === name || key.startsWith(`${name}${PAST}`)) && h.file.states.some((s) => s.state === "received" && s.train === fields.train));
				if (state === "received" && rode) throw refusal(`sb: car ${label} rode train ${String(fields.train)} in an earlier life and left it; received names the train it rides now`);
				before = held;
				held = file = undefined;
			}
			if (file?.states.some((s) => s.state === "received")) throw refusal(`sb: car ${label} is already received${state === "returned" ? "; the integrator returns a car at receipt only" : ""}`);
			if (!slip.coordinator) throw refusal("sb: the slip names no coordinator");
			if (slip.coordinator !== sent.from) {
				const word = coordinatorWord(label, slip.coordinator, sent.from);
				if (state === "received") throw refusal(word);
				// A returned car goes to the session that really sent it, with the word.
				fields.reason = word;
			}
			if (state === "received" && !file) unchecked = checked && checked.head === head && checked.app === slip.app ? checked.unchecked : (await this.unlanded(project, slip.app, head, label, look)).unchecked;
			file ??= emptyCar({ project, app: slip.app, tickets: slip.tickets, branch: slip.branch, head, coordinator: sent.from });
		} else {
			// A train's claim, limited to its own train: the car is one of the manifest the server was handed at the open, and the integrator received it.
			const record = this.trainOf(project, train!.code)!;
			if (!record.heads.includes(head)) throw refusal(`sb: car with head ${head.slice(0, 12)} is not in the manifest of train ${train!.code}: the server read the cars of the manifest at the open, and a train sets only those`);
			const life = this.lifeFor(project, head, train!.code);
			held = life?.[1];
			file = held?.file;
			name = life?.[0] ?? head;
			label = file?.car.tickets[0] ?? head.slice(0, 12);
			if (!file) throw refusal(`sb: car with head ${head.slice(0, 12)} is not in the book of project ${project}: only a car the integrator received can be set`);
			const receipt = file.states.find((s) => s.state === "received");
			if (!receipt) throw refusal(`sb: car ${label} was never received, so it is on no train`);
			// The manifest is the tower's text, so it alone gives no right: the integrator this train was opened for must have received the car for this train.
			if (receipt.train !== train!.code) throw refusal(`sb: car ${label} was not received for train ${train!.code} (the integrator received it for ${String(receipt.train).slice(0, 40)}), so this train does not set it`);
			if (receipt.by.session !== record.integrator) throw refusal(`sb: car ${label} was not received by this train's integrator, so this train does not set it`);
			if (state === "dropped" && (!isAbsolute(String(fields.evidence)) || !this.d.exists(String(fields.evidence)))) throw refusal(`sb: dropped.evidence ${String(fields.evidence).slice(0, 200)} is not a file that exists (give its absolute path)`);
			if (state === "landed") await this.landed(project, record, head, String(fields.commit), label);
		}
		let next: CarFile;
		try { next = addState(file, { state, fields, by: setter, at: iso(this.d.now()) }); } catch (error) { throw refusal((error as Error).message); }
		// A new life starts with a notice record of its own, written at once so the journal never shows the new file beside the old life's record.
		const entry = next.states.at(-1)!, stored: Held = { file: next, ...(held?.notice ? { notice: held.notice } : before ? { notice: { v: 1, states: {} } } : {}) };
		const forProject = this.cars.get(project) ?? new Map<string, Held>();
		if (before) {
			// The new life goes last in the book, where a new car would, and the life before right after it under a key of its own: a reader that takes the first entry of a head (a client older than lives, `.find`) gets the life the car lives now (car-forward-F004).
			const past = `${name}${PAST}${[...forProject.keys()].filter((k) => k.startsWith(`${name}${PAST}`)).length + 1}`;
			forProject.delete(name);
			forProject.set(name, stored);
			forProject.set(past, before);
		} else forProject.set(name, stored);
		this.cars.set(project, forProject);
		this.writeCar(project, name, stored);
		this.d.log?.("cars-set", { project, state, car: label.slice(0, 40) });
		queueMicrotask(() => this.d.onChange?.());
		let notice: string | undefined;
		try { notice = stateLine(next, entry); } catch { notice = undefined; }
		return { state, at: entry.at, file: name, coordinator: next.coordinator, ...(notice ? { notice } : {}), ...(unchecked ? { unchecked } : {}) };
	}

	/**
	 * A commit is landed when git, run here, finds it on the real remote's branch of the base. The remote is the one the server read from the tower's checkout at the open; the base is the one the manifest named. The tip of that branch is read by `git ls-remote` run
	 * with no repository (cwd the file system's root, no GIT_DIR, a ceiling there), so no repository configuration is read. The fetch goes into a bare repository the server makes for this check alone under its folder (mode 700), with an empty template, and the folder is
	 * removed after it, so nothing a train wrote there earlier decides the answer (RR-F001, RR-F004). The fetch must bring exactly that tip, every object is checked as it comes in, and the mirror must hold nothing but what init and fetch wrote: the same config, no alternates,
	 * no loose object, packs git wrote (RR2-F001). Not proof against a train that wins a race inside the few seconds of a check, and a refusal does not say it did not: it is the bar, and the refusals are logged. A push the train makes itself to the base counts: the train runs
	 * the merge (§3.3). Failed checks of one car are limited (RR2-F001): three in ten minutes close it until the window passes.
	 */
	private async landed(project: string, record: TrainRecord, head: string, commit: string, label: string): Promise<void> {
		const key = `${project}/${record.code}/${head}`, now = this.d.now();
		const failed = (this.failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
		this.failures.set(key, failed);
		const log = (reason: string, shut: boolean) => this.d.log?.("cars-landed-refused", { project, train: record.code, car: label.slice(0, 40), shut, reason: reason.slice(0, 200) });
		if (failed.length >= FAIL_LIMIT) {
			const minutes = Math.max(1, Math.ceil((failed[0]! + FAIL_WINDOW_MS - now) / 60_000));
			const word = `sb: too many failed landed checks of ${label} on train ${record.code} (${FAIL_LIMIT} in ${FAIL_WINDOW_MS / 60_000} minutes); retry in ${minutes} minute${minutes === 1 ? "" : "s"}`;
			log(word, true);
			throw refusal(word);
		}
		try { await this.checkLanded(project, record, commit, label); } catch (error) {
			failed.push(now);
			log((error as Error).message, false);
			throw error;
		}
	}
	private async checkLanded(project: string, record: TrainRecord, commit: string, label: string): Promise<void> {
		const code = record.code, base = record.base;
		if (!base || !BASE_RE.test(base) || base.includes("..")) throw refusal(`sb: the manifest of train ${code} names no usable base (base: <branch>)`);
		if (!record.url) throw refusal(`sb: the remote of project ${project} was not read when train ${code} opened (the open names none or none that is safe to fetch from, or this server learned of the train after a restart), so ${label}'s commit cannot be checked`);
		const url = record.url, first = this.remotes.get(project);
		if (first !== undefined && first !== url) throw refusal(`sb: the remote of project ${project} changed between two opens of this server (${blankUser(first).slice(0, 120)}, then ${blankUser(url).slice(0, 120)}); landed is not checked against a remote that moved`);
		await this.withBase({ project, url, base, key: code, state: "landed" }, async (git, tip) => {
			try { await git("merge-base", "--is-ancestor", commit, tip); } catch { throw refusal(`sb: landed.commit ${commit.slice(0, 12)} is not on ${base} of the project's remote: a car has landed only when its commit is on the base's branch there`); }
		});
	}
	/**
	 * A car lands once (#15): `received` is refused for a head that git, run here, finds on the base's branch of the project's remote already. Nothing the book remembers is asked, so it holds after a restart, when the book no longer knows that the car landed, and
	 * for a head somebody pushed to the base by hand. The remote and the base are read now: the remote of the checkout of the integrator's workspace (where an open reads it) and the app's `integration.base` in that checkout's apps.json. The fetch is the one of
	 * `landed`, into a mirror of its own. When the checkout's remote cannot be read nothing is checked (`cars-received-unchecked` is logged, and the integrator's tool says so): an open reads the remote from the same checkout, so a train of such a project has no remote and
	 * cannot set `landed` either. When the remote is read but the app names no usable `integration.base`, `received` is refused (car-forward-F003; the boss's rule that a car is never landed twice wins), and so it is when git fails for any reason but reaching the remote. When
	 * `ls-remote` or the fetch fails because the remote cannot be reached or authenticated (the server's git has no credential helper, RR3-F002; repository not found counts), the car is received unchecked with that class as the reason (0.77.2). A head that is not in the base's history is the usual car. A car merged by squash or rebase has no head on the base and is not found here.
	 */
	private async unlanded(project: string, app: string, head: string, label: string, look: Look): Promise<{ unchecked?: string }> {
		const where = await this.baseOf(look, app);
		if ("unread" in where) {
			this.d.log?.("cars-received-unchecked", { project, car: label.slice(0, 40), reason: "unread" });
			return { unchecked: `the remote of the integrator's workspace checkout could not be read, so whether head ${head.slice(0, 12)} is on the base already was not checked` };
		}
		if ("refused" in where) {
			const word = `sb: car ${label} is not received: ${where.refused}, so whether its head ${head.slice(0, 12)} is on the base already cannot be checked. A car that is on the base is never received again: the boss sets integration.base of app ${app}`;
			this.d.log?.("cars-received-refused", { project, car: label.slice(0, 40), reason: word.slice(0, 200) });
			throw refusal(word);
		}
		const { url, base } = where;
		let on: boolean;
		try {
			on = await this.withBase({ project, url, base, key: "receipt", state: "received" }, async (git, tip) => {
				if (tip === head) return true;
				try { await git("cat-file", "-e", `${head}^{commit}`); } catch { return false; }
				try { await git("merge-base", "--is-ancestor", head, tip); return true; } catch (error) {
					if ((error as { code?: unknown }).code === 1) return false;
					throw refusal(`sb: git could not compare ${head.slice(0, 12)} with the tip of ${base}: ${firstLine(error)}`);
				}
			});
		} catch (error) {
			// The remote could not be reached or would not let the server in (its git has no credential helper, RR3-F002): the boss's 0.77.2 rule receives the car unchecked and says why.
			const reach = (error as { reach?: string }).reach;
			if (reach) {
				this.d.log?.("cars-received-unchecked", { project, car: label.slice(0, 40), reason: reach });
				return { unchecked: `the server could not reach the project's remote${hostOf(url) ? ` at ${hostOf(url)}` : ""} (${reach}: ${(error as Error).message.replace(/^sb: /, "").slice(0, 200)}), so whether head ${head.slice(0, 12)} is on ${base} already was not checked` };
			}
			const word = `sb: car ${label} is not received: whether its head ${head.slice(0, 12)} is on ${base} of the project's remote already could not be checked (${(error as Error).message.replace(/^sb: /, "").slice(0, 300)}). A car that is on the base is never received again, so the check has to run: try again`;
			this.d.log?.("cars-received-refused", { project, car: label.slice(0, 40), reason: word.slice(0, 200) });
			throw refusal(word);
		}
		if (on) throw refusal(landedWord(label, head, `is on ${base} of the project's remote already`));
		return {};
	}
	/** Where a car of `app` lands, read now and from nothing the book holds: the remote of the checkout of the session's workspace (its own folder when the workspace has none) and the app's `integration.base` in that checkout's apps.json. `unread` when the remote cannot be read, `refused` (why) when the remote is read and the base is not there or not usable. */
	private async baseOf(look: Look, app: string): Promise<{ url: string; base: string } | { unread: true } | { refused: string }> {
		let checkout: string | undefined;
		try { checkout = await this.d.checkoutOf?.(look); } catch { checkout = undefined; }
		checkout ??= look.cwd;
		const url = await this.remoteOf(checkout);
		if (!checkout || !url) return { unread: true };
		const apps = readApps(checkout), entry = apps.ok ? apps.apps.find((a) => a.name === app) : undefined;
		if (!apps.ok) return { refused: "the apps.json of the integrator's workspace checkout cannot be read" };
		if (!entry) return { refused: `the apps.json of the integrator's workspace checkout names no app ${app}` };
		const base = isObject(entry.integration) ? entry.integration.base : undefined;
		if (typeof base !== "string" || !BASE_RE.test(base) || base.includes("..")) return { refused: `app ${app} names no usable integration.base in the apps.json of the integrator's workspace checkout` };
		return { url, base };
	}
	/**
	 * The base's branch of a remote, fetched for one check and removed after it: the steps the comment of `landed` gives, which the check at `received` shares. `answer` gets git in the mirror and the tip `ls-remote` read; the mirror is inspected once more after it
	 * answered. `key` names the mirror's one ref, and `state` the state the refusals speak of.
	 */
	private async withBase<T>(o: { project: string; url: string; base: string; key: string; state: "landed" | "received" }, answer: (git: (...args: string[]) => Promise<string>, tip: string) => Promise<T>): Promise<T> {
		const { project, url, base, key: code, state } = o;
		let work: string | undefined, mirror = "", hosts = "";
		try {
			mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
			work = mkdtempSync(join(this.d.dir, "cars-mirror-"));
			mirror = join(work, "repo");
			mkdirSync(mirror, { mode: 0o700 });
			hosts = join(work, "known_hosts");
			writeFileSync(hosts, this.d.knownHosts ?? "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			this.dropMirror(work);
			throw refusal(`sb: the server's mirror for project ${project} cannot be made: ${firstLine(error)}`);
		}
		const env = { GIT_SSH_COMMAND: sshCommand(hosts), GIT_ALLOW_PROTOCOL: "https:ssh" };
		const ref = `refs/heads/${base}`, mine = `refs/sb/base/${code}`;
		const tampered = (problems: string[]) => refusal(`sb: the mirror the server made for this check was written to by something else (${problems.slice(0, 4).join(", ")}); ${state} is not accepted from it. Check again`);
		try {
			// The tip, from no repository: git reads no repository configuration there.
			let listed: string;
			try { listed = await this.d.git(parse(this.d.dir).root, [...REMOTE_FLAGS, "ls-remote", "--exit-code", "--", url, ref], env); } catch (error) { const line = firstLine(error); throw unreached(`sb: git ls-remote of ${base} from the project's remote failed: ${line}`, line); }
			const tip = listed.split("\n").map((l) => l.split("\t")).find(([, name]) => name === ref)?.[0];
			if (!tip || !/^[0-9a-f]{40,64}$/.test(tip)) throw refusal(`sb: the project's remote lists no branch ${base}`);
			try { await this.d.git(mirror, ["init", "--bare", "-q", "--template=", "."]); } catch (error) { throw refusal(`sb: the server's mirror for project ${project} cannot be made: ${firstLine(error)}`); }
			const inMirror = (...args: string[]) => this.d.git(mirror, ["--git-dir", mirror, ...MIRROR_FLAGS, ...args], env);
			const fresh = inspectMirror(mirror, code, "init");
			if (fresh.problems.length) throw tampered(fresh.problems);
			try { await inMirror(...REMOTE_FLAGS, ...FETCH_FLAGS, "fetch", "--no-tags", "--no-recurse-submodules", "--", url, `+${ref}:${mine}`); } catch (error) {
				const line = firstLine(error);
				// A fetch that failed as unreachable may have been made to fail by a rewritten mirror (an `insteadOf` in its config): that is a tampered mirror, refused, not a remote out of reach (R0772-F001).
				if (reachClass(line)) { const moved = mirrorMoved(mirror, fresh.look); if (moved.length) throw tampered(moved); }
				throw unreached(`sb: git fetch of ${base} from the project's remote failed: ${line}`, line);
			}
			const fetched = inspectMirror(mirror, code, "fetch", fresh.look);
			if (fetched.problems.length) throw tampered(fetched.problems);
			const got = (await inMirror("rev-parse", "--verify", "-q", mine)).trim();
			if (got !== tip) throw refusal(`sb: the fetch brought ${got.slice(0, 12)} as the tip of ${base}, but ls-remote read ${tip.slice(0, 12)} (the branch moved between the two, or the fetch was served from another repository); ${state} is not accepted. Check again`);
			const out = await answer(inMirror, tip);
			const after = inspectMirror(mirror, code, "check", fetched.look);
			if (after.problems.length) throw tampered(after.problems);
			return out;
		} finally { this.dropMirror(work); }
	}
	/** Removes the mirror this server made. `rmSync` unlinks a symlink where the folder was, it never follows one out. */
	private dropMirror(mirror: string | undefined): void {
		if (!mirror) return;
		// A train writing into the folder while it goes can make the removal fail (ENOTEMPTY, EBUSY): a few tries with a short wait, then `cars-mirror-left` (RR3-F003).
		let last: unknown;
		for (let i = 0; i < 5; i++) {
			try { rmSync(mirror, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); return; } catch (error) { last = error; }
		}
		this.d.log?.("cars-mirror-left", { folder: mirror, error: (last as Error).message.slice(0, 200) });
	}
}
