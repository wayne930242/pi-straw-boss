import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { safeUrl, sshCommand } from "../src/server/carbook.ts";
import { gitDeadline, runGit } from "../src/server/carops.ts";
import { forwardEntry, cleanup } from "./train-guard-rig.ts";
import { CODE, SHA_A } from "./train-fixtures.ts";
import { type CarWorld, carWorld, COORD, git, INTEG, PUBLIC_URL, repo, startOf, TRAIN } from "./train-car-rig.ts";
import { type CarCtx, type CarParams, type CarToolDeps, trainCar } from "../src/traincar.ts";

// The `landed` check against a train that shares the server's uid (docs/specs/2026-11-07-train-workers.md §24; todo #125 task 5a fix round 3, RR2-F001 to RR2-F003). The train's shell writes into the fresh mirror while the check runs, rewrites the fetch through the repository's
// configuration, plants objects, or makes ssh reach this computer. These tests play it from inside the check: a hook on the server's git seam runs the train's write at the moment a watcher would.

const worlds: CarWorld[] = [];
const world = () => (worlds.push(carWorld()), worlds.at(-1)!);
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

type Reply = { ok: boolean; error?: string; [k: string]: unknown } | undefined;
const integratorDeps = (w: CarWorld): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root });
const integratorCtx = (...entries: unknown[]): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => entries } });
const received = { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" } satisfies CarParams;
const receive = async (w: CarWorld) => { w.forwarded(); return trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))); };
const register = (w: CarWorld, session: string, pid: number, pane: string, started?: string): Promise<Reply> => w.call({ cmd: "cars-register", session, pid, pane, ...(started !== undefined ? { started } : {}) });
const landed = (w: CarWorld, secret: unknown, commit: string): Promise<Reply> => w.call({ cmd: "cars-set", secret, state: "landed", car: { app: "web", head: SHA_A }, fields: { version: "1", commit } });
const states = (w: CarWorld) => w.book.read("acme").flatMap((v) => v.file.states.map((s) => s.state));
/** An opened train with the integrator's receipt and the train's registration: the secret the train's shell uses. */
async function ready(w: CarWorld) {
	const r = repo(w);
	await w.opened();
	await receive(w);
	return { ...r, shell: (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret };
}
/** A repository the train controls, with a commit on `develop` that is on no real remote. */
function evil(w: CarWorld) {
	const bare = join(w.root, "evil.git"), work = join(w.root, "evil-work");
	execFileSync("git", ["init", "--bare", "-b", "develop", bare]);
	execFileSync("git", ["init", "-b", "develop", work]);
	writeFileSync(join(work, "x.txt"), "x");
	git(work, "add", "x.txt");
	git(work, "commit", "-m", "orphan");
	git(work, "push", bare, "HEAD:develop");
	return { bare, orphan: git(work, "rev-parse", "HEAD") };
}
/** Runs `act(cwd)` when git has finished the call whose arguments hold `word`, the way a watcher on the server's folder acts at once. The repository of the call is its cwd. */
function after(w: CarWorld, word: string, act: (mirror: string) => void) {
	const real = w.deps.git;
	let done = false;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => {
		const out = await real(cwd, args, env);
		if (!done && args.includes(word)) { done = true; act(cwd); }
		return out;
	};
}
const mirrors = (w: CarWorld) => readdirSync(w.dir).filter((n) => n.startsWith("cars-mirror"));

// ---- RR2-F001: the fresh mirror is written to while the check runs

test("RR2-F001: a repository config that rewrites the remote to a repository of the train's (planted after init) makes no orphan commit land", async () => {
	const w = world();
	const { shell } = await ready(w);
	const { bare, orphan } = evil(w);
	after(w, "init", (mirror) => appendFileSync(join(mirror, "config"), `[url "${bare}"]\n\tinsteadOf = ${PUBLIC_URL}\n`));
	const reply = await landed(w, shell, orphan);
	assert.equal(reply?.ok, false, "the orphan commit must not land");
	assert.ok(!states(w).includes("landed"));
	assert.deepEqual(mirrors(w), []);
});

test("RR2-F001: the tip the fetch brought must be the tip ls-remote read from no repository: a fetch that is served another repository's branch is refused", async () => {
	const w = world();
	const { shell } = await ready(w);
	const { bare, orphan } = evil(w);
	// Not the mirror's config (the config check is not what catches this): the transport itself gives another answer to the fetch than to ls-remote.
	const real = w.deps.git;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => {
		if (args.includes("fetch")) w.rewrites.splice(0, w.rewrites.length, [PUBLIC_URL, bare]);
		return real(cwd, args, env);
	};
	const reply = await landed(w, shell, orphan);
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /tip/);
	assert.ok(!states(w).includes("landed"));
});

test("RR2-F001: ls-remote reads the tip with no repository: the server's own folder is not its cwd, no GIT_DIR, GIT_CEILING_DIRECTORIES is the root, no --git-dir", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	const calls: { cwd: string; args: string[]; env?: Record<string, string> }[] = [];
	const real = w.deps.git;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => (calls.push({ cwd, args, ...(env ? { env } : {}) }), real(cwd, args, env));
	assert.equal((await landed(w, shell, pushed))?.ok, true);
	const ls = calls.find((c) => c.args.includes("ls-remote"))!;
	assert.ok(ls, "ls-remote ran");
	assert.equal(ls.cwd, "/");
	assert.ok(!ls.args.includes("--git-dir"));
	assert.equal(ls.args.at(-1), "refs/heads/develop");
	assert.ok(calls.indexOf(ls) < calls.findIndex((c) => c.args.includes("init")), "the tip is read before any repository exists");
	const fetch = calls.find((c) => c.args.includes("fetch"))!;
	for (const flag of ["transfer.fsckObjects=true", "fetch.fsckObjects=true", "fetch.unpackLimit=1", "transfer.unpackLimit=1"]) assert.ok(fetch.args.includes(flag), flag);
	const init = calls.find((c) => c.args.includes("init"))!;
	assert.ok(init.args.includes("--template="), "an empty template: no hooks directory");
});

for (const [what, plant] of [
	["a line appended to its config", (m: string) => appendFileSync(join(m, "config"), "[core]\n\tabbrev = 12\n")],
	["an objects/info/alternates file", (m: string) => writeFileSync(join(m, "objects", "info", "alternates"), "/nowhere/objects\n")],
	["an objects/info/http-alternates file", (m: string) => writeFileSync(join(m, "objects", "info", "http-alternates"), "https://nowhere.example.test/objects\n")],
	["a loose object", (m: string) => void execFileSync("git", ["-C", m, "hash-object", "-w", "--stdin"], { input: "planted\n" })],
	["a hooks directory", (m: string) => mkdirSync(join(m, "hooks"))],
	["a pack of its own", (m: string) => { writeFileSync(join(m, "objects", "pack", `pack-${"1".repeat(40)}.pack`), "x"); writeFileSync(join(m, "objects", "pack", `pack-${"1".repeat(40)}.idx`), "x"); }],
	["a commondir file", (m: string) => writeFileSync(join(m, "commondir"), "/nowhere\n")],
	["a ref of its own", (m: string) => { mkdirSync(join(m, "refs", "heads"), { recursive: true }); writeFileSync(join(m, "refs", "heads", "x"), `${"1".repeat(40)}\n`); }],
] as const) {
	for (const when of ["init", "fetch"] as const) {
		test(`RR2-F001: ${what} planted in the mirror after ${when} is refused, and the mirror is removed`, async () => {
			const w = world();
			const { shell, pushed } = await ready(w);
			after(w, when, plant);
			const reply = await landed(w, shell, pushed);
			assert.equal(reply?.ok, false, "even a commit that is on the base is refused when the mirror was written to");
			assert.match(String(reply?.error), /mirror/);
			assert.ok(!states(w).includes("landed"));
			assert.deepEqual(mirrors(w), []);
			// The attack is the only reason: the same commit lands on the next check.
			assert.equal((await landed(w, shell, pushed))?.ok, true);
		});
	}
}

test("RR2-F001: a loose object planted under the real tip's id with a forged parent, after init, cannot make an orphan commit an ancestor of the base", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	const { orphan } = evil(w);
	const forged = (m: string) => {
		execFileSync("git", ["-C", m, "fetch", "-q", join(w.root, "evil.git"), "develop"], { env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } });
		const genuine = git(w.work, "cat-file", "commit", pushed);
		const id = execFileSync("git", ["-C", m, "hash-object", "-t", "commit", "-w", "--stdin"], { input: `${genuine.replace(/^(tree .*\n)(?:parent .*\n)*/, `$1parent ${orphan}\n`)}\n`, encoding: "utf8" }).trim();
		const loose = (x: string) => join(m, "objects", x.slice(0, 2), x.slice(2));
		mkdirSync(join(m, "objects", pushed.slice(0, 2)), { recursive: true });
		execFileSync("cp", [loose(id), loose(pushed)]);
	};
	after(w, "init", forged);
	const reply = await landed(w, shell, orphan);
	assert.equal(reply?.ok, false);
	assert.ok(!states(w).includes("landed"));
});

test("RR3-F001: the answer is taken against the tip id: a ref swapped to an orphan commit (planted loose) between the tip check and the answer, then put back, cannot land it", async () => {
	const w = world();
	const { shell } = await ready(w);
	const { orphan } = evil(w);
	const looseOf = (root: string, id: string) => join(root, "objects", id.slice(0, 2), id.slice(2));
	let ref = "", plantedRef = "";
	after(w, "rev-parse", (m) => {
		ref = join(m, "refs", "sb", "base", CODE);
		plantedRef = readFileSync(ref, "utf8");
		writeFileSync(ref, `${orphan}\n`);
		mkdirSync(join(m, "objects", orphan.slice(0, 2)), { recursive: true });
		execFileSync("cp", [looseOf(join(w.root, "evil.git"), orphan), looseOf(m, orphan)]);
	});
	after(w, "merge-base", (m) => {
		writeFileSync(ref, plantedRef);
		rmSync(join(m, "objects", orphan.slice(0, 2)), { recursive: true, force: true });
	});
	const reply = await landed(w, shell, orphan);
	assert.equal(reply?.ok, false, "an orphan commit must not land by a swapped ref");
	assert.ok(!states(w).includes("landed"));
});

test("RR3-F001: a ref whose value (not its name) changed during the check is refused as the mirror's, even for a commit on the base", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	after(w, "rev-parse", (m) => writeFileSync(join(m, "refs", "sb", "base", CODE), `${"1".repeat(40)}\n`));
	const reply = await landed(w, shell, pushed);
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /mirror/);
	assert.deepEqual(mirrors(w), []);
});

test("RR3-F002: the server's own GIT_DEFAULT_HASH, GIT_ALTERNATE_OBJECT_DIRECTORIES and GIT_CONFIG_COUNT do not reach git: an honest check still lands", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	const keep = { ...process.env };
	Object.assign(process.env, { GIT_DEFAULT_HASH: "sha256", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/nowhere/objects", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.abbrev", GIT_CONFIG_VALUE_0: "12", GIT_TRACE: "/dev/null" });
	try {
		assert.equal((await landed(w, shell, pushed))?.ok, true);
		const out = await runGit(w.root, ["-c", "alias.sbenv=!env", "sbenv"]);
		assert.ok(!/^GIT_(?:DEFAULT_HASH|ALTERNATE_OBJECT|CONFIG_COUNT|CONFIG_KEY|CONFIG_VALUE|TRACE)/m.test(out), out);
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];
		Object.assign(process.env, keep);
	}
});

test("RR2-F001: a fetch that leaves no pack in the mirror (every object gone after it) is refused as the mirror's", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	after(w, "fetch", (m) => { for (const n of readdirSync(join(m, "objects", "pack"))) rmSync(join(m, "objects", "pack", n)); });
	const reply = await landed(w, shell, pushed);
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /mirror/);
});

test("RR2-F001: nothing is planted: a commit on the base lands and the mirror is gone", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	assert.equal((await landed(w, shell, pushed))?.ok, true);
	assert.deepEqual(mirrors(w), []);
});

// ---- RR2-F001/RR2-F002: failed checks are limited, and each refusal is logged

test("RR2-F001: three failed landed checks of one car within ten minutes close it until the window passes; a refusal is logged; another car or train is not limited", async () => {
	const w = world();
	const { shell, pushed, local } = await ready(w);
	let gitCalls = 0;
	const real = w.deps.git;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => (gitCalls++, real(cwd, args, env));
	for (let i = 0; i < 3; i++) { assert.match(String((await landed(w, shell, local))?.error), /is not on develop/); w.tick(60_000); }
	const before = gitCalls;
	const shut = await landed(w, shell, pushed);
	assert.equal(shut?.ok, false, "a commit that is on the base is refused while the car is shut");
	assert.match(String(shut?.error), /too many|rate|retry/i);
	assert.equal(gitCalls, before, "no git runs for a refused check");
	assert.ok(w.logs.some((l) => l.startsWith("cars-landed-refused")), "each refusal is logged");
	assert.ok(w.logs.filter((l) => l.startsWith("cars-landed-refused")).length >= 4, "the three failures and the closed attempt are all logged");
	w.tick(10 * 60_000);
	assert.equal((await landed(w, shell, pushed))?.ok, true, "the window has passed");
});

test("RR2-F001: the window slides: a failure leaves it after ten minutes", async () => {
	const w = world();
	const { shell, pushed, local } = await ready(w);
	for (let i = 0; i < 2; i++) { assert.equal((await landed(w, shell, local))?.ok, false); w.tick(5 * 60_000); }
	// Two failures, the first is now 10 minutes old: it has left the window, so one more failure is the second, not the third.
	assert.match(String((await landed(w, shell, local))?.error), /is not on develop/);
	assert.match(String((await landed(w, shell, local))?.error), /is not on develop/);
	assert.match(String((await landed(w, shell, local))?.error), /too many|rate|retry/i);
	w.tick(10 * 60_000);
	assert.equal((await landed(w, shell, pushed))?.ok, true);
});

// ---- RR2-F002 and RR2-F003: what the server fetches from, and how

test("RR2-F002: a remote on this computer (localhost, loopback, 0.0.0.0, a numeric spelling, this machine's own name) is no remote, nor is a user or path part that begins with a dash", () => {
	const mine = hostname(), short = mine.split(".")[0]!;
	for (const url of [
		"ssh://localhost/tmp/evil.git", "ssh://user@localhost:2222/tmp/evil.git", "a@localhost:/tmp/evil.git", "a@LocalHost:evil.git", "https://localhost/x", "https://LOCALHOST/x", "https://localhost./x", "https://foo.localhost/x", "https://a.b.localhost./x",
		"https://127.0.0.1/x", "https://127.1.2.3:8443/x", "ssh://a@127.0.0.1/x", "a@127.0.0.1:x", "https://127.1/x", "https://2130706433/x", "https://0x7f.0.0.1/x", "https://0177.0.0.1/x", "https://0.0.0.0/x", "https://0/x", "ssh://a@0.0.0.0/x",
		`https://${mine}/x`, `https://${short}/x`, `https://${short}.local/x`, `a@${short}.local:x`, `ssh://a@${mine.toUpperCase()}/x`,
		"ssh://-oProxyCommand=x@host/path", "https://-u@host/x", "-oX@host:path", "a@host:-oProxyCommand=x", "a@host:--upload-pack=x",
	]) assert.equal(safeUrl(url), undefined, JSON.stringify(url));
	// A dash deep in the path is an ordinary path on a real host and is not what RR2-F003 means.
	for (const url of ["https://git.example.test/acme.git", "ssh://git@git.example.test:2222/-x.git", "git@git.example.test:acme/-x.git", "https://git.example.test:8443/a", "https://10.20.30.40/acme.git", "https://a-b.example.test/acme.git"]) assert.equal(safeUrl(url), url, url);
});

test("RR2-F002: the ssh command the server gives git reads no ssh_config (-F /dev/null), no known_hosts but the server's, no proxy, and only the identity files; ssh's own effective options say so", () => {
	const w = world();
	// ssh finds the user's config by the passwd entry, not $HOME, so a config of the test's cannot be planted: what is asserted is the command's text for `-F`, and ssh's reading of the rest.
	const known = join(w.root, "known_hosts");
	const command = sshCommand(known);
	assert.match(command, /^ssh -F (?:\/dev\/null|NUL) /);
	const out = execFileSync("ssh", [...command.replace(/^ssh /, "").split(" "), "-G", "git.example.test"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const opt = (name: string) => new RegExp(`^${name} (.*)$`, "m").exec(out)?.[1];
	assert.equal(opt("hostname"), "git.example.test");
	assert.equal(opt("stricthostkeychecking"), "true");
	assert.equal(opt("batchmode"), "yes");
	assert.ok([undefined, "none"].includes(opt("proxycommand")), "no proxy command");
	assert.ok([undefined, "none"].includes(opt("proxyjump")), "no proxy jump");
	assert.equal(opt("userknownhostsfile"), known);
	assert.equal(opt("globalknownhostsfile"), "/dev/null");
	assert.equal(opt("identitiesonly"), "yes");
	assert.deepEqual(sshCommand(join(w.root, "a b")).includes("'UserKnownHostsFile="), true, "a path with a space is quoted for the shell git runs it in");
});

test("RR2-F002: the transport the server gives git: an ssh command with the server's own known_hosts, https and ssh only, no proxy from the environment; the file is the server's copy, written for each check", async () => {
	const w = world();
	const { shell, pushed } = await ready(w);
	const seen: { args: string[]; env?: Record<string, string>; hosts?: string }[] = [];
	const real = w.deps.git;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => {
		const file = /UserKnownHostsFile=(\S+)/.exec(env?.GIT_SSH_COMMAND ?? "")?.[1];
		seen.push({ args, ...(env ? { env } : {}), ...(file && existsSync(file) ? { hosts: readFileSync(file, "utf8") } : {}) });
		return real(cwd, args, env);
	};
	assert.equal((await landed(w, shell, pushed))?.ok, true);
	for (const call of seen.filter((c) => c.args.includes("ls-remote") || c.args.includes("fetch"))) {
		assert.ok(call.env?.GIT_SSH_COMMAND, "an ssh command");
		assert.equal(call.env.GIT_SSH_COMMAND, sshCommand(/UserKnownHostsFile=(\S+)/.exec(call.env.GIT_SSH_COMMAND)![1]!));
		assert.equal(call.env.GIT_ALLOW_PROTOCOL, "https:ssh");
		assert.equal(call.hosts, w.deps.knownHosts, "the server's copy, written for the check");
		assert.ok(call.args.includes("http.proxy="), "no proxy");
		assert.ok(call.args.includes("http.sslVerify=true"));
	}
	assert.equal(seen.filter((c) => c.env?.GIT_SSH_COMMAND).length >= 2, true);
	assert.deepEqual(mirrors(w), [], "the copy goes with the mirror");
});

test("RR2-F002: git started by the server carries none of the proxy or ssl variables of its environment, and a ceiling at the root of its folder", async () => {
	const w = world();
	const keep = { ...process.env };
	Object.assign(process.env, { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", GIT_SSL_NO_VERIFY: "1", GIT_SSL_CAINFO: "/nowhere", GIT_SSH_COMMAND: "false" });
	try {
		const out = await runGit(w.root, ["-c", "alias.sbenv=!env", "sbenv"], { SB_EXTRA: "1" });
		for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "HTTP_PROXY", "GIT_SSL_NO_VERIFY", "GIT_SSL_CAINFO", "GIT_SSH_COMMAND"]) assert.ok(!new RegExp(`^${name}=`, "m").test(out), name);
		assert.match(out, /^GIT_CEILING_DIRECTORIES=\/$/m);
		assert.match(out, /^SB_EXTRA=1$/m, "what the caller adds is kept");
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];
		Object.assign(process.env, keep);
	}
});

test("a fetch of the base gets 10 minutes, every other git command 60 s (a 135 MB base took 117 s)", () => {
	assert.equal(gitDeadline(["-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--", "https://x/y.git", "+refs/heads/develop:refs/sb/x"]), 10 * 60_000);
	assert.equal(gitDeadline(["ls-remote", "--exit-code", "--", "https://x/y.git", "refs/heads/develop"]), 60_000);
	assert.equal(gitDeadline(["merge-base", "--is-ancestor", "a", "b"]), 60_000);
});
