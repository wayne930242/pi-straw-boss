import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { landedWord } from "../src/train/cars.ts";
import { noteTrains } from "../src/server/trainnote.ts";
import { type CarCtx, type CarParams, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { cleanup, forwardEntry, slipBlock } from "./train-guard-rig.ts";
import { type CarWorld, carWorld, COORD, git, INTEG, PUBLIC_URL, repo, startOf, TRAIN } from "./train-car-rig.ts";
import { CODE } from "./train-fixtures.ts";

// 0.80.2 (R0801-F004): the server's two git checks of a car, for an app that is a git submodule of its project. `received` refuses a head that is on the base already (a car lands once), and `landed` takes a commit only when it is on the base. Both fetched the base from the
// project's remote, where a submodule's commits are on no branch: the receipt of a landed car was let in, and a landed commit was refused. Each case builds a real project whose app `web` is a real submodule with a remote of its own (a bare repository git reads through the
// world's `insteadOf`, as it reads the project's), and goes through the real book with real git.

const worlds: CarWorld[] = [];
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

/** The remote the app's own checkout names in this world. */
const WEB_URL = "https://git.example.test/web.git";
type Reply = { ok: boolean; error?: string; [k: string]: unknown } | undefined;
const integratorDeps = (w: CarWorld): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root });
const integratorCtx = (...entries: unknown[]): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => entries } });
const received = { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" } satisfies CarParams;

/**
 * The world's project (`repo`) with the app `web` as a submodule at `apps/web` of the tower's checkout, and `site` as the project's own app. The submodule's remote has one commit on `develop` (`onBase`); the app's clone has a second that is only there (`head`, the car's)
 * and a third on no branch of any remote (`stray`).
 */
function world() {
	const w = carWorld();
	worlds.push(w);
	const project = repo(w), webRemote = join(w.root, "web-remote.git"), webWork = join(w.root, "web-work"), web = join(w.checkout, "apps", "web");
	const commit = (cwd: string, name: string) => (writeFileSync(join(cwd, name), name), git(cwd, "add", name), git(cwd, "commit", "-qm", name), git(cwd, "rev-parse", "HEAD"));
	execFileSync("git", ["init", "-q", "--bare", "-b", "develop", webRemote]);
	execFileSync("git", ["clone", "-q", webRemote, webWork], { stdio: "ignore" });
	const onBase = commit(webWork, "one");
	git(webWork, "push", "-q", "origin", "HEAD:develop");
	const head = commit(webWork, "two"), stray = (git(webWork, "checkout", "-q", "-b", "stray", onBase), commit(webWork, "aside"));
	git(w.checkout, "-c", "protocol.file.allow=always", "submodule", "add", "-q", webRemote, "apps/web");
	assert.match(readFileSync(join(web, ".git"), "utf8"), /^gitdir: /, "the app's checkout is a submodule of the tower's checkout");
	git(web, "remote", "set-url", "origin", WEB_URL);
	w.rewrites.push([WEB_URL, webRemote]);
	writeFileSync(join(w.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "site", dir: ".", integration: { base: "develop" } }] }));
	// Every git call of the server, as it was made: which remote a check asked is read from here.
	const calls: string[][] = [], real = w.deps.git;
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => (calls.push(args), real(cwd, args, env));
	const asked = (word: string) => calls.filter((args) => args.includes(word)).map((args) => args.find((a) => a.startsWith("https://")));
	const forward = (ticket: string, sha: string, car = "web") => {
		const text = slipBlock({ car, tickets: ticket, head: sha });
		w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
		return integratorCtx(forwardEntry(COORD, text));
	};
	const receive = (ticket: string, sha: string, car = "web") => trainCar(integratorDeps(w), { ...received, car: ticket }, forward(ticket, sha, car));
	return { w, project, web, webRemote, webWork, onBase, head, stray, calls, asked, receive, real };
}
type World = ReturnType<typeof world>;
const onWeb = "the remote of app web's repository";

/** The tower opens train CODE on a manifest of one car of `app` (`web` and the app's head, unless given), through the opener's own note (`noteTrains`): the remotes are read from the tower's checkout before the train exists. Then the integrator receives the car and the train's shell registers. `repeated` is an open the opener's ledger answered. */
async function ridden(x: World, o: { app?: string; head?: string; repeated?: true } = {}) {
	const { w } = x, errors: string[] = [], app = o.app ?? "web", head = o.head ?? x.head;
	const manifest = `train:\n  project: acme\n  app: ${app}\n  code: ${CODE}\n  base: develop\n\ncar: ${app} | tickets: T-15 | branch: fix/t-15 | head: ${head}\n`;
	const open = async () => ({ tab: "t", pane: "wA:p2", main: TRAIN, sender: INTEG, train: { project: "acme", code: CODE }, ...(o.repeated ? { repeated: true } : {}) });
	await noteTrains(open as never, { cars: w.book, checkout: async () => w.checkout, error: (what, message) => void errors.push(`${what}: ${message}`) })({ request: manifest, sender: INTEG, role: "train" });
	assert.deepEqual(errors, []);
	const receipt = (await x.receive("T-15", head, app)).text;
	const shell = (await w.call({ cmd: "cars-register", session: TRAIN, pid: 222, pane: "wA:p2", started: startOf(222) }))?.secret;
	const landed = (commit: string): Promise<Reply> => w.call({ cmd: "cars-set", secret: shell, state: "landed", car: { app, head }, fields: { version: "1", commit } });
	return { landed, receipt };
}
/** An earlier train of this server's life, opened on what the tower's checkout says now. */
const openedBefore = async (w: CarWorld) => w.book.noteTrain({ project: "acme", code: "2026-11-06-a", session: "sess-train-0", pane: "wA:p9", integrator: INTEG, base: "develop", heads: [], url: (await w.book.remoteOf(w.checkout))!, appUrls: await w.book.appRemotesOf(w.checkout) });
const states = (w: CarWorld) => w.book.read("acme").flatMap((v) => v.file.states.map((s) => s.state));

test("received, for a submodule app: a head on the base's branch of the app's own remote is refused (a car lands once), and one that is not there is received; the project's remote is never asked for it", async () => {
	const x = world(), { w } = x;
	// The tip of the app's base, in a book that never saw the car: on the project's remote git finds no such commit, and the car was received.
	await assert.rejects(x.receive("T-41", x.onBase), (e: Error) => e.message === landedWord("T-41", x.onBase, `is on develop of ${onWeb} already`));
	assert.match((await x.receive("T-40", x.head)).text, /^Car T-40 is received\.(?!.*unchecked)/);
	assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[WEB_URL, WEB_URL], [WEB_URL, WEB_URL]]);
	// The base moved on: the head is an ancestor of its tip now.
	git(x.webWork, "push", "-q", "origin", `${x.head}:develop`);
	await assert.rejects(x.receive("T-42", x.onBase), (e: Error) => e.message === landedWord("T-42", x.onBase, `is on develop of ${onWeb} already`));
	assert.match((await x.receive("T-43", x.stray)).text, /^Car T-43 is received\./);
	assert.deepEqual(w.book.read("acme").map((v) => v.file.car.tickets[0]), ["T-40", "T-43"]);
	assert.ok(!x.asked("ls-remote").includes(PUBLIC_URL) && !x.asked("fetch").includes(PUBLIC_URL), "no check of the app asks the project's remote");
});

test("received, for a submodule app whose base is a branch of its own remote only: the receipt is checked there, where the project's remote lists no such branch", async () => {
	const x = world(), { w } = x;
	git(x.webWork, "push", "-q", "origin", `${x.onBase}:refs/heads/release`);
	writeFileSync(join(w.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "release" } }] }));
	assert.match((await x.receive("T-60", x.head)).text, /^Car T-60 is received\.(?!.*unchecked)/);
	await assert.rejects(x.receive("T-61", x.onBase), (e: Error) => e.message === landedWord("T-61", x.onBase, `is on release of ${onWeb} already`));
});

test("received, for an app of the project's own repository beside a submodule app: the project's remote is asked, as before", async () => {
	const x = world();
	await assert.rejects(x.receive("T-44", x.project.pushed, "site"), (e: Error) => e.message === landedWord("T-44", x.project.pushed, "is on develop of the project's remote already"));
	assert.match((await x.receive("T-45", x.project.local, "site")).text, /^Car T-45 is received\./);
	// The app's commit is no commit of the project: for the project's app it is the usual car, on no base.
	assert.match((await x.receive("T-46", x.onBase, "site")).text, /^Car T-46 is received\./);
	assert.deepEqual([...new Set(x.asked("ls-remote"))], [PUBLIC_URL]);
});

test("received, for a submodule app whose remote cannot be authenticated or read: the car is received unchecked with the reason (auth stays as it was), and the project's remote does not stand in", async () => {
	const x = world(), { w } = x;
	// The server's git has no credential for the app's remote.
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => {
		if (args.includes("ls-remote")) throw Object.assign(new Error("Command failed"), { stderr: "fatal: could not read Username for 'https://git.example.test': terminal prompts disabled\n" });
		return x.real(cwd, args, env);
	};
	assert.match((await x.receive("T-47", x.head)).text, /Received unchecked: the server could not reach the remote of app web's repository at git\.example\.test \(auth: git ls-remote of develop from the remote of app web's repository failed: fatal: could not read Username/);
	assert.ok(w.logs.some((l) => l.startsWith("cars-received-unchecked") && l.includes('"reason":"auth"')), w.logs.join("\n"));
	// Any other failure of git still refuses the receipt.
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => {
		if (args.includes("ls-remote")) throw Object.assign(new Error("Command failed"), { stderr: "fatal: protocol error: bad line length character\n" });
		return x.real(cwd, args, env);
	};
	await assert.rejects(x.receive("T-48", x.stray), /^Error: sb: car T-48 is not received: whether its head [0-9a-f]{12} is on develop of the remote of app web's repository already could not be checked \(git ls-remote of develop from the remote of app web's repository failed/);
	// The app's checkout names a remote the server does not fetch from (a path on this computer): nothing is checked, and the project's remote, which the server can read, is not asked instead.
	const asks: string[][] = [];
	w.deps.git = async (cwd: string, args: string[], env?: Record<string, string>) => (asks.push(args), x.real(cwd, args, env));
	git(x.web, "remote", "set-url", "origin", x.webRemote);
	assert.match((await x.receive("T-49", x.onBase)).text, /Received unchecked: the remote of app web's own repository in the integrator's workspace checkout could not be read, so whether head [0-9a-f]{12} is on the base already was not checked\./);
	assert.ok(w.logs.some((l) => l.startsWith("cars-received-unchecked") && l.includes('"car":"T-49"') && l.includes('"reason":"unread"')));
	assert.deepEqual(asks.filter((args) => args.includes("ls-remote") || args.includes("fetch")), []);
});

test("landed, for a submodule app: the commit is looked for on the base's branch of the app's own remote, which the server read at the open; a commit that is only on the project's remote, or on no base, has not landed", async () => {
	const x = world(), { w } = x, { landed } = await ridden(x);
	// A commit of the project, on the project's base: it is not the app's, and the car has not landed with it.
	const others = await landed(x.project.pushed);
	assert.equal(others?.ok, false, "a commit on the project's base is on no base of the app");
	assert.match(String(others?.error), /^sb: landed\.commit [0-9a-f]{12} is not on develop of the remote of app web's repository: a car has landed only when its commit is on the base's branch there$/);
	// Not merged yet: the car's head is on no base.
	assert.match(String((await landed(x.head))?.error), /is not on develop of the remote of app web's repository/);
	assert.ok(!states(w).includes("landed"));
	// The train merges and pushes to the app's base.
	git(x.webWork, "push", "-q", "origin", `${x.head}:develop`);
	x.calls.length = 0;
	const reply = await landed(x.head);
	assert.equal(reply?.ok, true, String(reply?.error));
	assert.deepEqual(states(w), ["received", "landed"]);
	assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[WEB_URL], [WEB_URL]]);
	assert.deepEqual([w.book.trainOf("acme", CODE)?.url, w.book.trainOf("acme", CODE)?.appUrls], [PUBLIC_URL, { web: WEB_URL }], "the open read both remotes; `site` is the project's own app and has none of its own");
});

test("landed, for a submodule app whose remote was another one at an earlier open of this server: refused, though the project's remote did not move (the two are kept apart)", async () => {
	const x = world(), { w } = x;
	// The first train of this server's life opened while the app's checkout named another remote.
	git(x.web, "remote", "set-url", "origin", "https://git.example.test/moved.git");
	w.book.noteTrain({ project: "acme", code: "2026-11-06-a", session: "sess-train-0", pane: "wA:p9", integrator: INTEG, base: "develop", heads: [], url: PUBLIC_URL, appUrls: await w.book.appRemotesOf(w.checkout) });
	git(x.web, "remote", "set-url", "origin", WEB_URL);
	const { landed } = await ridden(x);
	git(x.webWork, "push", "-q", "origin", `${x.head}:develop`);
	const moved = await landed(x.head);
	assert.equal(moved?.ok, false);
	assert.match(String(moved?.error), /^sb: the remote of app web of project acme changed between two opens of this server \(https:\/\/git\.example\.test\/moved\.git, then https:\/\/git\.example\.test\/web\.git\); landed is not checked against a remote that moved$/);
});

test("landed, for a submodule app whose checkout named no remote the server fetches from at the open: refused with that word, and the project's remote does not stand in", async () => {
	const x = world(), { w } = x;
	git(x.web, "remote", "set-url", "origin", x.webRemote);
	const { landed } = await ridden(x);
	assert.deepEqual(w.book.trainOf("acme", CODE)?.appUrls, { web: null });
	git(x.webWork, "push", "-q", "origin", `${x.head}:develop`);
	x.calls.length = 0;
	const reply = await landed(x.head);
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /^sb: the remote of app web of project acme was not read when train \S+ opened \(.*\), so T-15's commit cannot be checked$/);
	assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[], []]);
});

test("R0802-F005: a repeated open carries no remote of the app either: landed of a submodule app's car is refused with the open's word", async () => {
	const x = world(), { w } = x, { landed } = await ridden(x, { repeated: true });
	assert.deepEqual([w.book.trainOf("acme", CODE)?.url, w.book.trainOf("acme", CODE)?.appUrls], [undefined, undefined]);
	git(x.webWork, "push", "-q", "origin", `${x.head}:develop`);
	x.calls.length = 0;
	const reply = await landed(x.head);
	assert.equal(reply?.ok, false);
	assert.match(String(reply?.error), /^sb: the remote of project acme was not read when train \S+ opened \(.*this server learned of the train after a restart\), so T-15's commit cannot be checked$/);
	assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[], []]);
});

test("R0802-F005: received in a linked worktree of the project where the submodule is not checked out reads the app's remote from the main checkout's copy", async () => {
	const x = world(), { w } = x, wt = join(w.root, "wt");
	git(w.checkout, "commit", "-qm", "the web app, a submodule");
	git(w.checkout, "worktree", "add", "-q", wt, "-b", "integ");
	mkdirSync(join(wt, ".straw-boss"));
	copyFileSync(join(w.checkout, ".straw-boss", "apps.json"), join(wt, ".straw-boss", "apps.json"));
	assert.throws(() => readFileSync(join(wt, "apps", "web", ".git")), "the worktree has no checkout of the app");
	(w.deps as { checkoutOf: () => Promise<string> }).checkoutOf = async () => wt;
	await assert.rejects(x.receive("T-41", x.onBase), (e: Error) => e.message === landedWord("T-41", x.onBase, `is on develop of ${onWeb} already`));
	assert.match((await x.receive("T-40", x.head)).text, /^Car T-40 is received\.(?!.*unchecked)/);
	assert.deepEqual([...new Set(x.asked("ls-remote"))], [WEB_URL]);
});

test("R0802-F001: an app of the project's repository whose folder became a repository of its own after the first open of this server's life is not trusted for landed", async () => {
	const x = world(), { w } = x, EVIL_URL = "https://git.example.test/evil.git", evilRemote = join(w.root, "evil.git"), evilWork = join(w.root, "evil-work"), folder = join(w.checkout, "services", "site");
	writeFileSync(join(w.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "site", dir: "services/site", integration: { base: "develop" } }] }));
	mkdirSync(folder, { recursive: true });
	await openedBefore(w);
	assert.deepEqual(await w.book.appRemotesOf(w.checkout), { web: WEB_URL }, "at the first open `site` is the project's");
	// Something that writes the tower's checkout makes the folder a clone of another repository.
	execFileSync("git", ["init", "-q", "--bare", "-b", "develop", evilRemote]);
	execFileSync("git", ["clone", "-q", evilRemote, evilWork], { stdio: "ignore" });
	writeFileSync(join(evilWork, "one"), "one");
	git(evilWork, "add", "one");
	git(evilWork, "commit", "-qm", "one");
	git(evilWork, "push", "-q", "origin", "HEAD:develop");
	writeFileSync(join(evilWork, "two"), "two");
	git(evilWork, "add", "two");
	git(evilWork, "commit", "-qm", "two");
	const head = git(evilWork, "rev-parse", "HEAD");
	rmSync(folder, { recursive: true });
	execFileSync("git", ["clone", "-q", evilRemote, folder], { stdio: "ignore" });
	git(folder, "remote", "set-url", "origin", EVIL_URL);
	w.rewrites.push([EVIL_URL, evilRemote]);
	const { landed } = await ridden(x, { app: "site", head });
	assert.deepEqual(w.book.trainOf("acme", CODE)?.appUrls, { web: WEB_URL, site: EVIL_URL });
	git(evilWork, "push", "-q", "origin", `${head}:develop`);
	x.calls.length = 0;
	const reply = await landed(head);
	assert.equal(reply?.ok, false, "a commit that is only on the new repository's base");
	assert.equal(reply?.error, `sb: the remote of app site of project acme changed between two opens of this server (the project's, ${PUBLIC_URL}, then its own repository's, ${EVIL_URL}); landed is not checked against a remote that moved`);
	assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[], []]);
	// The app that did not change kind is checked as before.
	assert.ok(!states(w).includes("landed"));
});

test("R0802-F001, the other way: an app that was a repository of its own at the first open and is the project's now is not trusted for landed", async () => {
	const x = world(), { w } = x;
	await openedBefore(w);
	// The submodule is taken out of the checkout: no `.git`, no gitlink, no `.gitmodules` entry. The app's folder is a folder of the project now.
	rmSync(join(x.web, ".git"));
	git(w.checkout, "update-index", "--force-remove", "apps/web");
	writeFileSync(join(w.checkout, ".gitmodules"), "");
	assert.deepEqual(await w.book.appRemotesOf(w.checkout), {});
	const { landed } = await ridden(x, { head: x.project.local });
	const reply = await landed(x.project.pushed);
	assert.equal(reply?.ok, false, "a commit of the project, on the project's base");
	assert.equal(reply?.error, `sb: the remote of app web of project acme changed between two opens of this server (its own repository's, ${WEB_URL}, then the project's, ${PUBLIC_URL}); landed is not checked against a remote that moved`);
});

for (const [by, strip] of [["the index (mode 160000)", (x: World) => rmSync(join(x.w.checkout, ".gitmodules"))], [".gitmodules", (x: World) => { const text = readFileSync(join(x.w.checkout, ".gitmodules"), "utf8"); git(x.w.checkout, "rm", "-q", "--cached", "apps/web"); writeFileSync(join(x.w.checkout, ".gitmodules"), text); }]] as const) {
	test(`R0802-F002: a submodule app with no checkout, known by ${by}, is a repository of its own with no remote: received unchecked, landed refused, the project's remote not asked`, async () => {
		const x = world(), { w } = x;
		writeFileSync(join(w.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "pkg", dir: "apps/web/packages/ui", integration: { base: "develop" } }, { name: "site", dir: ".", integration: { base: "develop" } }, { name: "api", dir: "services/api", integration: { base: "develop" } }] }));
		mkdirSync(join(w.checkout, "services", "api"), { recursive: true });
		git(w.checkout, "submodule", "deinit", "-q", "-f", "apps/web");
		assert.throws(() => readFileSync(join(x.web, ".git")), "the app has no checkout");
		strip(x);
		assert.deepEqual(await w.book.appRemotesOf(w.checkout), { web: null, pkg: null });
		// The project's base holds this commit: checked against the project's remote, the receipt was let in unsaid and `landed` passed.
		const { landed, receipt } = await ridden(x, { head: x.project.local });
		assert.match(receipt, /Received unchecked: the remote of app web's own repository in the integrator's workspace checkout could not be read, so whether head [0-9a-f]{12} is on the base already was not checked\./);
		assert.ok(w.logs.some((l) => l.startsWith("cars-received-unchecked") && l.includes('"reason":"unread"')));
		const reply = await landed(x.project.pushed);
		assert.equal(reply?.ok, false);
		assert.match(String(reply?.error), /^sb: the remote of app web of project acme was not read when train \S+ opened \(.*\), so T-15's commit cannot be checked$/);
		assert.match((await x.receive("T-50", x.stray, "pkg")).text, /Received unchecked: the remote of app pkg's own repository/);
		assert.deepEqual([x.asked("ls-remote"), x.asked("fetch")], [[], []]);
		// Apps of the project's own repository beside it are checked against the project's remote, as before.
		await assert.rejects(x.receive("T-51", x.project.pushed, "api"), (e: Error) => e.message === landedWord("T-51", x.project.pushed, "is on develop of the project's remote already"));
	});
}
