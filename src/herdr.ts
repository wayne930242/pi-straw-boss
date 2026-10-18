import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type HerdrRun = (args: string[], timeoutMs?: number) => Promise<string>;
/** One request on Herdr's socket API; rejects with the error Herdr answered. */
export type HerdrApi = (method: string, params: Record<string, unknown>) => Promise<void>;
/** The same request, resolving with Herdr's `result`; a rejection is a HerdrError with Herdr's code (or timeout, socket_error, bad_frame). */
export type HerdrCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
export class HerdrError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}
export type Sleep = (ms: number) => Promise<void>;
export interface Place { paneId: string; tabId: string; workspaceId: string }
export interface Workspace { workspace_id: string; label: string; agent_status?: string; tokens?: Record<string, string>; worktree?: { checkout_path?: string; is_linked_worktree?: boolean; repo_key?: string } }
export interface Pane { pane_id: string; tab_id: string; workspace_id?: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string; tokens?: Record<string, string> }
export interface HerdrTab { tab_id: string; workspace_id: string; label?: string }
export interface Location { status: string; workspace?: { id: string; label: string }; tab?: { id: string; label: string }; paneId?: string }
/** A live pi-intercom session; `status` is idle, thinking, or tool:<name>. */
export interface Session { id: string; name?: string; status?: string; herdrLocation?: Location }
export interface TowerEnv { run: HerdrRun; sleep: Sleep; live(sessionId: string): Promise<boolean>; moveFirst(tabId: string): Promise<void>; model?: string }

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

/** The user's `towerModel` from `config.json` in the state directory, read at each tower start; anything unreadable means pi's default model. */
export function towerModel(stateDir: string): string | undefined {
	let model: unknown;
	try { model = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { towerModel?: unknown }).towerModel; } catch { /* pi's default */ }
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

// The tower tab is labelled with the Nerd Font radio tower glyph (md-radio_tower, U+F043B) alone. The role marks (the `sb_mark` token, and the
// dashboard's rows) are Font Awesome's star (U+F005) for a main agent and person (U+F007) for a member, and `[sub]` for a subagent.
export const TOWER_LABEL = "\u{f043b}";
export const MARK = { main: "\uf005", member: "\uf007" } as const;
export const ARROW = "[sub]";

export async function place(run: HerdrRun): Promise<Place> {
	const pane = (await result(run, ["pane", "current"])).pane;
	return { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

/** A sub workspace is a linked git worktree that Herdr opened as its own workspace: it is treated like a subagent of its parent. */
export const isSub = (w: Workspace) => w.worktree?.is_linked_worktree === true;
export const parentOf = (all: Workspace[], w: Workspace) => all.find((p) => !isSub(p) && p.worktree?.repo_key !== undefined && p.worktree.repo_key === w.worktree?.repo_key);
/** The head tower's workspace: the first one in list order that is not a sub workspace. */
export const headOf = (all: Workspace[]) => all.find((w) => !isSub(w));

export const workspaces = async (run: HerdrRun): Promise<Workspace[]> => (await result(run, ["workspace", "list"])).workspaces;

/** The tabs of one workspace in Herdr's tab order. */
export const tabs = async (run: HerdrRun, workspace: string): Promise<HerdrTab[]> => (await result(run, ["tab", "list", "--workspace", workspace])).tabs;

export async function panes(run: HerdrRun, workspace?: string): Promise<Pane[]> {
	return (await result(run, ["pane", "list", ...(workspace ? ["--workspace", workspace] : [])])).panes;
}

// Herdr answers one request per connection with one newline-ended frame, which may arrive in pieces (split anywhere, even inside a character).
export const herdrCall = (socketPath = process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock")): HerdrCall => (method, params, timeoutMs = 5000) =>
	new Promise((resolve, reject) => {
		const socket = createConnection(socketPath).setTimeout(timeoutMs), text = new StringDecoder("utf8");
		let reply = "";
		const fail = (code: string, message: string) => (socket.destroy(), reject(new HerdrError(code, `herdr ${method} failed: ${code} ${message}`.trim())));
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: `straw-boss-${Date.now()}`, method, params })}\n`));
		socket.on("data", (chunk) => {
			reply += text.write(chunk);
			if (!reply.includes("\n")) return;
			socket.destroy();
			try {
				const { result, error } = JSON.parse(reply.split("\n")[0]!) as { result?: unknown; error?: { code?: string; message?: string } };
				if (error) fail(error.code ?? "herdr_error", error.message ?? "");
				else resolve(result);
			} catch {
				fail("bad_frame", reply.slice(0, 200));
			}
		});
		socket.on("timeout", () => fail("timeout", `no answer within ${timeoutMs} ms`));
		socket.on("error", (error) => fail("socket_error", error.message));
		socket.on("close", () => fail("closed", "the connection closed before an answer"));
	});
export const herdrApi = (socketPath?: string): HerdrApi => async (method, params) => void (await herdrCall(socketPath)(method, params));

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

async function open({ run, sleep, live, moveFirst, model }: TowerEnv, workspace: Workspace, cwd: string) {
	const ws = workspace.workspace_id;
	const held = async () => {
		const id = (await workspaces(run)).find((w) => w.workspace_id === ws)?.tokens?.tower;
		return id && (await live(id)) ? id : undefined;
	};
	const current = await held();
	if (current) return { id: current, opened: false };

	// A leftover tower tab is reused: a pane already running pi only needs its token awaited, a shell prompt gets pi started.
	// The tab is told apart by the `sb_role=tower` pane token that only Straw Boss writes; a tab merely labelled "tower"
	// (a pi-herdr-agents subagent can be named so) is someone else's.
	let paneId: string;
	let running = false;
	const marked = (await panes(run, ws)).find((p) => p.tokens?.sb_role === "tower");
	if (marked) {
		paneId = marked.pane_id;
		running = marked.agent === "pi";
		await moveFirst(marked.tab_id);
	} else {
		const dir = workspace.worktree?.checkout_path ?? cwd;
		const created = await result(run, ["tab", "create", "--workspace", ws, "--label", TOWER_LABEL, "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=tower"]);
		paneId = created.root_pane.pane_id;
		// Marked at once, so a tab left without pi is recognised (while the marker lasts) and the label stays display only.
		await report(run, "pane", paneId, { sb_role: "tower" });
		await moveFirst(created.tab.tab_id);
	}
	if (!running) {
		// Herdr agent names are unique across workspaces and lowercase only, so the name carries the lowercased workspace id.
		const start = ["agent", "start", `tower-${ws.toLowerCase()}`, "--kind", "pi", "--pane", paneId, "--timeout", String(START_MS), "--", "--name", `tower · ${workspace.label}`, ...(model ? ["--model", model] : [])];
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
