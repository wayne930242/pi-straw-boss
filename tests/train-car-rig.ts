import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarBook, type Look } from "../src/server/carbook.ts";
import { type Cars, carsReply, runGit } from "../src/server/carops.ts";
import { createCarClient } from "../src/traincar.ts";
import { slipBlock } from "./train-guard-rig.ts";
import { CODE, SHA_A } from "./train-fixtures.ts";

// A world for the car book and the `train_car` tool: a book on real folders and real git, the sessions the broker and Herdr would show (`looks`), and clients that reach the book through the same command handler the control socket uses.

export const INTEG = "sess-integ-1", TRAIN = "sess-train-1", COORD = "sess-coord-1", TOWER = "tower-1";
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
/** The start time Herdr's process list would give a pid: the processes of this world start at a time of their own. */
export const startOf = (pid: number) => `start-${pid}`;

export function carWorld() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-car-")));
	// `checkout` is the tower workspace's checkout (where the server reads the project's remote at the open), `work` the train's own clone.
	const stateDir = join(root, "state"), dir = join(root, "server"), work = join(root, "work"), checkout = join(root, "checkout");
	for (const d of [stateDir, dir, work]) mkdirSync(d, { recursive: true });
	let clock = Date.parse("2026-11-07T08:00:00Z");
	const looks = new Map<string, Look>();
	const logs: string[] = [];
	const existing = new Set<string>();
	let counter = 0;
	// The server fetches only from an https, ssh or scp-like remote (never a path on this computer), so the world's remote is `PUBLIC_URL` and git, in this world only, reads it from the bare repository `repo()` made (and is let to use the file transport, which the server's
	// own environment forbids: `GIT_ALLOW_PROTOCOL` is the server's to give, and this world's override is what lets the tests play a train that redirects the fetch to a local repository).
	const rewrites: [string, string][] = [];
	const deps = {
		stateDir, dir, now: () => clock, look: async (id: string) => looks.get(id), git: (cwd: string, args: string[], env?: Record<string, string>) => runGit(cwd, [...rewrites.flatMap(([from, to]) => ["-c", `url.${to}.insteadOf=${from}`]), ...args], { ...env, GIT_ALLOW_PROTOCOL: "https:ssh:file" }), knownHosts: "git.example.test ssh-ed25519 not-a-real-key\n", exists: (p: string) => existing.has(p),
		startOf, secret: () => `secret-${++counter}`, log: (event: string, facts: Record<string, unknown>) => void logs.push(`${event} ${JSON.stringify(facts)}`),
		// The integrator's workspace is the tower's: its checkout is where the check at `received` reads the remote and the app's base (nothing is read while `repo()` and `appBase()` have not made them).
		checkoutOf: async () => checkout,
	};
	const book = new CarBook(deps as never);
	const cars = { book } as Cars;
	/** The control socket's handler, in process. */
	const call = async (request: Record<string, unknown>) => (await carsReply(cars, request as never)) as { ok: boolean; error?: string; [k: string]: unknown } | undefined;
	// The pi of the integrator and the pi of the train, as Herdr lists them.
	looks.set(INTEG, { id: INTEG, name: "integ acme", role: "main", pane: "wA:p1", workspace: "wA", cwd: work, foreground: [111] });
	looks.set(TRAIN, { id: TRAIN, name: "train 1106m", role: "train", train: { project: "acme", code: CODE }, pane: "wA:p2", workspace: "wA", cwd: work, foreground: [222] });
	const client = (session: string, pid: number, pane: string, held = new Map<string, string>()) => createCarClient({ call, session: () => session, pane: () => pane, pid, held, started: startOf });
	return {
		root, stateDir, dir, work, checkout, book, cars, call, looks, logs, existing, client, deps, rewrites,
		integ: client(INTEG, 111, "wA:p1"), train: client(TRAIN, 222, "wA:p2"),
		tick: (ms: number) => void (clock += ms), now: () => clock,
		/** The server opened train CODE for the train session, with its base, on a manifest that lists `heads`; the tower's checkout is read at the open. */
		opened: async (base: string | null = "develop", heads: string[] = [SHA_A]) => { const url = await book.remoteOf(checkout); book.noteTrain({ project: "acme", code: CODE, session: TRAIN, pane: "wA:p2", integrator: INTEG, ...(base ? { base } : {}), heads, ...(url ? { url } : {}) }); },
		/** The tower forwarded this head to the integrator on behalf of `from`. */
		forwarded: (from = COORD, head = SHA_A) => book.noteForward({ fwd: "e".repeat(16), from, to: [INTEG], text: slipBlock({ head }) }),
		done: () => rmSync(root, { recursive: true, force: true }),
		freeze: (path: string) => { writeFileSync(path, "x"); existing.add(path); },
	};
}
export type CarWorld = ReturnType<typeof carWorld>;

/** The remote the tower's checkout names in this world. */
export const PUBLIC_URL = "https://git.example.test/acme.git";
const made = new WeakMap<object, { remote: string; url: string; pushed: string; local: string }>();
function makeRepo(world: CarWorld) {
	const remote = join(world.root, "remote.git"), clone = world.work;
	execFileSync("git", ["init", "--bare", "-b", "develop", remote]);
	execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
	writeFileSync(join(clone, "a.txt"), "a");
	git(clone, "add", "a.txt");
	git(clone, "commit", "-m", "pushed");
	git(clone, "push", "origin", "HEAD:develop");
	const pushed = git(clone, "rev-parse", "HEAD");
	execFileSync("git", ["clone", remote, world.checkout], { stdio: "ignore" });
	git(world.checkout, "remote", "set-url", "origin", PUBLIC_URL);
	world.rewrites.push([PUBLIC_URL, remote]);
	writeFileSync(join(clone, "b.txt"), "b");
	git(clone, "add", "b.txt");
	git(clone, "commit", "-m", "only here");
	// A project with a remote names its apps' base (the server refuses a receipt it cannot check against it, car-forward-F003); `appBase` writes another.
	appBase(world);
	return { remote, url: PUBLIC_URL, pushed, local: git(clone, "rev-parse", "HEAD") };
}

/** The app's base in the apps.json of the tower's checkout (`repo()` first): with it the server checks, at `received`, that the car's head is not on that branch of the remote already. */
export function appBase(world: CarWorld, base = "develop", app = "web") {
	mkdirSync(join(world.checkout, ".straw-boss"), { recursive: true });
	writeFileSync(join(world.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: app, dir: ".", integration: { base } }] }));
}

/**
 * A bare "remote" (`remote`, read by git as `url`), the tower's checkout (its apps.json names `develop` as app web's base) and the train's clone of it, with two commits on `develop` in the train's clone: the first pushed, the second only there. Made once per world; call it before `opened()` so the open reads the remote
 * from the checkout.
 */
export function repo(world: CarWorld) {
	let r = made.get(world);
	if (!r) made.set(world, (r = makeRepo(world)));
	return r;
}
