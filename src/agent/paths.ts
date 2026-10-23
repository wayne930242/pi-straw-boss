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

/** The files of the sidecar of one pane, named by a hash of the pane id (a pane id is not a safe file name). */
export function agentFiles(stateDir: string, pane: string) {
	const base = join(stateDir, "agents", createHash("sha256").update(pane).digest("hex").slice(0, 16));
	return { dir: dirname(base), state: `${base}.json`, socket: `${base}.sock`, log: `${base}.log` };
}
export type AgentFiles = ReturnType<typeof agentFiles>;

/** What a running sidecar writes first: who holds the pane. */
export interface Held { pid: number; session: string; kind: string; pane: string; id: string; name: string; startedAt: number }

export const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};
export function readHeld(files: AgentFiles): Held | undefined {
	try {
		const held = JSON.parse(readFileSync(files.state, "utf8")) as Held;
		return typeof held.pid === "number" && typeof held.session === "string" ? held : undefined;
	} catch {
		return undefined;
	}
}
/** The sidecar that holds the pane now: its state file names a process that is running. */
export const liveHeld = (files: AgentFiles) => ((held) => (held && alive(held.pid) ? held : undefined))(readHeld(files));

/** One request to a sidecar's control socket: one JSON line out, one JSON line back. */
export interface Reply { ok: boolean; error?: string; text?: string; [key: string]: unknown }
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
		conn.on("error", reject);
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
