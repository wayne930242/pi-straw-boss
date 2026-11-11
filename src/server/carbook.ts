import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { carsDir, trainboardDir } from "../train/board.ts";
import { addState, type CarFile, carFileName, type CarState, type CarView, coordinatorWord, emptyCar, headsIn, type NoticeRecord, type Setter, type SlipFacts, slipsInText, type StateEntry, type StateNotice, validateStateFields } from "../train/cars.ts";
import { isCode, isName, isObject, SHA_RE } from "../train/spec.ts";
import { writePrivate } from "../trainboard.ts";

// The server's book of cars (docs/specs/2026-11-07-train-workers.md §5.5, §24; todo #125 task 5a). Every car state is set here, and every check that rests on a state or a notice asks here. The train's shell runs as the same user as pi and this server: it can
// open the control socket, name any session, pid and pane, and write any file under the state folder. Node gives the server no peer credentials of a socket. So no secret and no file proves who a caller is, and nothing the guard or the integrator relies on
// rests on a caller's word. The book holds three kinds of thing:
//   - Facts the server establishes itself. A car's identity (app, tickets, branch, head, coordinator) is read from the slip the tower forwarded, which the tower's code stamped (the forward record, in memory). `landed` is a commit that git finds on the real
//     remote branch of the base: its tip read by `ls-remote` with no repository, then fetched into a repository this server makes for that check alone (inspected, then removed) from a URL the server read at the open. The cars a train may touch are the heads of the manifest the server was handed at the open. A notice is told when the broker answered.
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
export interface SetResult { state: CarState; at: string; file: string; coordinator: string }
interface Held { file: CarFile; notice?: NoticeRecord }

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const iso = (ms: number) => new Date(ms).toISOString();
const noticeName = (name: string) => name.replace(/\.json$/, ".notice.json");
const firstLine = (error: unknown) => String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split("\n")[0]!.slice(0, 200);
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
	private async who(secret: unknown): Promise<{ reg: Registration; setter: Setter; train?: { project: string; code: string } }> {
		const reg = typeof secret === "string" ? this.regs.get(secret) : undefined;
		if (!reg) throw refusal("sb: this request is not from a registered session: a car state is set from the pi session itself with the train_car tool");
		const look = await this.d.look(reg.session);
		if (!look || look.pane !== reg.pane || !look.foreground.includes(reg.pid)) throw refusal(`sb: session ${reg.session} is not the process that registered (it ended or moved)`);
		const role = look.role === "train" ? "train" : look.role === "main" ? "main" : undefined;
		if (!role) throw refusal(`sb: session ${look.name} is neither a train nor a main (its role is ${look.role ?? "none"})`);
		if (role === "train" && !look.train) throw refusal(`sb: session ${look.name} is a train with no train token`);
		// A pane token is Herdr state any process of the user can write: the train is the session this server opened for that code, not the one whose pane says so.
		if (role === "train" && this.trainOf(look.train!.project, look.train!.code)?.session !== reg.session) throw refusal(`sb: this server did not open train ${look.train!.code} of project ${look.train!.project} for session ${reg.session}`);
		return { reg, setter: { role, name: look.name, session: reg.session, ...(look.workspace ? { workspace: look.workspace } : {}) }, ...(look.train ? { train: look.train } : {}) };
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
	 * The cars a registered session may see (`cars-read`): a train sees, in its own project, the cars of its manifest; the integrator sees the cars a tower forwarded to it and the ones it set. The guard asks for nothing else.
	 */
	async readFor(req: { secret: unknown; project: unknown }): Promise<CarView[]> {
		const { setter, train } = await this.who(req.secret);
		if (!isName(req.project)) throw refusal("sb: cars-read needs a project (a path-safe name)");
		const project = req.project;
		let visible: (view: CarView) => boolean;
		if (setter.role === "train") {
			if (project !== train!.project) throw refusal(`sb: this train works for project ${train!.project}, not ${project}`);
			const heads = new Set(this.trainOf(project, train!.code)?.heads ?? []);
			visible = (v) => heads.has(v.file.car.head);
		} else visible = (v) => v.file.states.some((s) => s.by.session === setter.session) || this.forwardOf(v.file.car.head, setter.session) !== undefined;
		return this.read(project).filter(visible);
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
	/** The notice record of one state of one car file, as it is now. */
	noticeOf(project: string, name: string, state: CarState): StateNotice | undefined { return this.cars.get(project)?.get(name)?.notice?.states[state]; }
	/** Changes one notice record (the sender is the only caller) and writes it. */
	updateNotice(project: string, name: string, state: CarState, change: (record: StateNotice) => void): void {
		const held = this.cars.get(project)?.get(name);
		if (!held) return;
		const notice: NoticeRecord = held.notice ?? { v: 1, states: {} };
		const record: StateNotice = notice.states[state] ?? { attempts: [] };
		change(record);
		notice.states[state] = record;
		held.notice = notice;
		this.writeCar(project, name, held);
	}

	// ---- setting a state

	set(req: SetRequest): Promise<SetResult> {
		const run = this.chain.then(() => this.setNow(req));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async setNow(req: SetRequest): Promise<SetResult> {
		const { setter, train } = await this.who(req.secret);
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

		let file: CarFile | undefined, name: string, held: Held | undefined, label: string;
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
			if (file?.states.some((s) => s.state === "received")) throw refusal(`sb: car ${label} is already received${state === "returned" ? "; the integrator returns a car at receipt only" : ""}`);
			if (!slip.coordinator) throw refusal("sb: the slip names no coordinator");
			if (slip.coordinator !== sent.from) {
				const word = coordinatorWord(label, slip.coordinator, sent.from);
				if (state === "received") throw refusal(word);
				// A returned car goes to the session that really sent it, with the word.
				fields.reason = word;
			}
			file ??= emptyCar({ project, app: slip.app, tickets: slip.tickets, branch: slip.branch, head, coordinator: sent.from });
		} else {
			// A train's claim, limited to its own train: the car is one of the manifest the server was handed at the open, and the integrator received it.
			const record = this.trainOf(project, train!.code)!;
			if (!record.heads.includes(head)) throw refusal(`sb: car with head ${head.slice(0, 12)} is not in the manifest of train ${train!.code}: the server read the cars of the manifest at the open, and a train sets only those`);
			held = [...(this.cars.get(project)?.entries() ?? [])].find(([, h]) => h.file.car.head === head)?.[1];
			file = held?.file;
			name = file ? carFileName(file.app, head) : head;
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
		const entry = next.states.at(-1)!, stored: Held = { file: next, ...(held?.notice ? { notice: held.notice } : {}) };
		const forProject = this.cars.get(project) ?? new Map<string, Held>();
		forProject.set(name, stored);
		this.cars.set(project, forProject);
		this.writeCar(project, name, stored);
		this.d.log?.("cars-set", { project, state, car: label.slice(0, 40) });
		queueMicrotask(() => this.d.onChange?.());
		return { state, at: entry.at, file: name, coordinator: next.coordinator };
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
		if (first !== undefined && first !== url) throw refusal(`sb: the remote of project ${project} changed between two opens of this server (${first.slice(0, 120)}, then ${url.slice(0, 120)}); landed is not checked against a remote that moved`);
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
		const tampered = (problems: string[]) => refusal(`sb: the mirror the server made for this check was written to by something else (${problems.slice(0, 4).join(", ")}); landed is not accepted from it. Check again`);
		try {
			// The tip, from no repository: git reads no repository configuration there.
			let listed: string;
			try { listed = await this.d.git(parse(this.d.dir).root, [...REMOTE_FLAGS, "ls-remote", "--exit-code", "--", url, ref], env); } catch (error) { throw refusal(`sb: git ls-remote of ${base} from the project's remote failed: ${firstLine(error)}`); }
			const tip = listed.split("\n").map((l) => l.split("\t")).find(([, name]) => name === ref)?.[0];
			if (!tip || !/^[0-9a-f]{40,64}$/.test(tip)) throw refusal(`sb: the project's remote lists no branch ${base}`);
			try { await this.d.git(mirror, ["init", "--bare", "-q", "--template=", "."]); } catch (error) { throw refusal(`sb: the server's mirror for project ${project} cannot be made: ${firstLine(error)}`); }
			const inMirror = (...args: string[]) => this.d.git(mirror, ["--git-dir", mirror, ...MIRROR_FLAGS, ...args], env);
			const fresh = inspectMirror(mirror, code, "init");
			if (fresh.problems.length) throw tampered(fresh.problems);
			try { await inMirror(...REMOTE_FLAGS, ...FETCH_FLAGS, "fetch", "--no-tags", "--no-recurse-submodules", "--", url, `+${ref}:${mine}`); } catch (error) { throw refusal(`sb: git fetch of ${base} from the project's remote failed: ${firstLine(error)}`); }
			const fetched = inspectMirror(mirror, code, "fetch", fresh.look);
			if (fetched.problems.length) throw tampered(fetched.problems);
			const got = (await inMirror("rev-parse", "--verify", "-q", mine)).trim();
			if (got !== tip) throw refusal(`sb: the fetch brought ${got.slice(0, 12)} as the tip of ${base}, but ls-remote read ${tip.slice(0, 12)} (the branch moved between the two, or the fetch was served from another repository); landed is not accepted. Check again`);
			try { await inMirror("merge-base", "--is-ancestor", commit, tip); } catch { throw refusal(`sb: landed.commit ${commit.slice(0, 12)} is not on ${base} of the project's remote: a car has landed only when its commit is on the base's branch there`); }
			const after = inspectMirror(mirror, code, "check", fetched.look);
			if (after.problems.length) throw tampered(after.problems);
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
