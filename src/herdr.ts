import { execFile } from "node:child_process";

export type HerdrRun = (args: string[], timeoutMs?: number) => Promise<string>;
export type Sleep = (ms: number) => Promise<void>;
export interface Place { paneId: string; tabId: string; workspaceId: string }
export interface Workspace { workspace_id: string; label: string; tokens?: Record<string, string>; worktree?: { checkout_path?: string } }
export interface Pane { pane_id: string; tab_id: string; agent?: string; tokens?: Record<string, string> }
export interface TowerEnv { run: HerdrRun; sleep: Sleep; live(sessionId: string): Promise<boolean> }

const TTL_MS = 10 * 60_000;
const START_MS = 30_000;
const TOWER_WAIT_MS = 60_000;
const START_ATTEMPTS = 20;
const opening = new Map<string, Promise<{ id: string; opened: boolean }>>();

export const herdrRun: HerdrRun = (args, timeoutMs = 5000) =>
	new Promise((resolve, reject) => {
		execFile(process.env.HERDR_BIN_PATH || "herdr", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) reject(new Error(`herdr ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});

// Every herdr reply wraps its payload in `result`.
async function result(run: HerdrRun, args: string[], timeoutMs?: number) {
	const output = await run(args, timeoutMs);
	try {
		return JSON.parse(output).result;
	} catch {
		throw new Error(`herdr ${args.join(" ")} returned invalid JSON: ${output.slice(0, 200)}`);
	}
}

export async function place(run: HerdrRun): Promise<Place> {
	const pane = (await result(run, ["pane", "current"])).pane;
	return { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

export const workspaces = async (run: HerdrRun): Promise<Workspace[]> => (await result(run, ["workspace", "list"])).workspaces;

export async function panes(run: HerdrRun, workspace?: string): Promise<Pane[]> {
	return (await result(run, ["pane", "list", ...(workspace ? ["--workspace", workspace] : [])])).panes;
}

/** Writes display-and-discovery tokens (null clears one). Herdr takes the positional id before the options. */
export function report(run: HerdrRun, kind: "pane" | "workspace", id: string, tokens: Record<string, string | null>) {
	const flags = Object.entries(tokens).flatMap(([name, value]) => (value === null ? ["--clear-token", name] : ["--token", `${name}=${value}`]));
	const ttl = flags.includes("--token") ? ["--ttl-ms", String(TTL_MS)] : [];
	return run([kind, "report-metadata", id, "--source", "straw-boss", ...ttl, ...flags]);
}

/** Polls until `check` returns something truthy, or `ms` have passed. */
export async function waitFor<T>(sleep: Sleep, check: () => T | Promise<T>, ms: number, step = 100): Promise<Awaited<T> | undefined> {
	for (let waited = 0; waited <= ms; waited += step) {
		const value = await check();
		if (value) return value;
		await sleep(step);
	}
}

/** The live tower of a workspace, opening its `tower` tab when there is none. One opening at a time per workspace. */
export function ensureTower(env: TowerEnv, workspace: Workspace, cwd: string) {
	const existing = opening.get(workspace.workspace_id);
	if (existing) return existing;
	const pending = open(env, workspace, cwd).finally(() => opening.delete(workspace.workspace_id));
	opening.set(workspace.workspace_id, pending);
	return pending;
}

async function open({ run, sleep, live }: TowerEnv, workspace: Workspace, cwd: string) {
	const ws = workspace.workspace_id;
	const held = async () => {
		const id = (await workspaces(run)).find((w) => w.workspace_id === ws)?.tokens?.tower;
		return id && (await live(id)) ? id : undefined;
	};
	const current = await held();
	if (current) return { id: current, opened: false };

	// A leftover tower tab is reused: a pane already running pi only needs its token awaited, a shell prompt gets pi started.
	let paneId: string;
	let running = false;
	const tab = (await result(run, ["tab", "list", "--workspace", ws])).tabs.find((t: { label: string }) => t.label === "tower");
	if (tab) {
		const root = (await panes(run, ws)).find((p) => p.tab_id === tab.tab_id);
		if (!root) throw new Error(`Tower tab ${tab.tab_id} has no pane`);
		paneId = root.pane_id;
		running = root.agent === "pi";
	} else {
		const dir = workspace.worktree?.checkout_path ?? cwd;
		const created = await result(run, ["tab", "create", "--workspace", ws, "--label", "tower", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=tower"]);
		paneId = created.root_pane.pane_id;
	}
	if (!running) {
		// Herdr agent names are unique across workspaces and lowercase only, so the name carries the lowercased workspace id.
		const start = ["agent", "start", `tower-${ws.toLowerCase()}`, "--kind", "pi", "--pane", paneId, "--timeout", String(START_MS), "--", "--name", `tower · ${workspace.label}`];
		// A new tab's shell may not be at its prompt yet: herdr answers agent_pane_busy until it is, and any other failure is final.
		for (let attempt = 1; ; attempt++) {
			try {
				await run(start, START_MS + 5000);
				break;
			} catch (error) {
				if (attempt === START_ATTEMPTS || !(error as Error).message.includes("agent_pane_busy")) throw error;
				await sleep(500);
			}
		}
	}
	const id = await waitFor(sleep, held, TOWER_WAIT_MS, 1000);
	if (!id) throw new Error(`The tower of ${workspace.label} did not publish its token within ${TOWER_WAIT_MS / 1000} s (pane ${paneId})`);
	return { id, opened: true };
}
