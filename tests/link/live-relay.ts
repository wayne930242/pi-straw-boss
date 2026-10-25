import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// The real straw-relay for the live tests (docs/specs/2026-10-25-straw-link.md, Build order 2 and 3): built from a clean `git archive HEAD` snapshot
// of STRAW_RELAY_DIR (default ~/projects/straw-relay), run on a free port with an operator token, and killed with its temp dir when the test ends.
// Skipped, with the reason, where `go` or the checkout is missing.

const RELAY_DIR = process.env.STRAW_RELAY_DIR ?? join(homedir(), "projects", "straw-relay");
export const relaySkip: string | false = spawnSync("go", ["version"], { encoding: "utf8" }).status !== 0 ? "skipped: `go` is not installed" : !existsSync(join(RELAY_DIR, ".git")) ? `skipped: no straw-relay checkout at ${RELAY_DIR} (set STRAW_RELAY_DIR)` : false;

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});

export interface LiveRelay { url: string; token: string; log(): string; stop(): Promise<void> }

export async function startRelay(): Promise<LiveRelay> {
	const work = mkdtempSync(join(tmpdir(), "straw-link-holder-live-"));
	const src = join(work, "src"), bin = join(work, "straw-relay"), db = join(work, "relay.db");
	mkdirSync(src);
	const archive = spawnSync("git", ["-C", RELAY_DIR, "archive", "HEAD"], { maxBuffer: 1 << 28 });
	if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
	const tar = spawnSync("tar", ["-x", "-C", src], { input: archive.stdout });
	if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
	const built = spawnSync("go", ["build", "-o", bin, "./cmd/straw-relay"], { cwd: src, encoding: "utf8", timeout: 900_000 });
	if (built.status !== 0) throw new Error(`go build failed:\n${built.stderr}`);
	const made = spawnSync(bin, ["token", "create", "--db", db], { encoding: "utf8" });
	if (made.status !== 0) throw new Error(`token create failed: ${made.stderr}`);
	const port = await freePort(), url = `http://127.0.0.1:${port}`;
	const relay: ChildProcess = spawn(bin, ["serve", "--addr", `127.0.0.1:${port}`, "--db", db], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	relay.stdout!.on("data", (d: Buffer) => void (out += d.toString()));
	relay.stderr!.on("data", (d: Buffer) => void (out += d.toString()));
	process.once("exit", () => relay.kill("SIGKILL"));
	console.log(`# link-holder-live: relay pid ${relay.pid} on ${url}`);
	const stop = async () => {
		if (relay.exitCode === null) {
			const exited = new Promise<void>((resolve) => relay.once("exit", () => resolve()));
			relay.kill("SIGTERM");
			const killer = setTimeout(() => relay.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(killer);
			console.log(`# link-holder-live: relay pid ${relay.pid} stopped`);
		}
		if (basename(work).startsWith("straw-link-holder-live-") && work.startsWith(tmpdir())) rmSync(work, { recursive: true, force: true });
	};
	const live: LiveRelay = { url, token: made.stdout.trim(), log: () => out, stop };
	for (const stopAt = Date.now() + 15_000; ; await new Promise((r) => setTimeout(r, 50))) {
		try {
			if ((await fetch(`${url}/healthz`)).ok) return live;
		} catch {
			if (Date.now() > stopAt) {
				await stop();
				throw new Error(`the relay did not come up:\n${out}`);
			}
		}
	}
}
