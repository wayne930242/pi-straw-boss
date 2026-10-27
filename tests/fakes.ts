import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jsqr from "jsqr";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOWER_LABEL } from "../src/herdr.ts";
import { createStrawBoss, type Deps } from "../src/index.ts";
import type { HerdrWatch } from "../src/server-watch.ts";

// jsQR is CommonJS: Node hands its function over as the default export, while its types describe an ES module namespace.
type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string; version: number } | null;
const jsQR = ((jsqr as unknown as { default?: Decode }).default ?? jsqr) as unknown as Decode;

/** The code as a grayscale image (4 px per module, a 4-module quiet zone), read back by an independent decoder. */
export function decode(m: boolean[][]) {
	const scale = 4, n = (m.length + 8) * scale, px = new Uint8ClampedArray(n * n * 4);
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const dark = m[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4] ?? false, i = (y * n + x) * 4;
			px.fill(dark ? 0 : 255, i, i + 3);
			px[i + 3] = 255;
		}
	return jsQR(px, n, n);
}

/** The modules of a QR drawn for the terminal (`qrLines`: light as blocks, two rows per line), quiet zone included. */
export const fromLines = (lines: string[]) => lines.flatMap((line) => [[...line].map((c) => c === " " || c === "▄"), [...line].map((c) => c === " " || c === "▀")]);

/** A message as the person wrote it, without the header Straw Boss puts before it (src/header.ts). */
export const bare = (message: string) => message.replace(/^\[straw net [^\]]*\] /, "");

export const PROMPT_DIR = fileURLToPath(new URL("../prompts", import.meta.url));
const NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => unknown, what: string, ms = 3000): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(2)) if (await check()) return;
	throw new Error(`Timed out waiting for ${what}`);
}
export const settle = async () => {
	for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Tokens { [name: string]: string }
interface FakePane { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string; tokens: Tokens; env?: string[]; cwd?: string; processes?: { argv?: string[]; argv0?: string; name?: string }[] }
interface FakeWorkspace { workspace_id: string; label: string; agent_status?: string; focused?: boolean; active_tab_id?: string; tokens: Tokens; worktree?: { checkout_path?: string; is_linked_worktree?: boolean; repo_key?: string } }

/** A tiny Herdr: workspaces, tabs, panes, and the CLI subcommands the extension calls. */
export class FakeHerdr {
	workspaces: FakeWorkspace[] = [
		{ workspace_id: "wA", label: "Alpha", tokens: {}, worktree: { checkout_path: "/w/alpha" } },
		{ workspace_id: "wB", label: "Beta", tokens: {} },
	];
	tabs = [
		{ tab_id: "wA:t1", label: "work", workspace_id: "wA" },
		{ tab_id: "wA:t2", label: "docs", workspace_id: "wA" },
		{ tab_id: "wB:t1", label: "ops", workspace_id: "wB" },
	];
	panes: FakePane[] = [];
	calls: string[][] = [];
	/** What `agent prompt` typed into a pane, and the gate options it carried. */
	prompts: { pane: string; text: string; args: string[] }[] = [];
	/** Every `agent prompt` asked for, typed or not, and a switch that makes one fail with the Herdr code it returns (a stall after the input was sent, for one). */
	promptTries: string[] = [];
	failPrompt?: (text: string) => string | undefined;
	closed: string[] = [];
	/** Socket API calls, and a switch that makes `tab.move` fail as an unreachable socket would. */
	moves: { tab_id: string; insert_index: number }[] = [];
	failMove = false;
	/** Makes every `list` call fail, as a Herdr that cannot answer. */
	failReads = false;
	/** Pane lists fail while this is set (the workspace and tab lists still answer). */
	failPanes = false;
	wsTokenHistory: (string | undefined)[] = [];
	onAgentStart?: (pane: FakePane) => void;
	onTabClose?: (paneIds: string[]) => void;
	/** Herdr's event stream, as `events.subscribe` delivers it: workspace token changes, closed panes, and agents detected in a pane. */
	private listeners = new Set<{ types: string[]; on: (e: { event: string; data: Record<string, unknown> } | null) => void }>();
	events = (types: string[], on: (e: { event: string; data: Record<string, unknown> } | null) => void) => {
		const l = { types, on };
		this.listeners.add(l);
		queueMicrotask(() => this.listeners.has(l) && on(null));
		return () => void this.listeners.delete(l);
	};
	/** How many event subscriptions listen for `type`. */
	listening = (type: string) => [...this.listeners].filter((l) => l.types.includes(type)).length;
	/** Delivers an event of `type` to whoever subscribed to it, as Herdr's event stream does. */
	emit(type: string, event: string, data: Record<string, unknown>) {
		for (const l of [...this.listeners]) if (l.types.includes(type)) queueMicrotask(() => l.on({ event, data }));
	}
	private next = 100;
	private terminals = 0;
	/** A new server starts with no tokens: the old one kept them in memory. Panes, tabs and workspaces stay, as after a live handoff. */
	restart(): void {
		for (const holder of [...this.panes, ...this.workspaces]) holder.tokens = {};
		for (const pane of this.panes) pane.terminal_id = `term_${this.terminals++}`; // a restored pane runs in a new terminal; its id is the same
		this.wsTokenHistory.length = 0;
		this.calls.length = 0;
	}
	private agentNames = new Map<string, string>(); // name → pane: Herdr frees a name with its pane (checked on Herdr itself)
	/** The next this-many `agent start` calls fail with agent_pane_busy, as a new tab's shell does before its prompt. */
	busy = 0;

	/** A pane running pi, or "shell" for a bare shell prompt. */
	addPane(paneId: string, tabId: string, agent = "pi"): FakePane {
		const pane = { pane_id: paneId, tab_id: tabId, workspace_id: tabId.split(":")[0]!, terminal_id: `term_${this.terminals++}`, agent: agent === "shell" ? undefined : agent, tokens: {} };
		this.panes.push(pane);
		return pane;
	}
	addTab(tabId: string, label: string, paneId?: string, agent?: string): void {
		this.tabs.push({ tab_id: tabId, label, workspace_id: tabId.split(":")[0]! });
		if (paneId) this.addPane(paneId, tabId, agent);
	}
	pane(id: string) {
		const pane = this.panes.find((p) => p.pane_id === id);
		if (!pane) throw new Error(`no pane ${id}`);
		return pane;
	}
	workspace(id: string) {
		return this.workspaces.find((w) => w.workspace_id === id)!;
	}
	commands(group: string, cmd: string) {
		return this.calls.filter((args) => args[0] === group && args[1] === cmd);
	}
	api = async (method: string, params: object) => {
		if (method !== "tab.move") throw new Error(`unexpected herdr api call: ${method}`);
		if (this.failMove) throw new Error("herdr tab.move failed: connect ENOENT");
		const { tab_id, insert_index } = params as { tab_id: string; insert_index: number };
		this.moves.push({ tab_id, insert_index });
		const tab = this.tabs.find((t) => t.tab_id === tab_id);
		if (!tab) throw new Error(`herdr tab.move failed: tab_not_found tab ${tab_id} not found`);
		this.tabs = [...this.tabs.filter((t) => t !== tab).slice(0, insert_index), tab, ...this.tabs.filter((t) => t !== tab).slice(insert_index)];
	};
	runFor(self: string) {
		return async (args: string[]) => this.handle(self, args);
	}

	private handle(self: string, args: string[]): string {
		this.calls.push(args);
		const [group, cmd] = args;
		const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
		const out = (result: unknown) => JSON.stringify({ result });
		if (this.failReads && cmd === "list") throw new Error(`herdr ${args.join(" ")} failed: not answering`);
		if (this.failPanes && group === "pane" && cmd === "list") throw new Error("herdr pane list failed: not answering");
		if (group === "pane" && cmd === "current") return out({ pane: this.pane(self) });
		// The foreground processes of a pane, as Herdr lists them (a launch script shows its argv; pi shows only its argv0).
		if (group === "pane" && cmd === "process-info") return out({ process_info: { pane_id: flag("--pane"), foreground_processes: this.pane(flag("--pane")!).processes ?? [] } });
		if (group === "workspace" && cmd === "list") return out({ workspaces: this.workspaces });
		if (group === "pane" && cmd === "list") return out({ panes: this.panes.filter((p) => !flag("--workspace") || p.workspace_id === flag("--workspace")) });
		if (group === "tab" && cmd === "list") return out({ tabs: this.tabs.filter((t) => t.workspace_id === flag("--workspace")) });
		if (group === "tab" && cmd === "create") {
			const id = `${flag("--workspace")}:t${this.next++}`;
			this.addTab(id, flag("--label") ?? "", `${flag("--workspace")}:p${this.next++}`, "shell");
			Object.assign(this.panes.at(-1)!, { cwd: flag("--cwd"), env: args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]!] : [])) });
			return out({ tab: { tab_id: id }, root_pane: { pane_id: this.panes.at(-1)!.pane_id } });
		}
		if (group === "workspace" && cmd === "create") {
			const ws = `w${this.next++}`, tab = `${ws}:t${this.next++}`;
			this.workspaces.push({ workspace_id: ws, label: flag("--label") ?? "", tokens: {} });
			this.addTab(tab, "", `${ws}:p${this.next++}`, "shell");
			Object.assign(this.panes.at(-1)!, { cwd: flag("--cwd"), env: args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]!] : [])) });
			return out({ workspace: { workspace_id: ws, label: flag("--label") }, tab: { tab_id: tab }, root_pane: { pane_id: this.panes.at(-1)!.pane_id } });
		}
		if (group === "pane" && cmd === "split") {
			const lead = this.pane(args[2]!), id = `${lead.workspace_id}:p${this.next++}`;
			this.addPane(id, lead.tab_id, "shell");
			Object.assign(this.panes.at(-1)!, { cwd: flag("--cwd"), env: args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]!] : [])) });
			return out({ pane: { pane_id: id } });
		}
		if (group === "pane" && cmd === "close") {
			this.closed.push(args[2]!);
			this.emit("pane.closed", "pane_closed", { pane_id: args[2]!, workspace_id: args[2]!.split(":")[0]! });
			const tab = this.panes.find((p) => p.pane_id === args[2])?.tab_id;
			this.panes = this.panes.filter((p) => p.pane_id !== args[2]);
			if (!this.panes.some((p) => p.tab_id === tab)) this.tabs = this.tabs.filter((t) => t.tab_id !== tab); // as Herdr closes an emptied tab
			return out({});
		}
		if (group === "workspace" && cmd === "close") {
			this.closed.push(args[2]!);
			this.workspaces = this.workspaces.filter((w) => w.workspace_id !== args[2]);
			this.tabs = this.tabs.filter((t) => t.workspace_id !== args[2]);
			this.panes = this.panes.filter((p) => p.workspace_id !== args[2]);
			return out({});
		}
		if (group === "tab" && cmd === "rename") {
			const tab = this.tabs.find((t) => t.tab_id === args[2]);
			if (!tab) throw new Error(`herdr tab rename failed: tab_not_found ${args[2]}`);
			tab.label = args.slice(3).join(" ");
			return out({});
		}
		if (group === "agent" && cmd === "prompt") {
			const pane = this.pane(args[2]!);
			this.promptTries.push(args[3]!);
			if (pane.agent_status === "blocked") throw Object.assign(new Error(`herdr ${args.join(" ")} failed: agent_blocked: agent is blocked`), { stderr: "agent_blocked: agent is blocked" });
			const code = this.failPrompt?.(args[3]!);
			if (code) throw Object.assign(new Error(`herdr ${args.join(" ")} failed: ${code}`), { stderr: code });
			this.prompts.push({ pane: pane.pane_id, text: args[3]!, args: args.slice(4) });
			return out({ type: "agent_prompted", agent: { pane_id: pane.pane_id, agent: pane.agent } });
		}
		if (group === "agent" && cmd === "start") {
			if (this.busy-- > 0) throw new Error(`herdr ${args.join(" ")} failed: agent_pane_busy: agent target pane ${flag("--pane")} is not an available shell`);
			if (!/^[a-z][a-z0-9_-]{0,31}$/.test(args[2]!)) throw new Error(`herdr agent start failed: invalid_agent_name: ${args[2]}`);
			if (this.panes.some((p) => p.pane_id === this.agentNames.get(args[2]!))) throw new Error(`herdr agent start failed: agent_name_taken: agent name ${args[2]} is already used`);
			this.agentNames.set(args[2]!, flag("--pane")!);
			const pane = this.pane(flag("--pane")!);
			pane.agent = "pi";
			this.emit("pane.agent_detected", "pane_agent_detected", { pane_id: pane.pane_id, workspace_id: pane.workspace_id, agent: "pi" });
			this.onAgentStart?.(pane);
			return out({});
		}
		if (cmd === "report-metadata") {
			// Herdr takes the positional id before the options; anything else fails like the real CLI.
			if (args[3] !== "--source") throw new Error(`unknown option in ${args.join(" ")}`);
			const target = group === "pane" ? this.pane(args[2]!).tokens : this.workspace(args[2]!).tokens;
			// Herdr's limits: 16 token changes a report, 32 tokens a pane or workspace, and a value cut to 80 characters with its newlines dropped.
			if (args.filter((arg) => arg === "--token" || arg === "--clear-token").length > 16) throw new Error("herdr report-metadata failed: invalid_metadata_token a metadata report may update at most 16 tokens");
			const next = { ...target };
			args.forEach((arg, i) => {
				if (arg === "--token") next[args[i + 1]!.split("=")[0]!] = Array.from(args[i + 1]!.split("=").slice(1).join("=").replace(/\n/g, "")).slice(0, 80).join("");
				if (arg === "--clear-token") delete next[args[i + 1]!];
			});
			if (Object.keys(next).length > 32) throw new Error(`herdr report-metadata failed: invalid_metadata_token ${group} metadata may contain at most 32 tokens`);
			for (const key of Object.keys(target)) delete target[key];
			Object.assign(target, next);
			if (group === "workspace") this.wsTokenHistory.push(target.tower);
			if (group === "workspace") this.emit("workspace.metadata_updated", "workspace_metadata_updated", { workspace: this.workspace(args[2]!) });
			return out({});
		}
		if (group === "tab" && cmd === "close") {
			this.closed.push(args[2]!);
			const gone = this.panes.filter((p) => p.tab_id === args[2]).map((p) => p.pane_id);
			this.panes = this.panes.filter((p) => p.tab_id !== args[2]);
			this.tabs = this.tabs.filter((t) => t.tab_id !== args[2]);
			this.onTabClose?.(gone);
			return out({});
		}
		if (group === "tab" && cmd === "focus") return out({});
		throw new Error(`unexpected herdr call: ${args.join(" ")}`);
	}
}

export interface Registration { namespace: string; ownerEligible: boolean; onReady(channel: unknown): void; onEvent(event: Record<string, unknown>): void }

/** What the broker needs of a connected session: a pi `Agent`, or a net sidecar's stand-in (agent-fakes.ts), which also hears the messages sent to it. */
export interface Peer { id: string; name: string; pane: string; status?: string; regs: Map<string, Registration>; receive?(from: { id: string; name?: string }, text: string, messageId: string): void }

/** A tiny pi-intercom broker: owner by connection order, compare-and-swap-free state, an outbox. */
export class FakeBroker {
	sessions = new Map<string, Peer>();
	owners = new Map<string, string>();
	/** A claim published to the owner is lost on the way, as when the owner does not answer in time. */
	dropClaims = false;
	states = new Map<string, { revision: number; payload: unknown }>();
	delivered: { from: string; to: string; message: string; tokens: string }[] = [];
	failing = new Set<string>();
	supported = true;
	connected = true;
	registrations: { id: string; namespace: string; ownerEligible: boolean }[] = [];
	published: { from: string; ns: string; payload: unknown; options?: { audience?: string; ownerOnly?: boolean } }[] = [];
	private epochs = new Map<string, string>();
	events = 0;
	private epoch = 0;
	private herdr: FakeHerdr;
	constructor(herdr: FakeHerdr) {
		this.herdr = herdr;
	}

	connect(agent: Peer): void {
		this.sessions.set(agent.id, agent);
	}
	register(agent: Peer, registration: Registration): void {
		if (!NAMESPACE.test(registration.namespace)) throw new Error(`Invalid intercom extension namespace: ${registration.namespace}`);
		if (agent.regs.has(registration.namespace)) throw new Error(`Intercom extension namespace already registered: ${registration.namespace}`);
		agent.regs.set(registration.namespace, registration);
		this.registrations.push({ id: agent.id, namespace: registration.namespace, ownerEligible: registration.ownerEligible });
		const ns = registration.namespace;
		registration.onReady({
			snapshot: () => ({ connected: this.connected, supported: this.supported, owner: this.ownerOf(ns), state: this.states.get(ns) }),
			// Receivers get the sender the broker assigns and the owner with its epoch; an ownerOnly message from anyone but the owner is dropped.
			publish: (payload: unknown, options?: { audience?: string; ownerOnly?: boolean }) => {
				const owner = this.owners.get(ns), event = { type: "message", fromSessionId: agent.id, owner: this.ownerOf(ns), payload };
				if (!this.connected) throw new Error("Intercom is not connected");
				this.published.push({ from: agent.id, ns, payload, options });
				if (options?.ownerOnly && owner !== agent.id) return;
				if (this.dropClaims && (payload as { type?: string })?.type === "claim") return;
				if (options?.audience === "capable") this.capable(ns).forEach((id) => this.deliver(id, ns, event));
				else if (owner) this.deliver(owner, ns, event);
			},
			commitState: (payload: unknown) => {
				if (this.owners.get(ns) !== agent.id) throw new Error(`Current session is not the owner of ${ns}`);
				const state = { revision: (this.states.get(ns)?.revision ?? 0) + 1, payload };
				this.states.set(ns, state);
				this.capable(ns).forEach((id) => this.deliver(id, ns, { type: "state", state }));
			},
			listSessions: async () => [...this.sessions.values()].map((s) => this.info(s)),
		});
		this.deliver(agent.id, ns, { type: "connection", connected: true, supported: true });
		this.elect(ns);
	}
	disconnect(agent: Peer): void {
		this.sessions.delete(agent.id);
		for (const ns of agent.regs.keys()) this.elect(ns);
		for (const other of this.sessions.values()) for (const ns of other.regs.keys()) this.deliver(other.id, ns, { type: "session_left", sessionId: agent.id });
	}
	/** What each sender's message id carried: pi-intercom refuses an id again with other content, and a restarted pi keeps its session id. */
	private ids = new Map<string, string>();
	outbox(from: Agent, request: { requestId: string; to: string; message: string }): void {
		const target = this.sessions.get(request.to), used = `${from.id}|${request.requestId}`;
		const reused = this.ids.has(used) && this.ids.get(used) !== request.message;
		this.ids.set(used, this.ids.get(used) ?? request.message);
		const status = reused ? { status: "failed", code: "delivery_failed", detail: "Message id was reused with different authored content" } : !target ? { status: "blocked", code: "target_not_found" } : this.failing.has(request.to) ? { status: "failed", code: "delivery_failed" } : { status: "sent" };
		if (status.status === "sent") this.delivered.push({ from: from.id, to: request.to, message: request.message, tokens: JSON.stringify(this.herdr.workspaces.map((w) => w.tokens.tower)) });
		if (status.status === "sent") target?.receive?.({ id: from.id, name: from.name }, request.message, request.requestId);
		setImmediate(() => from.emit("intercom:outbox-result", { version: 1, requestId: request.requestId, ...status }));
	}
	/** What pi-intercom's listSessions() would answer right now. */
	async sessionList() {
		return [...this.sessions.values()].map((s) => this.info(s));
	}
	ownerOf(ns: string) {
		const sessionId = this.owners.get(ns);
		return sessionId ? { sessionId, epoch: this.epochs.get(ns) ?? "e" } : undefined;
	}

	private capable(ns: string) {
		return [...this.sessions.values()].filter((s) => s.regs.has(ns)).map((s) => s.id);
	}
	private elect(ns: string): void {
		const winner = [...this.sessions.values()].find((s) => s.regs.get(ns)?.ownerEligible);
		if (winner?.id === this.owners.get(ns)) return;
		if (winner) this.owners.set(ns, winner.id);
		else this.owners.delete(ns);
		const owner = winner ? { sessionId: winner.id, epoch: `e${++this.epoch}` } : undefined;
		if (owner) this.epochs.set(ns, owner.epoch);
		this.capable(ns).forEach((id) => this.deliver(id, ns, { type: "owner", ...(owner ? { owner } : {}) }));
	}
	private deliver(id: string, ns: string, event: Record<string, unknown>): void {
		this.events++;
		setImmediate(() => this.sessions.get(id)?.regs.get(ns)?.onEvent(event));
	}
	private info(agent: Peer) {
		const pane = this.herdr.panes.find((p) => p.pane_id === agent.pane);
		const tab = this.herdr.tabs.find((t) => t.tab_id === pane?.tab_id);
		const workspace = this.herdr.workspaces.find((w) => w.workspace_id === pane?.workspace_id);
		return {
			id: agent.id,
			name: agent.name,
			status: agent.status,
			herdrLocation: pane && tab && workspace ? { status: "current", paneId: pane.pane_id, tab: { id: tab.tab_id, label: tab.label }, workspace: { id: workspace.workspace_id, label: workspace.label } } : { status: "not_hosted" },
		};
	}
}

export interface AgentOptions { id: string; name?: string; pane: string; env?: Record<string, string>; entries?: { customType: string; data: unknown }[]; outsideHerdr?: boolean; noIntercom?: boolean; ui?: boolean; deps?: Partial<Deps> }

export interface FakeTui { renders: number; requestRender(): void }
export interface Overlay { render(width: number): string[]; handleInput?(data: string): void }
type WidgetFactory = (tui: FakeTui, theme: { fg(tone: string, text: string): string; bold(text: string): string }) => { render(width: number): string[]; dispose?(): void };

/** One pi session running the extension, plus the parts of pi and pi-intercom it talks to. */
export class Agent {
	id: string;
	name: string;
	pane: string;
	regs = new Map<string, Registration>();
	tools = new Map<string, ToolDefinition>();
	commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?(prefix: string): { value: string }[] | null }>();
	entries: { customType: string; data: unknown }[];
	notices: { text: string; level?: string }[] = [];
	/** Messages the extension handed pi with pi.sendMessage. */
	sent: { customType: string; content: string; deliverAs?: string; triggerTurn?: boolean; details?: unknown }[] = [];
	/** Each ctx.ui.custom overlay, open until it closes itself. */
	overlays: (Overlay & { closed: boolean })[] = [];
	/** What pi-intercom reports as this session's status. */
	status = "idle";
	/** What pi's context says of the run: `isIdle()` and `hasPendingMessages()`. */
	idle = true;
	pending = false;
	/** The session file pi would name, and the run's abort signal (ctx.signal). */
	file?: string;
	/** Entries of the transcript besides the extension's own (custom messages, for instance), as ctx.sessionManager.getEntries() returns them. */
	transcript: { type: string; customType?: string; details?: unknown }[] = [];
	signal?: AbortSignal;
	/** The tool's working directory, as pi's ctx.cwd. */
	cwd?: string;
	/** Each ctx.ui.select and confirm, open until the test settles it or its signal aborts (which resolves undefined or false, as pi's dialogs do). */
	dialogs: { kind: "select" | "confirm"; title: string; second: unknown; opts?: { signal?: AbortSignal; timeout?: number }; settle(value: unknown): void; settled: boolean }[] = [];
	/** The session's ctx.ui, the one object every extension reaches. */
	get ui(): Record<string, (...args: never[]) => unknown> {
		return (this.ctx as { ui: Record<string, (...args: never[]) => unknown> }).ui;
	}
	/** Widgets set through ctx.ui.setWidget, and the live component of each. */
	widgets = new Map<string, WidgetFactory | undefined>();
	components = new Map<string, { render(width: number): string[]; dispose?(): void }>();
	tui: FakeTui = { renders: 0, requestRender: () => void this.tui.renders++ };
	stopped = false;
	env?: Record<string, string | undefined>;
	private handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	readonly bus = new Map<string, ((data: unknown) => void)[]>();
	private ctx: unknown;

	world: World;
	constructor(world: World, options: AgentOptions) {
		this.world = world;
		this.id = options.id;
		this.name = options.name ?? options.id;
		this.pane = options.pane;
		this.entries = [...(options.entries ?? [])];
		const self = this;
		this.ctx = {
			hasUI: Boolean(options.ui),
			get signal() { return self.signal; },
			get cwd() { return self.cwd; },
			isIdle: () => self.idle,
			hasPendingMessages: () => self.pending,
			shutdown: () => void self.stop("quit"), // pi quits as /quit would
			ui: {
				notify: (text: string, level?: string) => this.notices.push({ text, level }),
				select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => this.dialog("select", title, options, opts),
				confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => this.dialog("confirm", title, message, opts),
				input: async () => "typed",
				editor: async () => "edited",
				// An overlay stays open until it calls done; the test drives it through `overlays`.
				custom: (factory: (tui: FakeTui, theme: unknown, keys: unknown, done: () => void) => Overlay) => new Promise<void>((resolve) => this.overlays.push({ ...factory(this.tui, {}, {}, () => ((this.overlays.at(-1)!.closed = true), resolve())), closed: false })),
				setWidget: (key: string, factory?: WidgetFactory) => {
					this.components.get(key)?.dispose?.();
					this.components.delete(key);
					this.widgets.set(key, factory);
					if (factory) this.components.set(key, factory(this.tui, { fg: (_tone, text) => text, bold: (text) => text }));
				},
			},
			sessionManager: { getBranch: () => this.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })), getEntries: () => [...this.transcript, ...this.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data }))], getSessionFile: () => this.file },
		};
		const pane = world.herdr.panes.find((p) => p.pane_id === options.pane);
		const env: Record<string, string | undefined> = { ...(options.outsideHerdr ? {} : { HERDR_PANE_ID: options.pane, HERDR_TAB_ID: pane?.tab_id, HERDR_WORKSPACE_ID: pane?.workspace_id }), PI_INTERCOM_SESSION_ID: this.id, ...options.env };
		this.env = env;
		const events = {
			on: (channel: string, handler: (data: unknown) => void) => {
				this.bus.set(channel, [...(this.bus.get(channel) ?? []), handler]);
				return () => this.bus.set(channel, (this.bus.get(channel) ?? []).filter((h) => h !== handler));
			},
			emit: (channel: string, data: unknown) => (this.bus.get(channel) ?? []).forEach((handler) => handler(data)),
		};
		const pi = {
			events,
			on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]),
			registerTool: (tool: ToolDefinition) => this.tools.set(tool.name, tool),
			registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?(prefix: string): { value: string }[] | null }) => this.commands.set(name, command),
			appendEntry: (customType: string, data: unknown) => this.entries.push({ customType, data }),
			setSessionName: (name: string) => void (this.name = name), // pi-intercom reports the new name to the broker
			getSessionName: () => this.name,
			sendMessage: (message: { customType: string; content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) => void this.sent.push({ ...message, deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn }),
		} as unknown as ExtensionAPI;
		// pi-intercom's side of the extension API.
		if (!options.noIntercom) events.on("intercom:extension-register", (registration) => world.broker.register(this, registration as Registration));
		if (!options.noIntercom) events.on("intercom:outbox-request", (request) => world.broker.outbox(this, request as { requestId: string; to: string; message: string }));
		world.broker.connect(this);
		// The extension's waits are real in production; here they are capped so timeouts take milliseconds.
		createStrawBoss({ run: world.herdr.runFor(this.pane), api: world.herdr.api, watch: world.watch, env, sleep: (ms) => sleep(Math.min(ms, 2)), promptDir: PROMPT_DIR, stateDir: world.stateDir, autoTower: false, gone: (record) => world.gone.has(record.ownerSession ?? ""), later: (_pid, args) => void world.herdr.runFor(this.pane)(args), events: world.herdr.events, ...options.deps })(pi);
	}

	private dialog(kind: "select" | "confirm", title: string, second: unknown, opts?: { signal?: AbortSignal; timeout?: number }): Promise<unknown> {
		return new Promise((resolve) => {
			const d = { kind, title, second, opts, settled: false, settle: (value: unknown) => ((d.settled = true), resolve(value)) };
			this.dialogs.push(d);
			opts?.signal?.addEventListener("abort", () => d.settle(kind === "confirm" ? false : undefined), { once: true });
			if (opts?.signal?.aborted) d.settle(kind === "confirm" ? false : undefined);
		});
	}
	emit(channel: string, data: unknown): void {
		[...(this.bus.get(channel) ?? [])].forEach((handler) => handler(data));
	}
	/** Listens on the session's event bus as another extension would. */
	on(channel: string, handler: (data: unknown) => void): () => void {
		this.bus.set(channel, [...(this.bus.get(channel) ?? []), handler]);
		return () => this.bus.set(channel, (this.bus.get(channel) ?? []).filter((h) => h !== handler));
	}
	get registered(): string[] {
		return [...this.handlers.keys()];
	}
	/** The pane's role tokens; the order, mark, indent and name tokens (order.ts) have their own tests. */
	get tokens(): Tokens {
		const { sb_order: _order, sb_mark: _mark, sb_indent: _indent, sb_name: _name, sb_tab: _tab, sb_main_tab: _mt, sb_member_tab: _bt, ...role } = this.world.herdr.pane(this.pane).tokens;
		return role;
	}
	/** Fires one event and returns the last answer a handler gave (a tool_call's block, for instance). */
	async fireResult(type: string, event: Record<string, unknown> = {}): Promise<unknown> {
		let last: unknown;
		for (const handler of this.handlers.get(type) ?? []) last = (await handler({ type, ...event }, this.ctx)) ?? last;
		return last;
	}
	async fire(type: string, event: Record<string, unknown> = {}): Promise<void> {
		for (const handler of this.handlers.get(type) ?? []) await handler({ type, ...event }, this.ctx);
	}
	/** Fires session_start, then waits for the background start (tower or rejoin) to go quiet, as pi would not. */
	async start(): Promise<void> {
		await this.fire("session_start", { reason: "startup" });
		await this.world.quiet();
	}
	/** One agent run: returns the system prompt sections the extension left for it. */
	async run(): Promise<Record<string, string>> {
		const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections: {} as Record<string, string> } };
		for (const handler of this.handlers.get("before_agent_start") ?? []) await handler(event, this.ctx);
		return event.systemPromptOptions.sections;
	}
	async tool(name: string, params: Record<string, unknown> = {}, call: { id?: string; signal?: AbortSignal } = {}) {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`${this.id} has no tool ${name}`);
		return tool.execute(call.id ?? "call", params as never, call.signal, undefined, this.ctx as never);
	}
	async command(args = ""): Promise<void> {
		await this.commands.get("boss")!.handler(args, this.ctx);
	}
	/** boss_promote; a refusal comes back as its text. */
	async promote(): Promise<string> {
		const text = await this.tool("boss_promote").then((result) => (result.content[0] as { text: string }).text, (error: Error) => error.message);
		await settle();
		return text;
	}
	/** pi's tool_call event for a call of `name`, as pi fires it before the tool runs. */
	async toolCall(name: string): Promise<void> {
		await this.fire("tool_call", { toolName: name, toolCallId: "call", input: {} });
		await settle();
	}
	/** pi's tool_result event for a call of `name`, as pi fires it after the tool returned. */
	async toolResult(name: string): Promise<void> {
		await this.fire("tool_result", { toolName: name, toolCallId: "call", input: {}, content: [], isError: false });
		await settle();
	}
	/** Ends the session as pi does: a `quit` closes a tower's tab, any other reason (reload, new, resume, fork) keeps it. */
	async stop(reason = "quit"): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		// pi-intercom loads before Straw Boss, and its own session_shutdown has put back the session id it found at start (none) by now.
		delete this.env?.PI_INTERCOM_SESSION_ID;
		await this.fire("session_shutdown", { reason });
		if (reason === "quit") this.world.gone.add(this.id); // the process ends with the session; a reload, /new, or resume keeps it
		this.world.broker.disconnect(this);
	}
}

// Most tests never call `stopAll`, so every World's state directory is removed when the test process exits (only this process's own).
const stateDirs = new Set<string>();
process.once("exit", () => {
	for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

export class World {
	herdr = new FakeHerdr();
	broker = new FakeBroker(this.herdr);
	agents: Agent[] = [];
	/** The Herdr server watches the sessions hold open: `takeover` tells every one that a new server answers. */
	watchers = new Set<{ onTakeover(): void }>();
	watch: HerdrWatch = (onTakeover) => {
		const watcher = { onTakeover }; // one per watch, even for the same callback
		this.watchers.add(watcher);
		return () => void this.watchers.delete(watcher);
	};
	/** A new Herdr server takes over (an update handoff, or a stop and start): tokens are gone, and each watch hears the server come back. */
	async takeover(): Promise<void> {
		this.herdr.restart();
		for (const watcher of [...this.watchers]) watcher.onTakeover();
		await this.quiet();
	}
	/** Sessions whose pi process has ended: the owner check of a GUI record (handover.ts `ownerGone`) answers by this, since every fake session shares the test's own pid. */
	gone = new Set<string>();
	/** The state directory of the one-GUI-per-machine record, private to this world. */
	stateDir = (() => {
		const dir = mkdtempSync(join(tmpdir(), "psb-state-test-"));
		stateDirs.add(dir);
		return dir;
	})();

	constructor() {
		// Closing a tab kills the pi inside it.
		this.herdr.onTabClose = (paneIds) => this.agents.filter((a) => paneIds.includes(a.pane)).forEach((a) => void a.stop());
	}
	/** Adds a session in `pane`; the pane is created in `tab` unless it exists. */
	agent(options: AgentOptions & { tab?: string }): Agent {
		if (options.tab && !this.herdr.panes.some((p) => p.pane_id === options.pane)) this.herdr.addPane(options.pane, options.tab);
		const agent = new Agent(this, options);
		this.agents.push(agent);
		return agent;
	}
	/** A tower session in a tower tab, as `herdr agent start` would leave it. */
	tower(id: string, tab: string, pane: string, ui = false, deps: Partial<Deps> = {}): Agent {
		this.herdr.addTab(tab, TOWER_LABEL, undefined);
		this.herdr.addPane(pane, tab);
		return this.agent({ id, name: `tower · ${id}`, pane, tab, env: { STRAW_BOSS_ROLE: "tower" }, ui, deps });
	}
	/** `herdr agent start` boots a tower session in the pane, as pi would. */
	autoTowers(): void {
		// A tower that comes back after one quit is a new session, with an id of its own.
		const id = (ws: string) => (this.agents.some((a) => a.id === `tower-${ws}`) ? `tower-${ws}-${this.agents.length}` : `tower-${ws}`);
		this.herdr.onAgentStart = (pane) => void this.agent({ id: id(pane.workspace_id), name: `tower · ${pane.workspace_id}`, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "tower" } }).start();
	}
	/** A pi started in a tab the tower opened for a request: it runs with the role the tab was created with, and joins and promotes as `opensAsMain` says. */
	autoMains(deps: Partial<Deps> = {}): void {
		this.herdr.onAgentStart = (pane) => void this.agent({ id: `opened-${pane.pane_id}`, name: `main · ${pane.workspace_id}`, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" }, deps }).start();
	}
	activity(): number {
		return this.herdr.calls.length + this.broker.events + this.agents.reduce((sum, a) => sum + a.entries.length, 0);
	}
	/** Resolves once nothing has called Herdr, delivered an intercom event, or written an entry for a few polls. */
	async quiet(): Promise<void> {
		for (let last = -1, stable = 0; stable < 4; await sleep(5)) {
			const now = this.activity();
			stable = now === last ? stable + 1 : 0;
			last = now;
		}
	}
	/** Stand-ins that live beside the sessions (the sb server's link service, tests/link/service-world.ts), ended with them. */
	stoppers: (() => Promise<void>)[] = [];
	async stopAll(): Promise<void> {
		for (const agent of this.agents) await agent.stop();
		for (const stop of this.stoppers.splice(0)) await stop();
		rmSync(this.stateDir, { recursive: true, force: true });
	}
}
