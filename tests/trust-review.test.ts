import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AskDeps, createAsk } from "../src/trust/ask.ts";
import { requestFile, writeAtomic, answerFile, ensureDir, lives } from "../src/trust/files.ts";
import { clean, cleanGroup, foundIn, MAX_READ } from "../src/trust/found.ts";
import { digestOf } from "../src/trust/found.ts";
import { waitPastTrust } from "../src/trust/wait.ts";
import type { TrustRequest } from "../src/trust/types.ts";
import { outcome } from "../gui/trust.ts";

// Fixes from the security review of project trust (R-F001 to R-F009).

const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-trust-review-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
mkdirSync(home);
let n = 0;
const folder = () => (mkdirSync(join(root, `f${n}`, ".pi"), { recursive: true }), join(root, `f${n++}`));

test("R-F001: a settings.json that is a link to a device, a fifo, or larger than 256 KB is listed unreadable, and reading it returns at once", () => {
	for (const make of [
		(f: string) => symlinkSync("/dev/zero", f),
		(f: string) => symlinkSync("/dev/stdin", f),
		(f: string) => symlinkSync(join(root, "elsewhere.json"), f),
		(f: string) => writeFileSync(f, `{"a":"${"x".repeat(MAX_READ)}"}`),
		(f: string) => execFileSync("mkfifo", [f]),
	]) {
		const dir = folder(), file = join(dir, ".pi", "settings.json");
		writeFileSync(join(root, "elsewhere.json"), "{}");
		make(file);
		const began = Date.now(), found = foundIn(dir, home);
		assert.ok(Date.now() - began < 2000);
		assert.deepEqual(found, [{ kind: "settings", path: ".pi/settings.json", items: [], more: 0, unreadable: true }]);
		const mcp = join(dir, ".pi", "mcp.json");
		symlinkSync("/dev/zero", mcp);
		assert.equal(foundIn(dir, home).find((g) => g.kind === "mcp")?.unreadable, true);
	}
});

test("R-F003: the page's text is cleaned of bidi and zero-width characters, in the group and in the give-up error", () => {
	assert.equal(clean("a\u202Eb\u200Bc\u0007"), "a\ufffdb\ufffdc");
	assert.deepEqual(cleanGroup({ kind: "mcp", path: ".pi/\u202Emcp.json", items: ["x\u200By"], more: 0 }), { kind: "mcp", path: ".pi/\ufffdmcp.json", items: ["x\ufffdy"], more: 0 });
});

test("R-F005: stale with by gone has its own message", () => {
	const gone = outcome({ status: 200, body: { outcome: "stale", by: "gone" } } as never), terminal = outcome({ status: 200, body: { outcome: "stale", by: "terminal" } } as never);
	assert.notEqual(gone.text, terminal.text);
	assert.match(gone.text, /ended/);
	assert.match(outcome({ status: 200, body: { outcome: "stale", by: "changed" } } as never).text, /changed/);
});

function setup(tick: (n: number, dir: string) => void) {
	const dir = join(root, `ask${n}`, "state", "trust"), cwd = folder();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:demo"] }));
	const out: string[] = [], listeners = new Set<() => void>();
	let t = 1_000_000, count = 0;
	const deps: AskDeps = {
		env: { HERDR_PANE_ID: "w1-1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", STRAW_BOSS_ROLE: "member" }, dir,
		stdin: { isTTY: true, setRawMode: () => {}, resume: () => {}, pause: () => {}, on: (_e, cb) => void listeners.add(cb), off: (_e, cb) => void listeners.delete(cb) },
		proc: { pid: process.pid, on: () => {}, off: () => {}, listenerCount: () => 1, kill: () => {} },
		write: (x) => void out.push(x), saved: () => null, defaultTrust: () => "ask", up: async () => true, first: () => true,
		now: () => t, sleep: async (ms) => { t += ms; tick(count++, dir); }, watch: () => () => {}, startOf: () => "Mon Oct 26 10:00:00 2026", uuid: () => "11111111-2222-4333-8444-555555555555",
	};
	return { cwd, dir, out, decide: () => createAsk(deps)(cwd, { mode: "tui", hasUI: true }) };
}
const requestAt = (dir: string) => JSON.parse(readFileSync(join(dir, "11111111-2222-4333-8444-555555555555.json"), "utf8")) as { id: string; digest: string; found: { items: string[] }[] };
const answerWith = (dir: string, digest: string, answerId: string) => writeFileSync(join(dir, answerFile("11111111-2222-4333-8444-555555555555")), JSON.stringify({ version: 1, id: "11111111-2222-4333-8444-555555555555", digest, choice: "trust", answerId }));

test("R-F004: a folder that gained an extension between the alert and the answer is not trusted on the old answer; the question is rewritten and the new answer counts", async () => {
	let first = "", t: ReturnType<typeof setup>;
	t = setup((i, dir) => {
		if (i === 0) {
			first = requestAt(dir).digest;
			mkdirSync(join(t.cwd, ".pi", "extensions"));
			writeFileSync(join(t.cwd, ".pi", "extensions", "late.ts"), "");
			answerWith(dir, first, "a".repeat(24));
		} else if (i === 1) {
			const now = requestAt(dir);
			assert.notEqual(now.digest, first, "rewritten under the new digest");
			assert.ok(now.found.some((g) => g.items.includes("late.ts")));
			assert.equal(existsSync(join(dir, answerFile(now.id))), false, "the old answer is gone");
			assert.equal(JSON.parse(readFileSync(join(dir, "11111111-2222-4333-8444-555555555555.result.json"), "utf8")).by, "changed");
			answerWith(dir, now.digest, "b".repeat(24));
		}
	});
	assert.deepEqual(await t.decide(), { trusted: "yes", remember: true });
	assert.ok(t.out.join("").includes("Answered"));
});

test("R-F007: a request that went missing hands over to pi's prompt as gone", async () => {
	const t = setup((i, dir) => i === 0 && rmSync(join(dir, "11111111-2222-4333-8444-555555555555.json")));
	assert.deepEqual(await t.decide(), { trusted: "undecided" });
	assert.match(t.out.join(""), /withdrawn/);
});

test("R-F009: without user ids a trust folder must lie in the profile; the confirmed-PID cache is used for requests", () => {
	const inside = join(home, "state", "trust"), outside = join(root, "shared", "trust");
	assert.equal(ensureDir(inside, false, home), true);
	assert.equal(ensureDir(outside, false, home), false);
	assert.equal(ensureDir(outside, true, home), true);
	const calls: number[] = [];
	const r = { pid: process.pid, started: "x" }, ps = () => (calls.push(1), "x");
	assert.equal(lives(r, 0, ps), true);
	assert.equal(lives(r, 0, ps), true);
	assert.equal(calls.length, 1, "the second reading is by signal alone");
});

test("R-F002: the GUI's pop hands the trust directory on", () => {
	assert.match(readFileSync(new URL("../src/host.ts", import.meta.url), "utf8"), /popBase\(\{[^}]*trustDir: trustDir\(guiDir\)/);
});

test("R-F004 (live): a request rewritten under the same id and a new digest is told to the opening again", async () => {
	const dir = join(root, "wait", "trust"), id = "22222222-2222-4333-8444-555555555555", seen: (string | undefined)[] = [];
	mkdirSync(dir, { recursive: true });
	const put = (items: string[]) => {
		const found = [{ kind: "extensions", path: ".pi/extensions", items, more: 0 }], cwd = "/work/x";
		writeAtomic(dir, requestFile(id), { version: 1, id, pid: process.pid, herdr: "/h", pane: "w1:p1", role: "member", cwd, at: 1, found, digest: digestOf(cwd, found) } satisfies TrustRequest);
	};
	put(["a.ts"]);
	let step = 0;
	await waitPastTrust(async () => { step++ === 1 && put(["a.ts", "b.ts"]); }, () => (step > 3 ? "ok" : undefined), 10_000, 1, { dir, pane: "w1:p1", on: (r) => void seen.push(r?.found[0]?.items.join()) });
	assert.deepEqual(seen, ["a.ts", "a.ts,b.ts", undefined]);
});
