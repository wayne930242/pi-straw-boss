import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CarBook } from "../src/server/carbook.ts";
import { noticeSatisfied } from "../src/train/cars.ts";
import { type CarCtx, type CarParams, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { cleanup, forwardEntry } from "./train-guard-rig.ts";
import { CODE, SHA_A, SHA_B } from "./train-fixtures.ts";
import { carWorld, type CarWorld, COORD, git, INTEG, repo, startOf, TRAIN } from "./train-car-rig.ts";

// What the car book trusts (docs/specs/2026-11-07-train-workers.md §24; todo #125 task 5a fix round, CR-F001 to CR-F003). The train's shell is the same user as pi and the server: it can open the control socket, name any session, pid and pane, and write any file of
// the state folder. These tests play that shell as a raw client of the socket handler, and assert that nothing the guard or the integrator relies on follows from what it says.

const worlds: CarWorld[] = [];
const world = () => (worlds.push(carWorld()), worlds.at(-1)!);
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

const integratorDeps = (w: CarWorld): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root });
const integratorCtx = (...entries: unknown[]): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => entries } });
const received = { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" } satisfies CarParams;
const receive = async (w: CarWorld) => { w.forwarded(); return trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))); };
type Reply = { ok: boolean; error?: string; [k: string]: unknown } | undefined;
/** A raw client of the socket handler: the shell names the pi's session, pid and pane (it can read all three), and the start time when it chooses to. */
const register = (w: CarWorld, session: string, pid: number, pane: string, started?: string): Promise<Reply> => w.call({ cmd: "cars-register", session, pid, pane, ...(started !== undefined ? { started } : {}) });
const rawSet = (w: CarWorld, secret: unknown, state: string, car: Record<string, unknown>, fields: Record<string, unknown> = {}): Promise<Reply> => w.call({ cmd: "cars-set", secret, state, car, fields });
const states = (w: CarWorld) => w.book.read("acme").flatMap((v) => v.file.states.map((s) => `${v.file.car.tickets[0]}:${s.state}`));
const SECOND_INTEG = "sess-integ-2";

// ---- CR-F001: nothing rests on a caller's claim

test("CR-F001: a shell that names the pi's session, pid and pane cannot take the pi's registration, with the start time or without it", async () => {
	const w = world();
	w.forwarded();
	await w.integ.ensure();
	const bare = await register(w, INTEG, 111, "wA:p1");
	assert.equal(bare?.ok, false, "no start time: refused (it used to replace the pi's secret)");
	assert.match(String(bare?.error), /start time/);
	const stolen = await register(w, INTEG, 111, "wA:p1", startOf(111));
	assert.equal(stolen?.ok, false, "the start time is readable from ps, so it proves nothing: a live registration is not replaced");
	assert.match(String(stolen?.error), /already registered to a live process/);
	// The pi's own secret still works.
	const out = await trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD)));
	assert.match(out.text, /^Car T-15 is received/);
});

test("CR-F001: a registration is refused without a start time that matches the process, and a pi that ended is replaced by the next one", async () => {
	const w = world();
	for (const started of [undefined, "", "start-999"]) assert.equal((await register(w, INTEG, 111, "wA:p1", started))?.ok, false, String(started));
	const first = await register(w, INTEG, 111, "wA:p1", startOf(111));
	assert.equal(first?.ok, true);
	// The pi ended and another started in the same pane: the old registration is not live any more.
	w.looks.set(INTEG, { ...w.looks.get(INTEG)!, foreground: [333] });
	const next = await register(w, INTEG, 333, "wA:p1", startOf(333));
	assert.equal(next?.ok, true);
	assert.notEqual(next?.secret, first?.secret);
});

test("CR-F001: the car's identity is the forwarded slip's, not the caller's: tickets, branch and app claimed by a raw client change nothing, a mismatch is refused", async () => {
	const w = world();
	w.forwarded();
	const secret = (await register(w, INTEG, 111, "wA:p1", startOf(111)))?.secret;
	const claim = { project: "acme", app: "web", head: SHA_A, tickets: ["T-99"], branch: "evil", coordinator: COORD };
	const wrong = await rawSet(w, secret, "received", claim, { train: CODE, departs: "now" });
	assert.equal(wrong?.ok, false);
	assert.match(String(wrong?.error), /does not match the forwarded slip/);
	assert.deepEqual(states(w), []);
	// The head alone is enough: the rest is read from the forward the server recorded.
	const right = await rawSet(w, secret, "received", { project: "acme", head: SHA_A }, { train: CODE, departs: "now" });
	assert.equal(right?.ok, true, String(right?.error));
	const file = w.book.read("acme")[0]!.file;
	assert.deepEqual([file.app, file.car.tickets, file.car.branch, file.coordinator], ["web", ["T-15"], "fix/t-15", COORD]);
});

test("CR-F001: a shell that registers as the train before its pi does sets nothing the guard relies on: a car outside the manifest, a commit off the base, a drop or a return of another train's car", async () => {
	const w = world();
	const { local } = repo(w);
	await w.opened("develop", [SHA_B]); // the manifest the server read at the open lists another car, not SHA_A
	await receive(w);
	assert.deepEqual(states(w), ["T-15:received"]);
	const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	assert.ok(shell, "the window exists: nothing but the checks below stands between the shell and the book");
	const evidence = join(w.root, "log.txt");
	w.freeze(evidence);
	const car = { app: "web", head: SHA_A };
	for (const [state, fields] of [["dropped", { round: 1, reason: "x", evidence }], ["returned", { reason: "x" }], ["landed", { version: "1", commit: local }]] as const) {
		const reply = await rawSet(w, shell, state, car, { ...fields });
		assert.equal(reply?.ok, false, state);
		assert.match(String(reply?.error), /is not in the manifest of train/, state);
	}
	assert.deepEqual(states(w), ["T-15:received"], "nothing was added; no notice is pending for a state");
	assert.deepEqual(w.book.pending().map((p) => p.entry.state), ["received"]);
});

test("CR-F001: the integrator's states need the server's own forward: a raw client with the integrator's pid, session and pane gets no state for a head nobody forwarded to it", async () => {
	const w = world();
	const secret = (await register(w, INTEG, 111, "wA:p1", startOf(111)))?.secret;
	for (const state of ["received", "returned"]) {
		const reply = await rawSet(w, secret, state, { project: "acme", head: SHA_A }, state === "received" ? { train: CODE, departs: "next" } : { reason: "x" });
		assert.equal(reply?.ok, false, state);
		assert.match(String(reply?.error), /no forward by a tower carries head/, state);
	}
	assert.deepEqual(states(w), []);
	// A forward to another session is not this one's.
	w.book.noteForward({ fwd: "d".repeat(16), from: COORD, to: [SECOND_INTEG], text: `car: web | tickets: T-15 | branch: fix/t-15 | head: ${SHA_A} | coordinator: ${COORD}` });
	assert.equal((await rawSet(w, secret, "returned", { project: "acme", head: SHA_A }, { reason: "x" }))?.ok, false);
});

// ---- CR-F002: `landed` is the server's own git check

test("CR-F002: landed is checked against the remote the server read at the open, not the origin of the train's clone: a clone pointed at a fake origin holding the commit is not landed", async () => {
	const w = world();
	const { url, pushed, local } = repo(w);
	await w.opened();
	await receive(w);
	// The train rewrites its own clone's origin (and the checkout's) to a repository that holds its commit on `develop`.
	const fake = join(w.root, "fake.git");
	execFileSync("git", ["init", "--bare", "-b", "develop", fake]);
	git(w.work, "push", fake, `${local}:refs/heads/develop`);
	git(w.work, "remote", "set-url", "origin", fake);
	git(w.checkout, "remote", "set-url", "origin", fake);
	const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	const off = await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: local });
	assert.equal(off?.ok, false);
	assert.match(String(off?.error), new RegExp(`landed\\.commit ${local.slice(0, 12)} is not on `));
	assert.equal(w.book.trainOf("acme", CODE)?.url, url, "the remote is the one read before the train existed; a later change of the checkout's config does not reach it");
	const on = await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed });
	assert.equal(on?.ok, true, String(on?.error));
});

test("CR-F002: the check runs no code the train's clone configures: an uploadpack in its config is never run", async () => {
	const w = world();
	const { pushed } = repo(w);
	await w.opened();
	await receive(w);
	const marker = join(w.root, "ran.txt"), script = join(w.root, "uploadpack.sh");
	writeFileSync(script, `#!/bin/sh\necho ran > '${marker}'\nexec git-upload-pack "$@"\n`);
	chmodSync(script, 0o755);
	git(w.work, "config", "remote.origin.uploadpack", script);
	git(w.work, "config", "core.fsmonitor", script);
	git(w.work, "config", "core.sshCommand", script);
	const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	const on = await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed });
	assert.equal(on?.ok, true, String(on?.error));
	assert.equal(existsSync(marker), false, "the server fetched in a repository of its own, whose config the train's clone does not reach");
});

/** A commit-graph file (version 1, SHA-1) that says `tip` has the parent `orphan` and `orphan` has none: what a shell can write by hand, since git does not check a graph against the objects. */
function forgedGraph(tip: { id: string; tree: string }, orphan: { id: string; tree: string }): Buffer {
	const rows = [{ ...tip, parent: orphan.id, gen: 2 }, { ...orphan, parent: undefined, gen: 1 }].sort((a, b) => a.id.localeCompare(b.id));
	const at = (id: string) => rows.findIndex((r) => r.id === id);
	const fan = Buffer.alloc(1024);
	for (let byte = 0; byte < 256; byte++) fan.writeUInt32BE(rows.filter((r) => parseInt(r.id.slice(0, 2), 16) <= byte).length, byte * 4);
	const ids = Buffer.concat(rows.map((r) => Buffer.from(r.id, "hex")));
	const data = Buffer.concat(rows.map((r) => {
		const row = Buffer.alloc(36);
		Buffer.from(r.tree, "hex").copy(row);
		row.writeUInt32BE(r.parent ? at(r.parent) : 0x70000000, 20);
		row.writeUInt32BE(0x70000000, 24);
		row.writeUInt32BE(r.gen << 2, 28);
		row.writeUInt32BE(1, 32);
		return row;
	}));
	const chunks: [string, Buffer][] = [["OIDF", fan], ["OIDL", ids], ["CDAT", data]];
	const table = Buffer.alloc(12 * (chunks.length + 1));
	let offset = 8 + table.length;
	chunks.forEach(([name, body], i) => { table.write(name, i * 12, "latin1"); table.writeBigUInt64BE(BigInt(offset), i * 12 + 4); offset += body.length; });
	table.writeBigUInt64BE(BigInt(offset), chunks.length * 12 + 4);
	const body = Buffer.concat([Buffer.from([0x43, 0x47, 0x50, 0x48, 1, 1, chunks.length, 0]), table, ...chunks.map(([, b]) => b)]);
	return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

/** What a train that shares the server's uid can put where the old persistent mirror lived (`<server folder>/cars-mirror/<project>`): the commit `local` (on no remote), and either the real tip's id holding a commit whose parent is `local`, or a commit-graph that says so. */
function plantMirror(w: CarWorld, graph: boolean) {
	const { pushed, local } = repo(w);
	const old = join(w.dir, "cars-mirror", "acme");
	mkdirSync(join(w.dir, "cars-mirror"), { recursive: true });
	execFileSync("git", ["init", "--bare", "-q", old]);
	git(w.work, "push", "-q", old, `${local}:refs/heads/orphan`);
	if (graph) {
		mkdirSync(join(old, "objects", "info"), { recursive: true });
		writeFileSync(join(old, "objects", "info", "commit-graph"), forgedGraph({ id: pushed, tree: git(w.work, "rev-parse", `${pushed}^{tree}`) }, { id: local, tree: git(w.work, "rev-parse", `${local}^{tree}`) }));
		return { old, pushed, local };
	}
	const genuine = git(w.work, "cat-file", "commit", pushed);
	const forged = execFileSync("git", ["-C", old, "hash-object", "-t", "commit", "-w", "--stdin"], { input: `${genuine.replace(/^(tree .*\n)(?:parent .*\n)*/, `$1parent ${local}\n`)}\n`, encoding: "utf8" }).trim();
	const loose = (id: string) => join(old, "objects", id.slice(0, 2), id.slice(2));
	rmSync(loose(pushed), { force: true });
	copyFileSync(loose(forged), loose(pushed));
	return { old, pushed, local };
}

for (const graph of [false, true]) {
	test(`RR-F001: ${graph ? "a planted commit-graph" : "a planted object under the real tip's id with a forged parent"} where the old mirror lived makes no orphan commit land; a real ancestor lands`, async () => {
		const w = world();
		const { pushed, local } = plantMirror(w, graph);
		await w.opened();
		await receive(w);
		const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
		const forged = await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: local });
		assert.equal(forged?.ok, false, "the orphan commit is not on the base");
		assert.match(String(forged?.error), new RegExp(`landed\\.commit ${local.slice(0, 12)} is not on develop`));
		assert.equal((await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed }))?.ok, true, "a commit that is on the base lands");
	});
}

test("RR-F001/RR-F004: each landed check fetches into a mirror made then, mode 700, with the commit-graph and gc off, and removes it, whatever the answer; a mirror swapped for a symlink is unlinked, never followed", async () => {
	const w = world();
	const { pushed, local } = repo(w);
	await w.opened();
	await receive(w);
	const victim = join(w.root, "victim");
	mkdirSync(victim);
	writeFileSync(join(victim, "keep.txt"), "keep");
	const seen: { dir: string; mode: number; args: string[] }[] = [];
	const real = w.deps.git;
	let swap = false;
	w.deps.git = async (cwd: string, args: string[]) => {
		const gitDir = args[args.indexOf("--git-dir") + 1];
		if (args.includes("fetch") && gitDir) seen.push({ dir: gitDir, mode: statSync(gitDir).mode & 0o777, args });
		const out = await real(cwd, args);
		if (swap && args.includes("merge-base") && gitDir) { rmSync(gitDir, { recursive: true, force: true }); symlinkSync(victim, gitDir); }
		return out;
	};
	const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	assert.equal((await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: local }))?.ok, false);
	assert.equal((await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed }))?.ok, true);
	swap = true;
	// The folder is swapped for a symlink to the train's folder after the check ran its git: the check sees a mirror that is not the one it made and refuses (RR2-F001), and removing it unlinks the link.
	const swapped = await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed });
	assert.equal(swapped?.ok, false);
	assert.match(String(swapped?.error), /mirror/);
	assert.equal(seen.length, 3);
	assert.notEqual(seen[0]!.dir, seen[1]!.dir, "a fresh mirror for each check");
	for (const s of seen) {
		assert.equal(s.mode, 0o700);
		assert.ok(s.dir.startsWith(w.dir + sep), "under the server's folder");
		for (const flag of ["core.commitGraph=false", "fetch.writeCommitGraph=false", "gc.auto=0", "core.multiPackIndex=false"]) assert.ok(s.args.includes(flag), flag);
		assert.equal(existsSync(s.dir), false, "removed after the check");
	}
	assert.deepEqual(readdirSync(w.dir).filter((n) => n.startsWith("cars-mirror")), []);
	assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "keep", "the symlink was removed, not followed");
});

test("CR-F002: a remote that changes between two opens of one server refuses the later train's landed with a word, and a remote that is no safe URL is never fetched", async () => {
	const w = world();
	const { pushed, remote } = repo(w);
	await w.opened();
	// The first train rewrites the shared config before the next open (git in this world reads that URL from the same repository, so the check at received passes and landed meets the changed remote).
	git(w.checkout, "remote", "set-url", "origin", "https://elsewhere.example.test/acme.git");
	w.rewrites.push(["https://elsewhere.example.test/acme.git", remote]);
	w.book.noteTrain({ project: "acme", code: "2026-11-06-n", session: "sess-train-2", pane: "wA:p3", integrator: INTEG, base: "develop", heads: [SHA_B], url: await w.book.remoteOf(w.checkout) });
	assert.equal(w.book.trainOf("acme", "2026-11-06-n")?.url, "https://elsewhere.example.test/acme.git");
	w.looks.set("sess-train-2", { id: "sess-train-2", name: "train n", role: "train", train: { project: "acme", code: "2026-11-06-n" }, pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [333] });
	const second = (await register(w, "sess-train-2", 333, "wA:p3", startOf(333)))?.secret;
	const integ = (await register(w, INTEG, 111, "wA:p1", startOf(111)))?.secret;
	const slip = `car: web | tickets: T-16 | branch: fix/t-16 | head: ${SHA_B} | coordinator: ${COORD}`;
	w.book.noteForward({ fwd: "c".repeat(16), from: COORD, to: [INTEG], text: slip });
	assert.equal((await rawSet(w, integ, "received", { project: "acme", head: SHA_B }, { train: "2026-11-06-n", departs: "next" }))?.ok, true);
	const reply = await rawSet(w, second, "landed", { app: "web", head: SHA_B }, { version: "1", commit: pushed });
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /remote of project acme changed/);
	for (const url of ["--upload-pack=x", "ext::sh -c id", "fd::3", ""]) {
		const w2 = world();
		repo(w2);
		git(w2.checkout, "config", "remote.origin.url", url || " ");
		await w2.opened();
		assert.equal(w2.book.trainOf("acme", CODE)?.url, undefined, `unsafe url ${JSON.stringify(url)} is not kept`);
	}
});

test("RR-F002: a remote git reads as a path on this computer, or by any transport but https and ssh, is no remote: the open notes the train without one and landed is refused; https, ssh and scp-like remotes are kept", async () => {
	const w = world();
	const { pushed } = repo(w);
	const remoteOf = async (url: string) => { git(w.checkout, "config", "remote.origin.url", url); return w.book.remoteOf(w.checkout); };
	for (const url of ["/tmp/evil.git", "/", "./evil.git", "../evil.git", "evil.git", "~/evil.git", "~user/evil.git", "x:y", "evil:evil.git", "c:/evil.git", "//host/share/evil.git", "file:///tmp/evil.git", "file://localhost/tmp/evil.git", "FILE:///tmp/evil.git", "git://host/acme.git", "http://host/acme.git", "ext::sh -c id", "fd::3", "https:///evil.git", "https://-oProxyCommand=x/a.git", "ssh://-oProxyCommand=x/a.git", "-oProxyCommand=x@host:a.git", "git@-host:a.git", "git@host:a git", `https://host/${"a".repeat(500)}`]) assert.equal(await remoteOf(url), undefined, JSON.stringify(url));
	for (const url of ["https://git.example.test/acme.git", "https://user@git.example.test:8443/acme.git", "ssh://git@git.example.test/acme.git", "ssh://git.example.test:2222/acme.git", "git@git.example.test:acme/acme.git"]) assert.equal(await remoteOf(url), url, url);
	// The open: the checkout a train rewrote before a restart names a repository it controls.
	for (const evil of ["/tmp/evil.git", "file:///tmp/evil.git", "./evil.git"]) {
		const w2 = world();
		repo(w2);
		git(w2.checkout, "remote", "set-url", "origin", evil);
		await w2.opened();
		assert.equal(w2.book.trainOf("acme", CODE)?.url, undefined, evil);
		await receive(w2);
		const shell = (await register(w2, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
		const reply = await rawSet(w2, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed });
		assert.equal(reply?.ok, false, evil);
		assert.match(String(reply?.error), /remote of project acme was not read/, evil);
	}
});

// ---- RR-F003: a train's right to a car is the one the integrator's receipt gave it

test("RR-F003: a train opened with another train's heads cannot set those cars: the receipt must name this train and come from this train's integrator", async () => {
	const w = world();
	repo(w);
	await w.opened(); // train CODE, heads [SHA_A], integrator INTEG
	await receive(w); // received for train CODE
	const OTHER = "2026-11-06-n";
	w.book.noteTrain({ project: "acme", code: OTHER, session: "sess-train-2", pane: "wA:p3", integrator: INTEG, base: "develop", heads: [SHA_A], url: await w.book.remoteOf(w.checkout) });
	w.looks.set("sess-train-2", { id: "sess-train-2", name: "train n", role: "train", train: { project: "acme", code: OTHER }, pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [333] });
	const second = (await register(w, "sess-train-2", 333, "wA:p3", startOf(333)))?.secret;
	const evidence = join(w.root, "log.txt");
	w.freeze(evidence);
	for (const [state, fields] of [["dropped", { round: 1, reason: "x", evidence }], ["returned", { reason: "x" }], ["landed", { version: "1", commit: repo(w).pushed }]] as const) {
		const reply = await rawSet(w, second, state, { app: "web", head: SHA_A }, { ...fields });
		assert.equal(reply?.ok, false, state);
		assert.match(String(reply?.error), new RegExp(`was not received for train ${OTHER}`), state);
	}
	assert.deepEqual(states(w), ["T-15:received"]);
	// The right train still sets it.
	const first = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	assert.equal((await rawSet(w, first, "returned", { app: "web", head: SHA_A }, { reason: "x" }))?.ok, true);
});

test("RR-F003: a receipt by a session that is not the integrator the train was opened for gives the train no right", async () => {
	const w = world();
	repo(w);
	await w.opened("develop", [SHA_A]);
	w.book.noteTrain({ project: "acme", code: "2026-11-06-n", session: "sess-train-2", pane: "wA:p3", integrator: SECOND_INTEG, base: "develop", heads: [SHA_A] });
	w.looks.set("sess-train-2", { id: "sess-train-2", name: "train n", role: "train", train: { project: "acme", code: "2026-11-06-n" }, pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [333] });
	w.forwarded();
	assert.equal((await trainCar(integratorDeps(w), { ...received, train: "2026-11-06-n" }, integratorCtx(forwardEntry(COORD)))).details !== undefined, true);
	const second = (await register(w, "sess-train-2", 333, "wA:p3", startOf(333)))?.secret;
	const reply = await rawSet(w, second, "returned", { app: "web", head: SHA_A }, { reason: "x" });
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /was not received by this train's integrator/);
});

// ---- CR-F003: nothing read from disk at the start is proof

test("CR-F003: a restart starts with an empty book: planted car files, notice records and cars-book.json prove nothing, and the guard's notice check does not pass", async () => {
	const w = world();
	const { pushed } = repo(w);
	await w.opened();
	await receive(w);
	const shell = (await register(w, TRAIN, 222, "wA:p2", startOf(222)))?.secret;
	assert.equal((await rawSet(w, shell, "landed", { app: "web", head: SHA_A }, { version: "1", commit: pushed }))?.ok, true);
	// The state is told (the sender's record), then the train plants more of the same kind by hand.
	const cars = join(w.stateDir, "trainboard", "acme", "cars"), name = `web-${SHA_A.slice(0, 12)}.json`;
	const file = JSON.parse(readFileSync(join(cars, name), "utf8"));
	writeFileSync(join(cars, name.replace("a", "b")), `${JSON.stringify({ ...file, app: "web", car: { ...file.car, head: SHA_B, tickets: ["T-77"] }, coordinator: COORD })}\n`);
	writeFileSync(join(cars, name.replace(".json", ".notice.json")), `${JSON.stringify({ v: 1, states: { received: { attempts: [], deliveredAt: "2026-11-07T08:00:00.000Z" }, landed: { attempts: [], deliveredAt: "2026-11-07T08:00:00.000Z" } } })}\n`);
	writeFileSync(join(w.dir, "cars-book.json"), `${JSON.stringify({ v: 1, forwards: [{ fwd: "f".repeat(16), from: COORD, to: [INTEG], heads: [SHA_A], at: w.now() }], trains: [{ project: "acme", code: CODE, session: TRAIN, pane: "wA:p2", integrator: INTEG, base: "develop", at: "2026-11-07T08:00:00.000Z" }] })}\n`);
	const again = new CarBook({ ...w.deps, secret: () => "secret-restart" } as never);
	assert.deepEqual(again.read("acme"), [], "no car from disk");
	assert.deepEqual(again.pending(), [], "nothing from disk is sent");
	assert.equal(again.forwardOf(SHA_A, INTEG), undefined);
	assert.equal(again.trainOf("acme", CODE), undefined);
	assert.notDeepEqual(noticeSatisfied(again.read("acme"), ["T-15"], "landed"), [], "the land step does not pass on what the disk says");
	assert.notDeepEqual(noticeSatisfied(again.read("acme"), ["T-77"], "landed"), []);
});

test("CR-F003: after a restart the train is unknown to the server until the tower opens it again: its register works but its states are refused", async () => {
	const w = world();
	const { pushed } = repo(w);
	await w.opened();
	await receive(w);
	const book = new CarBook({ ...w.deps, secret: () => "secret-restart" } as never);
	const shell = await book.register({ session: TRAIN, pid: 222, started: startOf(222), pane: "wA:p2" });
	await assert.rejects(book.set({ secret: shell.secret, state: "landed", car: { app: "web", head: SHA_A }, fields: { version: "1", commit: pushed } }), /this server did not open train/);
});

// ---- todo #154: a restart is told, not undone

test("todo #154: after a restart the integrator's refusal names the server's start, says forwards are kept in memory only and names the way back; nothing on disk restores the forward, the tower's new forward does, and a server up longer than a forward is kept says none of it", async () => {
	const w = world();
	w.forwarded();
	// The server starts again 8 minutes after the tower's forward (the live case: forwarded 06:33:46Z, restarted 06:41:25Z).
	w.tick(8 * 60_000);
	const started = new Date(w.now()).toISOString();
	const again = new CarBook({ ...w.deps, secret: () => "secret-restart" } as never);
	const integ = await again.register({ session: INTEG, pid: 111, started: startOf(111), pane: "wA:p1" });
	const returned = (book: CarBook, head: string) => book.set({ secret: integ.secret, state: "returned", car: { project: "acme", head }, fields: { reason: "no accept" } });
	w.tick(60_000);
	const refusal = await returned(again, SHA_A).then(() => "", (e: Error) => e.message);
	assert.ok(refusal.startsWith(`sb: no forward by a tower carries head ${SHA_A.slice(0, 12)} to this session`), refusal);
	assert.ok(refusal.includes(`The sb server started at ${started} and keeps a tower's forwards in memory only, so a forward made before that is gone with the restart`), refusal);
	assert.ok(refusal.includes("ask the car's coordinator to send its slip to the tower again (call_tower why=shared); the tower forwards it again, and then the state is set"), refusal);
	assert.deepEqual(again.read("acme"), [], "the refusal set nothing");
	// The way back is the fact itself: the tower's forward to this server.
	again.noteForward({ fwd: "f".repeat(16), from: COORD, to: [INTEG], text: `car: web | tickets: T-15 | branch: fix/t-15 | head: ${SHA_A} | coordinator: ${COORD}` });
	assert.equal((await returned(again, SHA_A)).state, "returned");
	// The start the server itself gives the book (main.ts) is the one told, not the moment the book was made.
	const given = new CarBook({ ...w.deps, secret: () => "secret-given", startedAt: Date.parse("2026-11-07T08:05:00Z") } as never);
	const second = await given.register({ session: INTEG, pid: 111, started: startOf(111), pane: "wA:p1" });
	await assert.rejects(given.set({ secret: second.secret, state: "returned", car: { project: "acme", head: SHA_A }, fields: { reason: "x" } }), /The sb server started at 2026-11-07T08:05:00\.000Z and keeps/);
	// A day after the start no forward made before it would still count, so the refusal is the plain one.
	w.tick(24 * 3600_000);
	const late = await returned(again, SHA_B).then(() => "", (e: Error) => e.message);
	assert.ok(late.startsWith(`sb: no forward by a tower carries head ${SHA_B.slice(0, 12)} to this session`), late);
	assert.doesNotMatch(late, /sb server started|memory only/);
});

// ---- P2: cars-read is bounded

test("CR-F004: cars-read takes a registered session and returns only its own: a raw client with no secret gets none, a train sees its manifest's cars, another integrator sees nothing", async () => {
	const w = world();
	repo(w);
	await w.opened();
	await receive(w);
	assert.equal((await w.call({ cmd: "cars-read", project: "acme" }))?.ok, false, "no secret");
	assert.equal((await w.call({ cmd: "cars-read", project: "acme", secret: "made-up" }))?.ok, false);
	assert.equal((await w.integ.read("acme")).length, 1);
	assert.equal((await w.train.read("acme")).length, 1);
	await assert.rejects(w.train.read("other"), /works for project acme/);
	w.looks.set(SECOND_INTEG, { id: SECOND_INTEG, name: "integ other", role: "main", pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [444] });
	assert.deepEqual(await w.client(SECOND_INTEG, 444, "wA:p3").read("acme"), [], "a main that was forwarded none of these cars sees none");
});

// ---- what the open reads, and when

test("the open's facts are read before the train exists: a checkout or manifest changed during or after the open does not change what the server holds; a repeated open adds no remote", async () => {
	const { noteTrains } = await import("../src/server/trainnote.ts");
	const w = world();
	const { url: remote } = repo(w);
	const manifest = `train:\n  project: acme\n  app: web\n  code: ${CODE}\n  base: develop\n\n${"car: web | tickets: T-15 | branch: fix/t-15 | head: " + SHA_A}\n`;
	const errors: string[] = [];
	let opens = 0;
	const open = async () => {
		opens++;
		// The train starts: its first act rewrites the shared config, and the manifest it was handed is edited in its own copy.
		git(w.checkout, "remote", "set-url", "origin", "https://evil.example.test/acme.git");
		return { tab: "t", pane: "wA:p2", main: TRAIN, sender: INTEG, train: { project: "acme", code: CODE }, ...(opens > 1 ? { repeated: true as const } : {}) };
	};
	const opener = noteTrains(open as never, { cars: w.book, checkout: async () => w.checkout, error: (what, message) => void errors.push(`${what}: ${message}`) });
	await opener({ request: manifest, sender: INTEG, role: "train" });
	let record = w.book.trainOf("acme", CODE)!;
	assert.deepEqual([record.url, record.base, record.heads, errors], [remote, "develop", [SHA_A], []]);
	await opener({ request: manifest.replace(SHA_A, SHA_B), sender: INTEG, role: "train" }); // repeated: the book keeps the first note
	record = w.book.trainOf("acme", CODE)!;
	assert.deepEqual([record.url, record.heads], [remote, [SHA_A]]);
	// After a restart the repeated open is noted without a remote (the checkout may have been changed by the train meanwhile).
	const fresh = new CarBook({ ...w.deps } as never);
	await noteTrains(open as never, { cars: fresh, checkout: async () => w.checkout, error: () => undefined })({ request: manifest, sender: INTEG, role: "train" });
	assert.equal(fresh.trainOf("acme", CODE)?.url, undefined);
	assert.deepEqual(fresh.trainOf("acme", CODE)?.heads, [SHA_A]);
	// A main's open notes nothing.
	const other = new CarBook({ ...w.deps } as never);
	await noteTrains(open as never, { cars: other, checkout: async () => w.checkout, error: () => undefined })({ request: manifest, sender: INTEG });
	assert.equal(other.trainOf("acme", CODE), undefined);
});
