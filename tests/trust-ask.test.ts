import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AskDeps, createAsk, type Proc, type Stdin } from "../src/trust/ask.ts";
import { answerFile, resultFile, UUID } from "../src/trust/files.ts";
import { digestOf } from "../src/trust/found.ts";
import type { TrustRequest, TrustResult } from "../src/trust/types.ts";

// The `project_trust` handler (src/trust/ask.ts) with fakes for pi's store and settings, the GUI check, stdin, the clock, and the process.

const TUI = { mode: "tui", hasUI: true };
const ANSWER_ID = "a".repeat(24);

function fakeStdin() {
	const log: string[] = [], listeners = new Set<() => void>();
	const stdin: Stdin = {
		isTTY: true, isRaw: false,
		setRawMode: (on) => void log.push(`raw:${on}`), resume: () => void log.push("resume"), pause: () => void log.push("pause"),
		on: (_e, cb) => void listeners.add(cb), off: (_e, cb) => void listeners.delete(cb),
	};
	return { stdin, log, listeners, press: () => [...listeners].forEach((cb) => cb()) };
}
function fakeProc() {
	const hooks = new Map<string, Set<() => void>>(), kills: string[] = [];
	const proc: Proc = {
		pid: process.pid,
		on: (e, cb) => void (hooks.get(e) ?? hooks.set(e, new Set()).get(e)!).add(cb),
		off: (e, cb) => void hooks.get(e)?.delete(cb),
		listenerCount: (e) => hooks.get(e)?.size ?? 0,
		kill: (_pid, signal) => void kills.push(signal),
	};
	return { proc, hooks, kills };
}

function setup(over: Partial<AskDeps> = {}, tick?: (n: number, dir: string) => void) {
	const dir = join(mkdtempSync(join(tmpdir(), "trust-ask-")), "state", "trust"), cwd = mkdtempSync(join(tmpdir(), "trust-cwd-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:demo"] }));
	const s = fakeStdin(), p = fakeProc(), out: string[] = [];
	let t = 1_000_000, n = 0;
	const deps: AskDeps = {
		env: { HERDR_PANE_ID: "w1-1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", STRAW_BOSS_ROLE: "member" }, dir, stdin: s.stdin, proc: p.proc, write: (x) => void out.push(x),
		saved: () => null, defaultTrust: () => "ask", up: async () => true, first: () => true,
		now: () => t, sleep: async (ms) => { t += ms; tick?.(n++, dir); }, watch: () => () => {}, startOf: () => "Mon Oct 26 10:00:00 2026", uuid: () => "11111111-2222-4333-8444-555555555555", ...over,
	};
	const clean = () => rmSync(join(dir, "..", ".."), { recursive: true, force: true }) ?? rmSync(cwd, { recursive: true, force: true });
	return { deps, dir, cwd, s, p, out, clean, now: () => t, decide: () => createAsk(deps)(cwd, TUI) };
}
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const request = (dir: string) => JSON.parse(readFileSync(join(dir, `${files(dir).find((f) => /^[0-9a-f-]{36}\.json$/.test(f))}`), "utf8")) as TrustRequest;
const answer = (dir: string, over: Record<string, unknown> = {}) => {
	const r = request(dir);
	writeFileSync(join(dir, answerFile(r.id)), JSON.stringify({ version: 1, id: r.id, digest: r.digest, choice: "trust", answerId: ANSWER_ID, ...over }));
};
const result = (dir: string) => JSON.parse(readFileSync(join(dir, resultFile("11111111-2222-4333-8444-555555555555")), "utf8")) as TrustResult;

test("the handler answers undecided and writes nothing unless a GUI can ask and pi has not decided", async () => {
	const cases: [string, Partial<AskDeps>, { mode: string; hasUI: boolean }?][] = [
		["print mode", {}, { mode: "print", hasUI: true }], ["rpc mode", {}, { mode: "rpc", hasUI: true }], ["no UI", {}, { mode: "tui", hasUI: false }],
		["no TTY", { stdin: { ...fakeStdin().stdin, isTTY: false } }], ["no raw mode", { stdin: { ...fakeStdin().stdin, setRawMode: undefined } }],
		["a second runtime", { first: () => false }], ["a saved decision", { saved: () => true }], ["a saved refusal", { saved: () => false }],
		["a broken trust.json", { saved: () => { throw new Error("Failed to read trust store"); } }],
		["defaultProjectTrust always", { defaultTrust: () => "always" }], ["defaultProjectTrust never", { defaultTrust: () => "never" }],
		["no GUI that answers", { up: async () => false }], ["a settings error", { defaultTrust: () => { throw new Error("bad settings"); } }],
	];
	for (const [name, over, ctx] of cases) {
		const t = setup(over);
		try {
			assert.deepEqual(await createAsk(t.deps)(t.cwd, ctx ?? TUI), { trusted: "undecided" }, name);
			assert.deepEqual(files(t.dir), [], `${name}: no file is written`);
			assert.deepEqual(t.out, [], `${name}: nothing is printed`);
			assert.deepEqual(t.s.log, [], `${name}: stdin is left alone`);
		} finally {
			t.clean();
		}
	}
});

test("a GUI answer maps to pi's result, and the request, the answer, and the terminal are cleaned up", async () => {
	for (const [choice, expected, said] of [["trust", { trusted: "yes", remember: true }, "trusted, remembered"], ["once", { trusted: "yes" }, "trusted for this session"], ["no", { trusted: "no" }, "not trusted for this session"]] as const) {
		const t = setup({}, (n, dir) => n === 2 && answer(dir, { choice }));
		try {
			assert.deepEqual(await t.decide(), expected, choice);
			const r = result(t.dir);
			assert.deepEqual([r.by, r.answerId], ["remote", ANSWER_ID]);
			assert.deepEqual(files(t.dir), [resultFile(r.id)], "the request and the answer are gone; the result stays for the server");
			assert.deepEqual(t.s.log, ["raw:true", "resume", "raw:false", "pause"], "raw mode is restored and stdin paused");
			assert.equal(t.s.listeners.size, 0, "no key listener is left");
			assert.match(t.out.join(""), /Trust project folder\? .*\nThe question is in the Straw Boss window\.\nPress any key to answer here instead\./);
			assert.ok(t.out.join("").includes(`Answered in the Straw Boss window: ${said}.`));
			assert.equal(t.p.hooks.get("exit")?.size ?? 0, 0, "the exit hook is removed");
		} finally {
			t.clean();
		}
	}
});

test("the request is written by rename, privately, with every field and a digest that covers the folder and its findings", async () => {
	let seen: TrustRequest | undefined, mode = 0, dirMode = 0, names: string[] = [];
	const t = setup({}, (n, dir) => {
		if (n !== 0) return;
		seen = request(dir);
		mode = statSync(join(dir, `${seen.id}.json`)).mode & 0o777;
		dirMode = statSync(dir).mode & 0o777;
		names = files(dir);
		answer(dir);
	});
	try {
		await t.decide();
		const r = seen!;
		assert.match(r.id, UUID);
		assert.deepEqual([r.version, r.pid, r.started, r.herdr, r.pane, r.role], [1, process.pid, "Mon Oct 26 10:00:00 2026", "/tmp/herdr.sock", "w1-1", "member"]);
		assert.equal(r.cwd, (await import("node:fs")).realpathSync(t.cwd));
		assert.deepEqual(r.found.map((g) => [g.kind, g.items]), [["settings", ["package: npm:demo"]]]);
		assert.equal(r.digest, digestOf(r.cwd, r.found));
		assert.deepEqual(names.filter((f) => f.endsWith(".tmp")), [], "no temporary file is left behind");
		if (process.platform !== "win32") assert.deepEqual([mode, dirMode], [0o600, 0o700]);
	} finally {
		t.clean();
	}
});

test("a key in the terminal wins: the request goes, a later answer is ignored, and pi shows its own prompt", async () => {
	let n0 = 0;
	const t = setup({}, (n, dir) => {
		n0 = n;
		if (n === 1) t.s.press();
		if (n === 1) answer(dir); // an answer that lands in the same moment as the key
	});
	try {
		assert.deepEqual(await t.decide(), { trusted: "undecided" });
		assert.equal(n0, 1);
		const r = result(t.dir);
		assert.equal(r.by, "terminal");
		assert.deepEqual(files(t.dir), [resultFile(r.id)]);
		assert.deepEqual(t.s.log, ["raw:true", "resume", "raw:false", "pause"]);
		assert.equal(t.s.listeners.size, 0);
	} finally {
		t.clean();
	}
});

test("a GUI that stops answering for 15 s hands over to pi's prompt; one that answers again in time keeps the wait", async () => {
	let up = true;
	const gone = setup({ up: async () => up }, () => { up = false; });
	try {
		assert.deepEqual(await gone.decide(), { trusted: "undecided" });
		assert.equal(result(gone.dir).by, "gone");
		assert.ok(gone.out.join("").includes("The Straw Boss window is not running; answer here."));
		assert.ok(gone.now() - 1_000_000 >= 15_000 && gone.now() - 1_000_000 < 18_000, "after about 15 s");
		assert.deepEqual(files(gone.dir), [resultFile(result(gone.dir).id)]);
	} finally {
		gone.clean();
	}
	let t0 = 0;
	const back = setup({ up: async () => up }, (n, dir) => {
		if (n === 0) (up = false, (t0 = back.now()));
		if (back.now() - t0 > 10_000 && !up) up = true; // a takeover took about 6 s
		if (n === 40) answer(dir);
	});
	try {
		up = true;
		assert.deepEqual(await back.decide(), { trusted: "yes", remember: true });
		assert.equal(result(back.dir).by, "remote");
	} finally {
		back.clean();
	}
});

test("an answer with another digest, id, choice, or answerId is ignored and the wait goes on", async () => {
	const t = setup({}, (n, dir) => {
		if (n === 0) answer(dir, { digest: "0".repeat(64) });
		if (n === 2) answer(dir, { id: "99999999-2222-4333-8444-555555555555" });
		if (n === 4) answer(dir, { choice: "always" });
		if (n === 6) answer(dir, { answerId: "short" });
		if (n === 8) answer(dir, { version: 2 });
		if (n === 10) writeFileSync(join(dir, answerFile("11111111-2222-4333-8444-555555555555")), "not json");
		if (n === 12) answer(dir, { choice: "no" });
	});
	try {
		assert.deepEqual(await t.decide(), { trusted: "no" });
		assert.equal(result(t.dir).by, "remote");
	} finally {
		t.clean();
	}
});

test("a signal while waiting removes the request and ends pi as it would have; an exit does too", async () => {
	let hooks: ReturnType<typeof fakeProc> | undefined;
	const t = setup({}, (n, dir) => {
		if (n !== 1) return;
		assert.equal(files(dir).filter((f) => f.endsWith(".json")).length, 1);
		[...hooks!.hooks.get("SIGTERM")!].forEach((cb) => cb());
		assert.deepEqual(files(dir), [], "the request is removed before pi exits");
		assert.deepEqual(hooks!.kills, ["SIGTERM"], "nothing else handles it, so it is raised again");
		t.s.press();
	});
	hooks = t.p;
	try {
		await t.decide();
	} finally {
		t.clean();
	}
	const e = setup({}, (n, dir) => {
		if (n !== 1) return;
		[...e.p.hooks.get("exit")!].forEach((cb) => cb());
		assert.deepEqual(files(dir), []);
		e.s.press();
	});
	try {
		await e.decide();
	} finally {
		e.clean();
	}
});

test("a folder name with escape sequences is printed as plain text", async () => {
	const t = setup({}, (n, dir) => n === 0 && answer(dir));
	try {
		const weird = join(t.cwd, "bad\u001b[2Jname");
		mkdirSync(join(weird, ".pi"), { recursive: true });
		writeFileSync(join(weird, ".pi", "settings.json"), "{}");
		await createAsk(t.deps)(weird, TUI);
		assert.ok(!t.out.join("").includes("\u001b"), "no control character reaches the terminal");
	} finally {
		t.clean();
	}
});
