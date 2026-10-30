import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubClient } from "./agent-fakes.ts";
import { fakeClock } from "./fake-clock.ts";
import { FakeHerdr } from "./fakes.ts";
import { ServerWorld } from "./server-world.ts";
import type { Session } from "../src/herdr.ts";
import type { Towers } from "../src/server/towers.ts";
import { createAllows } from "../src/server/allows.ts";
import type { Proc } from "../src/server/lineage.ts";
import type { AllyItem, AllyPort, Timers } from "../src/server/runs.ts";
import type { StandingTimers } from "../src/server/standing.ts";

/** The link holder as the tower service sees it (AllyPort): messages that wait for the tower identity, who has left the roster, and what the server told it was taken. */
export class FakeAlly implements AllyPort {
	identity = "sb-tower-wa";
	items: AllyItem[] = [];
	takenIds: string[] = [];
	gone = new Set<string>();
	level = new Map<string, string>();
	projects = new Map<string, string>();
	threads = new Map<string, { dir: "in" | "out"; at: number; kind: string; text: string }[]>();
	/** The holder is slow to drop an item it was told is taken (its inbox file goes under a lock): the item stays listed. */
	lingering = false;
	waiting(identity: string) {
		return identity === this.identity ? this.items.filter((i) => this.lingering || !this.takenIds.includes(i.id)) : [];
	}
	/** While set, the holder takes its time to drop a message (`takenCalls` counts the asks that wait). */
	takenGate: Promise<void> | undefined;
	takenCalls = 0;
	async taken(id: string) {
		this.takenCalls++;
		await this.takenGate;
		this.takenIds.push(id);
	}
	standing(device: string) {
		return this.gone.has(device) ? undefined : { level: this.level.get(device) ?? "reply" };
	}
	project(team: string) {
		return this.projects.get(team);
	}
	thread(device: string) {
		return this.threads.get(device) ?? [];
	}
	/** A message from a device, as the holder lists it. */
	add(id: string, device: string, text: string, over: Partial<AllyItem> = {}): AllyItem {
		const item: AllyItem = { id, device, label: `label-${device}`, short: device.slice(0, 6), team: "team-1", teamName: "Team One", fromWorkspace: "theirs", replyExpected: false, text, at: Date.now() + this.items.length, ...over };
		this.items.push(item);
		return item;
	}
}

// A world for the tower service's tests: the sb server world with a fake Herdr and one fake pi-intercom client per identity. `towerRuns.enabled` is set in the state directory's config.json.
// Runs: Herdr's `agent start` makes a pi process (a fake PID in the pane's process list) that the test claims and drives over the control socket (`pi`), and the run timers are short.

/** Short run timers: a wake after 40 ms, the watcher every 20 ms. A test overrides what it is about. */
export const FAST_RUNS: Partial<Timers> = { wake: 40, claim: 3000, watch: 20, idleSteer: 60_000, idleEnd: 300_000, steerAt: 600_000, quitAt: 1_200_000, quitGrace: 200, signal: 100, lost: 60_000, refuse: 150, loop: 60_000, restored: 400, stopGrace: 300 };

/** Short timers for the standing pane: a look every 30 ms, a prompt counts as there for 400 ms after its poll, a typed command is waited for 250 ms and then for twice as long, up to 1 s. A test overrides what it is about. */
export const FAST_STANDING: Partial<StandingTimers> = { intervalMs: 30, presentMs: 400, launchMs: 250, launchMaxMs: 1000, leaveMs: 400, refreshMs: 60_000 };

export class TowerWorld extends ServerWorld {
	herdr = new FakeHerdr();
	clients: StubClient[] = [];
	/** What every client's `listSessions` answers: the live sessions of the broker. */
	sessions: Session[] = [];
	takeovers: (() => void)[] = [];
	/** The watch's second callback: the Herdr it was open to has stopped (its socket closed), before any new one answers. */
	losts: (() => void)[] = [];
	/** The pi processes `agent start` made: run id → PID and pane; and the signals the server sent. */
	pis = new Map<string, { pid: number; pane: string; args: string[] }>();
	kills: [number, string][] = [];
	/** What the server's process table read answers (undefined: it cannot be read); a test sets it to put a wrapper above a pi. */
	procTable: Proc[] | undefined;
	procReads = 0;
	/** While set, the process table read for that run id waits for it. */
	procGate: ((runId: string) => Promise<void> | undefined) | undefined;
	/** How often the server asked for a process start time. */
	startCalls = 0;
	nextPi = 7000;
	/** Set to make the settings check refuse. */
	settingsError: Error | undefined;
	/** While set, the settings check waits for it (a pi started by hand meanwhile). */
	settingsHold: Promise<void> | undefined;
	/** How often the settings check ran: once for every run the server starts. */
	settingsCalls = 0;
	runTimers: Partial<Timers> = {};
	standingTimers: Partial<StandingTimers> = {};
	/**
	 * The clock of the runs (the age of a run, the idle time, the quit grace) when a test sets one: the watcher still ticks every 20 ms, but it sees only the ages the test gives it, so a tick that comes late under load cannot step over a
	 * time (the steer is skipped when the first tick that sees a run is already past the cap). Unset, the runs use the server's clock.
	 */
	runClock: ReturnType<typeof fakeClock> | undefined;
	runMax: number | undefined;
	/** How often the service writes its tokens again (the server's 4 minutes), when a test wants to see a refresh. */
	refreshMs: number | undefined;
	/** The platform the runs are ended for (win32: no signal where it can be avoided, and a pane whose pi was signalled is replaced). */
	runPlatform: NodeJS.Platform | undefined;
	/** How often the runs' watcher asked whether a pi lives: once per run per tick, so two more calls mean a whole tick ran since. */
	aliveCalls = 0;
	/** Called with the pid at each of those asks, inside the watcher's tick: a test makes a tick slow on its clock by moving the clock here. */
	aliveHook: ((pid: number) => void) | undefined;
	/** The tower service of the last server started in this world, once it is built. */
	expose: Towers | undefined;
	ally = new FakeAlly();
	allows = createAllows({ waitMs: 150 });
	/** The server builds its own Allows (the hub's gates feed them) instead of the shared fake. */
	serverAllows = false;
	/** The requests the tower service sent the link holder (the tools of a run), and the answer for each op. */
	linkCalls: { body: Record<string, unknown>; from: string }[] = [];
	linkAnswers = new Map<string, (body: Record<string, unknown>) => Record<string, unknown>>();
	setFlag(enabled: boolean | undefined, max?: number) {
		mkdirSync(this.stateDir, { recursive: true });
		writeFileSync(join(this.stateDir, "config.json"), JSON.stringify(enabled === undefined ? {} : { towerRuns: { enabled, ...(max ? { max } : {}) } }));
	}
	constructor() {
		super();
		this.herdr.onAgentStart = (pane, args) => {
			const id = args[args.indexOf("--sb-run") + 1];
			if (!id) return;
			const pid = this.nextPi++;
			this.live.add(pid);
			this.pis.set(id, { pid, pane: pane.pane_id, args });
			pane.processes = [{ argv0: "pi", name: "node", pid, cmdline: `node pi ${args.slice(args.indexOf("--") + 1).join(" ")}` }];
		};
	}
	override options(over: Parameters<ServerWorld["options"]>[0] = {}) {
		return super.options({
			intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => {
				const client = new StubClient();
				client.listSessions = async () => this.sessions;
				this.clients.push(client);
				return client;
			} }),
			herdr: { run: this.herdr.runFor("none"), events: this.herdr.events, api: this.herdr.api, watch: (cb: () => void, lost?: () => void) => (this.takeovers.push(cb), lost && this.losts.push(lost), () => {}) },
			towers: {
				recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20], ally: this.ally, ...(this.refreshMs ? { refreshMs: this.refreshMs } : {}), standing: { ...FAST_STANDING, ...this.standingTimers }, ...(this.serverAllows ? {} : { allows: this.allows }), expose: (t: Towers) => void (this.expose = t),
				link: async (body, from) => {
					const b = body as Record<string, unknown>;
					this.linkCalls.push({ body: b, from });
					return this.linkAnswers.get(String(b.op))?.(b) ?? { ok: false, code: "no_holder", error: "no holder in this world" };
				},
				runs: {
					timers: { ...FAST_RUNS, ...this.runTimers }, ...(this.runClock ? { now: this.runClock.now } : {}), alive: (pid) => (this.aliveCalls++, this.aliveHook?.(pid), this.live.has(pid)), procs: async (runId) => (this.procReads++, await this.procGate?.(runId), this.procTable), startOf: (pid) => (this.startCalls++, `T-${pid}`), kill: (pid, signal) => void this.kills.push([pid, signal]),
					settings: async () => { this.settingsCalls++; await this.settingsHold; if (this.settingsError) throw this.settingsError; },
					...(this.runMax ? { max: () => this.runMax! } : {}),
					...(this.runPlatform ? { platform: this.runPlatform } : {}),
				},
			},
			...over,
		});
	}
	/** The client that registered under an id. */
	client(id: string) {
		return this.clients.find((c) => c.sessionId === id);
	}
}
