import { execFileExe } from "./exe.mjs";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { herdrSocket, localEndpoint } from "./endpoint.ts";
export { herdrSocket } from "./endpoint.ts"; // session.ts reads it here, with the rest of Herdr

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
export interface Place { paneId: string; tabId: string; workspaceId: string; terminalId?: string }
export interface Workspace { workspace_id: string; label: string; agent_status?: string; focused?: boolean; active_tab_id?: string; tokens?: Record<string, string>; worktree?: { checkout_path?: string; is_linked_worktree?: boolean; repo_key?: string } }
export interface Pane { pane_id: string; tab_id: string; workspace_id?: string; terminal_id?: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string; cwd?: string; tokens?: Record<string, string> }
export interface HerdrTab { tab_id: string; workspace_id: string; label?: string }
export interface Location { status: string; workspace?: { id: string; label: string }; tab?: { id: string; label: string }; paneId?: string }
/** A live pi-intercom session; `status` is idle, thinking, or tool:<name>. */
export interface Session { id: string; name?: string; status?: string; herdrLocation?: Location }

const TTL_MS = 10 * 60_000;
const START_MS = 30_000;
const START_ATTEMPTS = 20;

export const herdrRun: HerdrRun = (args, timeoutMs = 5000) =>
	new Promise((resolve, reject) => {
		// `deadline`, not execFile's `timeout`: the call ends by then whatever the CLI does, and a CLI cut off is ended behind it with what it started (exe.mjs; todo #155).
		execFileExe(process.env.HERDR_BIN_PATH || "herdr", args, { deadline: timeoutMs }, (error, stdout, stderr) => {
			// `stderr` is what Herdr itself said (its error code first), apart from the command line the message repeats. `killed` and `signal` say the command was cut off (the timeout) before it ended: what it was doing is unknown.
			if (error) reject(Object.assign(new Error(`herdr ${args.join(" ")} failed: ${stderr.trim() || error.message}`), { stderr: stderr.trim(), code: (error as { code?: unknown }).code, killed: (error as { killed?: unknown }).killed === true, signal: (error as { signal?: unknown }).signal ?? undefined }));
			else resolve(stdout);
		});
	});

// Every herdr reply wraps its payload in `result`.
export async function result(run: HerdrRun, args: string[], timeoutMs?: number) {
	const output = await run(args, timeoutMs);
	try {
		return JSON.parse(output).result;
	} catch {
		throw new Error(`herdr ${args.join(" ")} returned invalid JSON: ${output.slice(0, 200)}`);
	}
}

/** The user's `towerModel` from `config.json` in the state directory, read at each tower start; anything unreadable means pi's default model. */
export function towerModel(stateDir: string, key: "towerModel" | "headModel" = "towerModel"): string | undefined {
	let model: unknown;
	try { model = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as Record<string, unknown>)[key]; } catch { /* pi's default */ }
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}
/** The head tower's model: `headModel` in `config.json`, else the tower model, else pi's default; read at each start. */
export const headModel = (stateDir: string): string | undefined => towerModel(stateDir, "headModel") ?? towerModel(stateDir);

// The tower tab is labelled with the Nerd Font radio tower glyph (md-radio_tower, U+F043B) alone. The role marks (the `sb_mark` token, and the
// dashboard's rows) are one glyph per kind (`KIND_MARK` below); a main with no known kind keeps Font Awesome's star (U+F005), a member the person (U+F007), and a subagent with no known kind `[sub]`.
export const TOWER_LABEL = "\u{f043b}";
// The head tower's tab is labelled with the Nerd Font crown (md-crown, U+F01A5; checked against Hack Nerd Font's glyph names, which also give U+F043B as md-radio_tower).
export const HEAD_LABEL = "\u{f01a5}";
/** The two kinds of tower service: a workspace's tower and the head tower. Each is seated only in a tab with its own glyph (typegate.ts `seatGate`). */
export type ServiceKind = "tower" | "head";
export const SEAT_LABEL: Record<ServiceKind, string> = { tower: TOWER_LABEL, head: HEAD_LABEL };
export const MARK = { main: "\uf005", member: "\uf007", train: "\uf238", integrator: "\uf126" } as const;
/**
 * The mark of each kind (docs/specs/2026-11-09-agent-kinds.md D16), the same drawings as the page's icons. Checked against the glyph names of Nerd Fonts 3.5.1 (glyphnames.json), the version NOTICE.md pins:
 * coordinator md-ship_wheel U+F0833, integrator fa-code_fork U+F126, standing md-lighthouse U+F09FF, train fa-train U+F238, worker md-wrench U+F05B7, scout md-binoculars U+F00A5,
 * planner md-pencil_ruler U+F1353, reviewer md-magnify U+F0349, watchdog md-dog U+F0A43. A main with no known kind keeps `MARK.main`, a subagent with none `ARROW`.
 */
export const KIND_MARK = { coordinator: "\u{f0833}", integrator: MARK.integrator, standing: "\u{f09ff}", train: MARK.train, worker: "\u{f05b7}", scout: "\u{f00a5}", planner: "\u{f1353}", reviewer: "\u{f0349}", watchdog: "\u{f0a43}" } as const;
export const ARROW = "[sub]";
/** The `sb_mark` prefix of an ally run's pane; the device's label follows it. */
export const ALLY_MARK = "[ally]";

// The stand-in agent: the sb server reports `tower` on a standing pane while the tower prompt runs there, so the tower keeps its row in Herdr's Agents list between runs (docs/how-it-works.md,
// The standing pane). Herdr clears a reported agent about a second after the pane's foreground is back at its idle shell prompt, whatever the label, which is why the prompt is a process of its
// own that stays in the foreground; and it takes the pane back from a real agent that starts in it by itself (checked on Herdr 0.9.5).
export const STANDIN_AGENT = "tower";
/** The head tower's standing pane shows its stand-in under this label (docs/specs/2026-11-04-head-tower.md, The head workspace). */
export const STANDIN_HEAD = "head";
export const STANDIN_SOURCE = "straw-boss";
/** Whether the pane shows the stand-in, a tower's or the head's. The label alone: the tokens that name the pane's role lapse after 10 minutes while the prompt goes on. */
export const isStandin = (pane: Pick<Pane, "agent">) => pane.agent === STANDIN_AGENT || pane.agent === STANDIN_HEAD;
let lastSeq = 0;
/** A `seq` Herdr takes: above the last one this process sent and in the space of Herdr's own pi integration (the clock in microseconds), since Herdr ignores a report or release whose seq is not above the last one it took. */
export const nextSeq = (now = Date.now()) => (lastSeq = Math.max(lastSeq + 1, now * 1000));
/** Reports the stand-in: idle, with a short state as the message. No resume command and no session, so a restart of Herdr never relaunches it. */
export const reportStandin = (api: HerdrApi, paneId: string, message: string, agent: string = STANDIN_AGENT) =>
	api("pane.report_agent", { pane_id: paneId, source: STANDIN_SOURCE, agent, state: "idle", message, seq: nextSeq() });
export const releaseStandin = (api: HerdrApi, paneId: string, agent: string = STANDIN_AGENT) => api("pane.release_agent", { pane_id: paneId, source: STANDIN_SOURCE, agent, seq: nextSeq() });

export async function place(run: HerdrRun): Promise<Place> {
	const pane = (await result(run, ["pane", "current"])).pane;
	return { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id, ...(pane.terminal_id ? { terminalId: pane.terminal_id } : {}) };
}

/** A sub workspace is a linked git worktree that Herdr opened as its own workspace: it is treated like a subagent of its parent. */
export const isSub = (w: Workspace) => w.worktree?.is_linked_worktree === true;
export const parentOf = (all: Workspace[], w: Workspace) => all.find((p) => !isSub(p) && p.worktree?.repo_key !== undefined && p.worktree.repo_key === w.worktree?.repo_key);
/** The head workspace carries the token `sb_head` (the head service writes it, as a tower writes `tower`); a workspace of the boss's with the same label never does. */
export const isHead = (w: Workspace) => Boolean(w.tokens?.sb_head);
/** The head tower's workspace: the one that carries `sb_head`; undefined until the head exists. The first workspace in Herdr's list is not the head tower any more (docs/specs/2026-11-04-head-tower.md, What replaces "head tower = first workspace"). */
export const headTowerOf = (all: Workspace[]) => all.find(isHead);
export const headOf = headTowerOf;

export const workspaces = async (run: HerdrRun): Promise<Workspace[]> => (await result(run, ["workspace", "list"])).workspaces;

/** The tabs of one workspace in Herdr's tab order. */
export const tabs = async (run: HerdrRun, workspace: string): Promise<HerdrTab[]> => (await result(run, ["tab", "list", "--workspace", workspace])).tabs;

export async function panes(run: HerdrRun, workspace?: string): Promise<Pane[]> {
	return (await result(run, ["pane", "list", ...(workspace ? ["--workspace", workspace] : [])])).panes;
}

// Herdr answers one request per connection with one newline-ended frame, which may arrive in pieces (split anywhere, even inside a character).
export const herdrCall = (socketPath = herdrSocket()): HerdrCall => (method, params, timeoutMs = 5000) =>
	new Promise((resolve, reject) => {
		const socket = createConnection(localEndpoint(socketPath)), text = new StringDecoder("utf8");
		let reply = "";
		const fail = (code: string, message: string) => (clearTimeout(timer), socket.destroy(), reject(new HerdrError(code, `herdr ${method} failed: ${code} ${message}`.trim())));
		// A deadline for the whole answer, not the socket's idle timeout, which every piece of a frame that never ends would renew.
		const timer = setTimeout(() => fail("timeout", `no answer within ${timeoutMs} ms`), timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: `straw-boss-${Date.now()}`, method, params })}\n`));
		socket.on("data", (chunk) => {
			reply += text.write(chunk);
			if (!reply.includes("\n")) return;
			clearTimeout(timer);
			socket.destroy();
			try {
				const { result, error } = JSON.parse(reply.split("\n")[0]!) as { result?: unknown; error?: { code?: string; message?: string } };
				if (error) fail(error.code ?? "herdr_error", error.message ?? "");
				else resolve(result);
			} catch {
				fail("bad_frame", reply.slice(0, 200));
			}
		});
		socket.on("error", (error) => fail("socket_error", error.message));
		socket.on("close", () => fail("closed", "the connection closed before an answer"));
	});
export const herdrApi = (socketPath?: string): HerdrApi => async (method, params) => void (await herdrCall(socketPath)(method, params));

/** The read-only listings Herdr answers on its socket as the CLI would: the CLI arguments in, the socket request out. */
function listing(args: string[]): { method: string; params: Record<string, unknown> } | undefined {
	const [group, cmd, flag, id, ...more] = args;
	if (cmd !== "list" || more.length || (flag === undefined) !== (id === undefined) || (flag !== undefined && flag !== "--workspace")) return undefined;
	if (group === "workspace" && flag === undefined) return { method: "workspace.list", params: {} };
	if (group === "pane") return { method: "pane.list", params: id === undefined ? {} : { workspace_id: id } };
	if (group === "tab" && id !== undefined) return { method: "tab.list", params: { workspace_id: id } };
	return undefined;
}

/** `pane current` as the CLI asks it, for the pane the process runs in; without HERDR_PANE_ID the CLI's own answer is left to it. */
function current(args: string[], pane: string | undefined): { method: string; params: Record<string, unknown> } | undefined {
	return args.length === 2 && args[0] === "pane" && args[1] === "current" && pane ? { method: "pane.current", params: { caller_pane_id: pane } } : undefined;
}

/** `<pane|workspace> report-metadata <id> --source S [--ttl-ms N] [--token k=v]... [--clear-token k]...` as its socket request; anything else is left to the CLI. */
function metadata(args: string[]): { method: string; params: Record<string, unknown> } | undefined {
	const [kind, cmd, id, ...flags] = args;
	if ((kind !== "pane" && kind !== "workspace") || cmd !== "report-metadata" || !id || flags.length % 2) return undefined;
	const tokens: Record<string, string | null> = {};
	let source: string | undefined, ttl: number | undefined;
	for (let i = 0; i < flags.length; i += 2) {
		const [flag, value] = [flags[i]!, flags[i + 1]!], at = value.indexOf("=");
		if (flag === "--source") source = value;
		else if (flag === "--ttl-ms" && /^\d+$/.test(value)) ttl = Number(value);
		else if (flag === "--token" && at > 0) tokens[value.slice(0, at)] = value.slice(at + 1);
		else if (flag === "--clear-token") tokens[value] = null;
		else return undefined;
	}
	if (!source) return undefined;
	return { method: `${kind}.report_metadata`, params: { [kind === "pane" ? "pane_id" : "workspace_id"]: id, source, tokens, ...(ttl === undefined ? {} : { ttl_ms: ttl }) } };
}

/**
 * `run` with Herdr's listings (`pane list`, `workspace list`, `tab list --workspace`), `pane current`, and `report-metadata` answered over the socket
 * instead of by a spawned CLI: the same `{result}` text, so every caller works unchanged. A spawned CLI costs a process start on every call, which a
 * loaded machine turns into seconds, and these are the calls every session makes as it starts and on its timers. Every other command still goes to `run`.
 * A request that fails rejects with Herdr's own error (a HerdrError with its code); nothing falls back to the CLI.
 */
export const socketRun = (run: HerdrRun, call: HerdrCall, pane = process.env.HERDR_PANE_ID): HerdrRun => async (args, timeoutMs) => {
	const request = listing(args) ?? current(args, pane) ?? metadata(args);
	return request ? JSON.stringify({ result: await call(request.method, request.params, timeoutMs) }) : run(args, timeoutMs);
};

/** Every pane and workspace as one reading, with the tabs of one workspace when it is asked for. */
export interface World { panes: Pane[]; workspaces: Workspace[]; tabs: HerdrTab[] }
export type HerdrWorld = (tabsOf?: string) => Promise<World>;
/** The world from the listings, asked together. */
export const worldOf = (run: HerdrRun): HerdrWorld => async (tabsOf) => {
	const [ps, all, tabList] = await Promise.all([panes(run), workspaces(run), tabsOf ? tabs(run, tabsOf) : []]);
	return { panes: ps, workspaces: all, tabs: tabList };
};
/**
 * The world from one `session.snapshot`: its panes, workspaces, and tabs are what the listings answer. Herdr 0.9.5 answers a request about 100 ms late
 * now and then (one in six when asked alone, and every one that comes straight after another connection, whatever the first asked), so what is
 * read on a timer takes one request instead of two or three.
 */
export const herdrWorld = (call: HerdrCall): HerdrWorld => async (tabsOf) => {
	const { snapshot } = (await call("session.snapshot", {})) as { snapshot?: { panes?: Pane[]; workspaces?: Workspace[]; tabs?: HerdrTab[] } };
	if (!Array.isArray(snapshot?.panes) || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs)) throw new Error("herdr session.snapshot returned no panes, workspaces, or tabs");
	return { panes: snapshot.panes, workspaces: snapshot.workspaces, tabs: tabsOf ? snapshot.tabs.filter((t) => t.workspace_id === tabsOf) : [] };
};

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

/** A new tab in `dir` that does not take focus, with `env` (NAME=value) in its panes. */
export async function createTab(run: HerdrRun, workspace: string, dir: string, env: string[], label?: string) {
	const created = await result(run, ["tab", "create", "--workspace", workspace, ...(label ? ["--label", label] : []), "--cwd", dir, "--no-focus", ...env.flatMap((e) => ["--env", e])]);
	return { tabId: created.tab.tab_id as string, paneId: created.root_pane.pane_id as string };
}

/** Starts pi in the pane under a Herdr agent name. A new tab's shell may not be at its prompt yet: herdr answers agent_pane_busy until it is, and any other failure is final. */
export class StartUnproven extends Error {}
/** `proven`: asked before each retry after a busy answer; the pane may have changed hands while the start waited. */
export async function startPi(run: HerdrRun, sleep: Sleep, name: string, paneId: string, piArgs: string[], proven?: () => Promise<boolean>) {
	const start = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(START_MS), "--", ...piArgs];
	for (let attempt = 1; ; attempt++) {
		try {
			return await run(start, START_MS + 5000);
		} catch (error) {
			if (attempt === START_ATTEMPTS || !(error as Error).message.includes("agent_pane_busy")) throw error;
			await sleep(500);
			if (proven && !(await proven())) throw new StartUnproven(`the pane ${paneId} is no longer proven to be the one the start was made for`);
		}
	}
}
