import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where a net sidecar keeps what it leaves for the commands (one pane's state file, control socket, and log), and where pi-intercom and its tsx loader are.

/** The `straw-boss` directory of pi's agent directory, where the GUI's record and the sidecars' files live. */
export const stateDirOf = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss");

/**
 * The files of the sidecar of one pane, named by a hash of the pane id (a pane id is not a safe file name). On Windows the control socket is a named pipe,
 * which lives in the pipe namespace and not beside the files: its name is a hash of where the files are, so another state directory has another pipe.
 */
export function agentFiles(stateDir: string, pane: string, platform: NodeJS.Platform = process.platform) {
	const base = join(stateDir, "agents", createHash("sha256").update(pane).digest("hex").slice(0, 16));
	const socket = platform === "win32" ? `\\\\.\\pipe\\straw-boss-${createHash("sha256").update(base).digest("hex").slice(0, 16)}` : `${base}.sock`;
	return { dir: dirname(base), state: `${base}.json`, socket, log: `${base}.log` };
}
/** Whether the control socket is a file to remove and restrict: a Unix socket is; a Windows named pipe ends with its server, and its access is set as it is made. */
export const socketIsFile = (platform: NodeJS.Platform = process.platform) => platform !== "win32";
export type AgentFiles = ReturnType<typeof agentFiles>;

/** What a running sidecar writes first: who holds the pane. */
export interface Held { pid: number; session: string; kind: string; pane: string; id: string; name: string; startedAt: number }

/** Whether `pid` is a live process of this user: a sidecar is, so EPERM (another user's process) is not one of ours. */
export const alive = (pid: unknown) => {
	try {
		return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && process.kill(pid, 0);
	} catch {
		return false;
	}
};
export function readHeld(files: AgentFiles): Held | undefined {
	return parseHeld(readRaw(files));
}
export function readRaw(files: AgentFiles): string | undefined {
	try {
		return readFileSync(files.state, "utf8");
	} catch {
		return undefined;
	}
}
export function parseHeld(raw: string | undefined): Held | undefined {
	try {
		const held = JSON.parse(raw ?? "") as Held;
		return typeof held.pid === "number" && typeof held.session === "string" ? held : undefined;
	} catch {
		return undefined;
	}
}

/** How long a state file whose owner has not opened its socket yet still counts: a sidecar listens within a moment of claiming the pane. */
export const STARTING_MS = 15_000;
/** `up` and `leaving` are confirmed by the sidecar itself, over its socket (same pid and session); `starting` is a young file whose process is alive and does not answer yet. */
export interface Holder { held: Held; state: "up" | "starting" | "leaving" }
/**
 * Who holds the pane for a state file. A pid alone proves nothing (pids are reused, and a crash leaves the file behind), so the holder is the process that
 * answers `hello` on the pane's socket with the file's own pid and session. Only a young file whose process is alive is given the benefit of the doubt.
 */
export async function judge(files: AgentFiles, held: Held | undefined, now: () => number = Date.now): Promise<Holder | undefined> {
	if (!held) return undefined;
	const reply = await ask(files.socket, { cmd: "hello" }, 3000).catch(() => undefined);
	if (reply?.ok && reply.pid === held.pid && reply.session === held.session) return { held, state: reply.leaving ? "leaving" : "up" };
	return alive(held.pid) && now() - held.startedAt < STARTING_MS ? { held, state: "starting" } : undefined;
}
export const holder = (files: AgentFiles, now?: () => number) => judge(files, readHeld(files), now);
/** The sidecar that holds the pane and is not on its way out. */
export const liveHeld = async (files: AgentFiles) => ((h) => (h && h.state !== "leaving" ? h.held : undefined))(await holder(files));

/** One request to a sidecar's control socket: one JSON line out, one JSON line back. */
export interface Reply { ok: boolean; error?: string; text?: string; [key: string]: unknown }
/** Nothing listens on the socket (it was never made, or the sidecar behind it has ended); any other failure means a sidecar was reached. */
export class NoSidecar extends Error {}
export const ask = (socket: string, request: Record<string, unknown>, timeoutMs = 60_000) =>
	new Promise<Reply>((resolve, reject) => {
		let reply = "";
		const conn = createConnection(socket).setTimeout(timeoutMs);
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
		conn.on("data", (chunk) => {
			reply += chunk;
			if (!reply.includes("\n")) return;
			conn.destroy();
			try { resolve(JSON.parse(reply.split("\n")[0]!) as Reply); } catch { reject(new Error(`the sidecar answered ${reply.slice(0, 100)}`)); }
		});
		conn.on("timeout", () => (conn.destroy(), reject(new Error(`the sidecar did not answer within ${timeoutMs / 1000} s`))));
		conn.on("error", (error) => reject(["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") ? new NoSidecar(error.message) : error));
		conn.on("close", () => reply.includes("\n") || reject(new Error("the sidecar closed the connection without an answer")));
	});

/** pi-intercom's directory: named by STRAW_BOSS_INTERCOM, else beside this package (both live in pi's npm node_modules), else in the agent directory's npm node_modules. */
export function findIntercom(env: NodeJS.ProcessEnv = process.env, here = dirname(fileURLToPath(import.meta.url))): string {
	const agent = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const found = [env.STRAW_BOSS_INTERCOM, join(here, "..", "..", "..", "pi-intercom"), join(agent, "npm", "node_modules", "pi-intercom")].find((dir) => dir && existsSync(join(dir, "broker", "client.ts")));
	if (!found) throw new Error("pi-intercom (>= 0.17.1) was not found: install it with pi, or name its directory in STRAW_BOSS_INTERCOM");
	return found;
}
/** The tsx loader that pi-intercom starts its own broker with: the sidecar is a TypeScript file under node_modules, which Node alone refuses to run. */
export function tsxLoader(intercom: string): string {
	try {
		return createRequire(join(intercom, "package.json")).resolve("tsx");
	} catch {
		const sibling = join(intercom, "..", "tsx", "dist", "loader.mjs");
		if (existsSync(sibling)) return sibling;
		throw new Error(`the tsx loader was not found beside ${intercom}`);
	}
}
