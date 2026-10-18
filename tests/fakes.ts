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
interface FakePane { pane_id: string; tab_id: string; workspace_id: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string; tokens: Tokens; env?: string[]; cwd?: string; processes?: { argv?: string[]; argv0?: string; name?: string }[] }
interface FakeWorkspace { workspace_id: string; label: string; agent_status?: string; tokens: Tokens; worktree?: { checkout_path?: string; is_linked_worktree?: boolean; repo_key?: string } }

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
	closed: string[] = [];
	/** Socket API calls, and a switch that makes `tab.move` fail as an unreachable socket would. */
	moves: { tab_id: string; insert_index: number }[] = [];
	failMove = false;
	/** Makes every `list` call fail, as a Herdr that cannot answer. */
	failReads = false;
	wsTokenHistory: (string | undefined)[] = [];
	onAgentStart?: (pane: FakePane) => void;
	onTabClose?: (paneIds: string[]) => void;
	private next = 100;
	/** A new server starts with no tokens: the old one kept them in memory. Panes, tabs and workspaces stay, as after a live handoff. */
	restart(): void {
		for (const holder of [...this.panes, ...this.workspaces]) holder.tokens = {};
		this.wsTokenHistory.length = 0;
		this.calls.length = 0;
	}
	private agentNames = new Set<string>();
	/** The next this-many `agent start` calls fail with agent_pane_busy, as a new tab's shell does before its prompt. */
	busy = 0;

	/** A pane running pi, or "shell" for a bare shell prompt. */
	addPane(paneId: string, tabId: string, agent = "pi"): FakePane {
		const pane = { pane_id: paneId, tab_id: tabId, workspace_id: tabId.split(":")[0]!, agent: agent === "shell" ? undefined : agent, tokens: {} };
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
		if (group === "agent" && cmd === "start") {
			if (this.busy-- > 0) throw new Error(`herdr ${args.join(" ")} failed: agent_pane_busy: agent target pane ${flag("--pane")} is not an available shell`);
			if (!/^[a-z][a-z0-9_-]{0,31}$/.test(args[2]!)) throw new Error(`herdr agent start failed: invalid_agent_name: ${args[2]}`);
			if (this.agentNames.has(args[2]!)) throw new Error(`herdr agent start failed: agent_name_taken: agent name ${args[2]} is already used`);
			this.agentNames.add(args[2]!);
			const pane = this.pane(flag("--pane")!);
			pane.agent = "pi";
			this.onAgentStart?.(pane);
			return out({});
		}
		if (cmd === "report-metadata") {
			// Herdr takes the positional id before the options; anything else fails like the real CLI.
			if (args[3] !== "--source") throw new Error(`unknown option in ${args.join(" ")}`);
			const target = group === "pane" ? this.pane(args[2]!).tokens : this.workspace(args[2]!).tokens;
			args.forEach((arg, i) => {
				if (arg === "--token") target[args[i + 1]!.split("=")[0]!] = args[i + 1]!.split("=").slice(1).join("=");
				if (arg === "--clear-token") delete target[args[i + 1]!];
			});
			if (group === "workspace") this.wsTokenHistory.push(target.tower);
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

interface Registration { namespace: string; ownerEligible: boolean; onReady(channel: unknown): void; onEvent(event: Record<string, unknown>): void }

/** A tiny pi-intercom broker: owner by connection order, compare-and-swap-free state, an outbox. */
export class FakeBroker {
	sessions = new Map<string, Agent>();
	owners = new Map<string, string>();
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

	connect(agent: Agent): void {
		this.sessions.set(agent.id, agent);
	}
	register(agent: Agent, registration: Registration): void {
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
	disconnect(agent: Agent): void {
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
	private info(agent: Agent) {
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
	/** Each ctx.ui.custom overlay, open until it closes itself. */
	overlays: (Overlay & { closed: boolean })[] = [];
	/** What pi-intercom reports as this session's status. */
	status = "idle";
	/** The session file pi would name, and the run's abort signal (ctx.signal). */
	file?: string;
	/** Entries of the transcript besides the extension's own (custom messages, for instance), as ctx.sessionManager.getEntries() returns them. */
	transcript: { type: string; customType?: string; details?: unknown }[] = [];
	signal?: AbortSignal;
	/** Widgets set through ctx.ui.setWidget, and the live component of each. */
	widgets = new Map<string, WidgetFactory | undefined>();
	components = new Map<string, { render(width: number): string[]; dispose?(): void }>();
	tui: FakeTui = { renders: 0, requestRender: () => void this.tui.renders++ };
	stopped = false;
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
			ui: {
				notify: (text: string, level?: string) => this.notices.push({ text, level }),
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
		const env = { ...(options.outsideHerdr ? {} : { HERDR_PANE_ID: options.pane }), PI_INTERCOM_SESSION_ID: this.id, ...options.env };
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
		} as unknown as ExtensionAPI;
		// pi-intercom's side of the extension API.
		if (!options.noIntercom) events.on("intercom:extension-register", (registration) => world.broker.register(this, registration as Registration));
		if (!options.noIntercom) events.on("intercom:outbox-request", (request) => world.broker.outbox(this, request as { requestId: string; to: string; message: string }));
		world.broker.connect(this);
		// The extension's waits are real in production; here they are capped so timeouts take milliseconds.
		createStrawBoss({ run: world.herdr.runFor(this.pane), api: world.herdr.api, watch: world.watch, env, sleep: (ms) => sleep(Math.min(ms, 2)), promptDir: PROMPT_DIR, stateDir: world.stateDir, autoTower: false, ...options.deps })(pi);
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
		const { sb_order: _order, sb_mark: _mark, sb_indent: _indent, sb_name: _name, sb_tab: _tab, ...role } = this.world.herdr.pane(this.pane).tokens;
		return role;
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
	async tool(name: string, params: Record<string, unknown> = {}) {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`${this.id} has no tool ${name}`);
		return tool.execute("call", params as never, undefined, undefined, this.ctx as never);
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
		await this.fire("session_shutdown", { reason });
		this.world.broker.disconnect(this);
	}
}

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
	/** The state directory of the one-GUI-per-machine record, private to this world. */
	stateDir = mkdtempSync(join(tmpdir(), "psb-state-test-"));

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
	tower(id: string, tab: string, pane: string, ui = false): Agent {
		this.herdr.addTab(tab, TOWER_LABEL, undefined);
		this.herdr.addPane(pane, tab);
		return this.agent({ id, name: `tower · ${id}`, pane, tab, env: { STRAW_BOSS_ROLE: "tower" }, ui });
	}
	/** `herdr agent start` boots a tower session in the pane, as pi would. */
	autoTowers(): void {
		this.herdr.onAgentStart = (pane) => void this.agent({ id: `tower-${pane.workspace_id}`, name: `tower · ${pane.workspace_id}`, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "tower" } }).start();
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
	async stopAll(): Promise<void> {
		for (const agent of this.agents) await agent.stop();
		rmSync(this.stateDir, { recursive: true, force: true });
	}
}
