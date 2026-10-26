import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// docs/specs/2026-10-26-sb-backend.md, Packaged (B1 and B2): the server runs from the package as pi installs it. This builds dist/server, packs the package, installs it the way pi
// does (pi's npm flags: `--legacy-peer-deps`, so pi's own packages and typebox are not on disk) next to pi-intercom 0.18.1, and runs `status`, `up`, and `stop` under `env -i`
// against a scratch Herdr in a scratch HOME. It needs the npm registry (tsx and pi-intercom) and the `herdr` binary, so it runs only with SB_PACKAGED=1.

const root = fileURLToPath(new URL("..", import.meta.url));
const wanted = process.env.SB_PACKAGED === "1";
const herdrBin = (process.env.PATH ?? "").split(":").map((dir) => join(dir, "herdr")).find((file) => existsSync(file));
const skip = !wanted ? "set SB_PACKAGED=1 to run it (it needs the npm registry and the herdr binary)" : !herdrBin ? "no herdr binary on PATH" : process.platform === "win32" ? "the Windows run is the VM tester's" : false;

const run = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const alive = (pid: number) => { try { return process.kill(pid, 0); } catch { return false; } };
const until = async (check: () => boolean, what: string, ms = 15_000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (check()) return;
	throw new Error(`Timed out waiting for ${what}`);
};

test("packaged: the packed package installs with pi's npm flags (no pi packages or typebox on disk), and under env -i against a scratch Herdr status, up, and stop work", { skip, timeout: 280_000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "psb-pkg-"));
	const home = join(scratch, "home"), agent = join(scratch, "agent"), npmRoot = join(agent, "npm");
	mkdirSync(home, { recursive: true });
	mkdirSync(npmRoot, { recursive: true });
	writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "pi-npm", private: true }));
	const started: number[] = [];
	try {
		// The package, as `npm publish` would pack it (prepack builds the same dist/server).
		run(process.execPath, [join(root, "scripts", "build-server.mjs")], { cwd: root, timeout: 120_000 });
		const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, timeout: 120_000 })) as { filename: string }[];
		const tarball = join(scratch, packed[0]!.filename);
		// What pi's package manager runs for a managed install: --prefix <agent>/npm and --legacy-peer-deps (package-manager.js).
		run("npm", ["install", tarball, "pi-intercom@0.18.1", "--prefix", npmRoot, "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: npmRoot, timeout: 200_000 });
		const modules = join(npmRoot, "node_modules");
		assert.ok(existsSync(join(modules, "pi-straw-boss", "dist", "server", "cli.mjs")) && existsSync(join(modules, "tsx")) && existsSync(join(modules, "pi-intercom")));
		assert.equal(existsSync(join(modules, "@earendil-works")), false, "no pi package is on disk");
		assert.equal(existsSync(join(modules, "typebox")), false, "typebox is not on disk");

		// A scratch Herdr in the scratch HOME; env -i keeps this shell's pi identity and Herdr variables out of both.
		const clean: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? "" };
		const herdr = spawn(herdrBin!, ["server"], { env: clean, stdio: "ignore", detached: true });
		herdr.unref();
		started.push(herdr.pid!);
		await until(() => existsSync(join(home, ".config", "herdr", "herdr.sock")), "the scratch Herdr's socket");

		const cli = join(modules, "pi-straw-boss", "dist", "server", "cli.mjs"), env = { ...clean, PI_CODING_AGENT_DIR: agent };
		const sb = (...args: string[]) => JSON.parse(run(process.execPath, [cli, ...args], { env, timeout: 60_000 }).trim().split("\n").at(-1)!) as Record<string, unknown>;
		assert.equal(sb("status").state, "gone");
		const up = sb("up");
		started.push(up.pid as number);
		assert.equal(up.server, "started");
		assert.equal(up.package, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
		assert.ok(alive(up.pid as number));
		const live = sb("status");
		assert.equal(live.state, "live");
		assert.equal(live.pid, up.pid);
		assert.equal(live.lastError, undefined, "tsx and pi-intercom loaded from the installed layout");
		assert.match(readFileSync(join(agent, "straw-boss", "server.log"), "utf8"), /intercom-connected id=sb-server-/);
		assert.equal(sb("up").server, "found", "a second up finds it");
		const broker = join(agent, "intercom", "broker.pid");
		if (existsSync(broker)) started.push(Number(readFileSync(broker, "utf8").trim()));
		assert.deepEqual(sb("stop"), { outcome: "stopped" });
		await until(() => !alive(up.pid as number), "the server to leave");
	} finally {
		for (const pid of started.reverse()) if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGTERM");
		await until(() => started.every((pid) => !alive(pid)), "every process this test started to be gone", 10_000).catch(() => {});
		for (const pid of started) assert.equal(alive(pid), false, `pid ${pid} is still running`);
		rmSync(scratch, { recursive: true, force: true });
	}
});
