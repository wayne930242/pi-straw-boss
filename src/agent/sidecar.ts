import { chmodSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { createDigest } from "../digest.ts";
import { createElection } from "../election.ts";
import { createGuard, GUARD_MS } from "../guard.ts";
import { herdrApi, herdrCall, herdrRun, herdrWorld, isSub, place, socketRun, worldOf, panes, workspaces } from "../herdr.ts";
import type { Briefing } from "../briefing.ts";
import { createMembership } from "../membership.ts";
import { createPresence } from "../presence.ts";
import { createReach } from "../reach.ts";
import { createRoles } from "../roles.ts";
import { herdrEvents, herdrWatch } from "../server-watch.ts";
import type { Config, Deps, Scope } from "../state.ts";
import { type Incoming, type IntercomLike, createHeadlessKit } from "./kit.ts";
import { claim } from "./claim.ts";
import { agentFiles, findIntercom, type Held, newPipe, readHeld, type Reply, socketIsFile, stateDirOf } from "./paths.ts";

// The net presence of one Claude Code or Codex pane (docs/specs/2026-10-23-claude-codex-net): it registers with the pi-intercom broker as a session, joins the tab's
// net through the same modules a pi session uses (membership, election, guard, presence, reach, digest), types the messages sent to it into its pane, and
// answers the commands of straw-net.py on a socket of its own. It leaves when the pane no longer runs the agent. It never hosts the GUI and never registers the GUI's channel.

export type Kind = "claude" | "codex";
/** `connect` hands a new client of the broker (started when none runs); the rest are the dependencies of a pi session, replaceable the same way. */
export interface AgentDeps extends Pick<Deps, "run" | "world" | "api" | "call" | "sleep" | "now" | "events" | "watch" | "guardMs" | "couple" | "autoTower" | "detectMs" | "stateDir"> {
	env?: NodeJS.ProcessEnv;
	connect?: () => IntercomLike | Promise<IntercomLike>;
	/** How often the pane is read when Herdr's events say nothing, how often the record file is looked at, and how long an agent Herdr has not detected yet is waited for. */
	pollMs?: number;
	recordMs?: number;
	graceMs?: number;
	log?: (line: string) => void;
}
export interface SidecarOptions { pane: string; kind: Kind; session: string; record?: string; cli?: string; deps?: AgentDeps }
export interface Sidecar {
	id: string;
	name: string;
	/** Resolves once the session has joined its tab; rejects when it cannot (a sub workspace, no broker, no extension bus), and then the sidecar has left. */
	ready: Promise<void>;
	/** Resolves when the sidecar has left: tokens cleared, broker told, files removed. */
	done: Promise<void>;
	request(request: Record<string, unknown>): Promise<Reply>;
	stop(reason?: string): Promise<void>;
}

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const CONFIRM_MS = 1500, GATE_MS = 8000, SEEN_MAX = 200;
const PANE_EVENTS = ["pane.closed", "pane.exited", "pane.updated", "pane.agent_detected", "pane.agent_status_changed"];
const unavailable = (what: string) => (() => { throw new Error(`${what} is not available in a net sidecar`); }) as never;
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
const quote = (value: string) => (/[\s"\]=]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value);
/** One shell word for the reply hint: plain text as is, anything else in single quotes, and a double quote or a control character as an escape in $'…' (the hint sits inside double quotes). */
const shell = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value
	: /["\u0000-\u001f\u007f]/.test(value) ? `$'${value.replace(/[\\'"\u0000-\u001f\u007f]/g, (c) => (c === "\\" || c === "'" ? `\\${c}` : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`))}'`
	: `'${value.replace(/'/g, `'\\''`)}'`;
/** What a pi session's own environment sets and an agent that merely runs in its shell must not carry over: its intercom identity and pool, its subagent role, and the tower role. */
const piOwn = (key: string) => /^PI_(INTERCOM|SUBAGENT)_/.test(key) || key === "STRAW_BOSS_ROLE";

/** The configuration of a pi session, with what only the GUI and the tower's host use left unavailable. */
function agentConfig(d: AgentDeps, env: NodeJS.ProcessEnv): Config {
	const call = d.call ?? herdrCall(), run = d.run ?? socketRun(herdrRun, call);
	return {
		run, world: d.world ?? (d.run ? worldOf(run) : herdrWorld(call)), api: d.api ?? herdrApi(), call, env, stateDir: d.stateDir,
		sleep: d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), now: d.now ?? Date.now,
		watch: d.watch ?? herdrWatch(), events: d.events ?? herdrEvents(), guardMs: d.guardMs ?? GUARD_MS, couple: d.couple ?? true, autoTower: d.autoTower ?? true, detectMs: d.detectMs ?? 1000,
		tailscale: unavailable("tailscale"), copy: unavailable("copy"), openUrl: unavailable("openUrl"), later: unavailable("later"), gone: unavailable("gone"),
		promptDir: "", bundle: undefined, nudgeMs: 0, version: "", adoptMs: 0,
	};
}

/** pi-intercom's client, its broker started when none runs, from the directory pi-intercom is installed in. */
async function intercomClient(env: NodeJS.ProcessEnv): Promise<IntercomLike> {
	// pi-intercom's client reads its pool and the like from this process's own environment: the agent's shell may have been started from a pi's.
	for (const key of Object.keys(process.env)) if (piOwn(key)) delete process.env[key];
	const dir = findIntercom(env), load = (file: string) => import(pathToFileURL(`${dir}/${file}`).href);
	const [client, spawn, config] = await Promise.all([load("broker/client.ts"), load("broker/spawn.ts"), load("config.ts")]);
	const { brokerCommand, brokerArgs } = config.loadConfig();
	await spawn.spawnBrokerIfNeeded(brokerCommand, brokerArgs);
	return new client.IntercomClient();
}

export async function startSidecar({ pane, kind, session, record, cli = "straw-net.py", deps = {} }: SidecarOptions): Promise<Sidecar> {
	const id = `${kind}-${session}`, name = `${kind}-${session.slice(0, 8)}`;
	// The inherited environment is the agent's: whatever a pi session set in it (its intercom id, its subagent or tower role) is not this process's.
	const inherited = Object.fromEntries(Object.entries(deps.env ?? process.env).filter(([key]) => !piOwn(key)));
	const env: NodeJS.ProcessEnv = { ...inherited, HERDR_PANE_ID: pane, PI_INTERCOM_SESSION_ID: id };
	const cfg = agentConfig(deps, env), { run, world, sleep, now } = cfg;
	const log = (line: string) => (deps.log ?? ((text) => console.error(`${new Date().toISOString()} ${text}`)))(line);
	const files = agentFiles(cfg.stateDir ?? stateDirOf(env), pane);
	// One sidecar per pane: the state file is claimed exclusively. A holder is a process that answers on the pane's socket (a pid alone is not one), or one that is young and has not opened it yet.
	mkdirSync(files.dir, { recursive: true, mode: 0o700 });
	chmodSync(files.dir, 0o700);
	const socket = socketIsFile() ? files.socket : newPipe();
	const mine: Held = { pid: process.pid, session, kind, pane, id, name, startedAt: now(), ...(socketIsFile() ? {} : { pipe: socket }) };
	await claim(files, mine, pane, now);

	const kit = createHeadlessKit({ client: undefined as unknown as IntercomLike, env, cfg, log: (text, level) => log(level && level !== "info" ? `${level}: ${text}` : text) });
	const { s, me } = kit;
	const reach = createReach(kit), election = createElection(kit), presence = createPresence(kit), digest = createDigest(run, now);
	const guard = createGuard(kit, { ...election, openTower: reach.openTower });
	const membership = createMembership(kit, { presence, election, guard, briefing: { rebrief() {} } as unknown as Briefing, roles: createRoles(kit), openTower: reach.openTower, register() {} });

	// Leaving: what a pi session does at its shutdown, minus the tower's part. The tokens go before the broker hears the session leave.
	let client: IntercomLike | undefined, leaving: Promise<void> | undefined, finish!: () => void;
	const done = new Promise<void>((resolve) => (finish = resolve));
	const timers: ReturnType<typeof setInterval>[] = [], stops: (() => void)[] = [];
	const server = createServer();
	// The pane runs another agent now (a quit Claude Code, then pi in the same pane): its role tokens are that agent's, not ours to write or to clear.
	const foreign = async () => {
		try {
			const found = (await world()).panes.find((p) => p.pane_id === pane);
			return Boolean(found?.agent && found.agent !== kind);
		} catch {
			return false;
		}
	};
	const leave = (why: string) => (leaving ??= (async () => {
		log(`left: ${why}`);
		s.stopped = true;
		timers.forEach(clearInterval);
		stops.forEach((stop) => stop());
		presence.stop();
		guard.stop();
		await presence.settled();
		// The tokens on the pane are its new agent's once another agent runs there.
		if (s.joined && !(await foreign())) await presence.clear().catch(() => {});
		await client?.disconnect().catch(() => {});
		server.close();
		if (socketIsFile()) rmSync(socket, { force: true });
		// Last, and only this sidecar's own file: a sidecar for the pane can claim it the moment it is gone.
		const left = readHeld(files);
		if (left?.pid === process.pid && left.session === session) rmSync(files.state, { force: true });
		finish();
	})());

	// The broker: a client per connection, the same one kit and messages are attached to, again after the connection drops.
	let reconnecting = false;
	const open = async () => {
		const next = await (deps.connect ?? (() => intercomClient(env)))();
		kit.attach(next);
		client = next;
		next.on("message", (from, message) => void receive(from, message));
		next.on("disconnected", () => void reconnect(next));
		next.on("error", () => {});
		await next.connect({ name: s.ownName || name, cwd: process.cwd(), model: kind === "claude" ? "claude-code" : "codex", pid: process.pid, startedAt: mine.startedAt, lastActivity: now(), herdrPaneId: pane }, id);
	};
	const reconnect = async (dropped: IntercomLike) => {
		if (leaving || reconnecting || dropped !== client) return;
		reconnecting = true;
		log("the broker connection dropped; reconnecting");
		for (let attempt = 0; !leaving; attempt++) {
			await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
			if (leaving) break;
			try {
				await open();
				log("reconnected");
				break;
			} catch (error) {
				log(`reconnecting failed: ${(error as Error).message}`);
			}
		}
		reconnecting = false;
	};

	// Messages for the pane: one line each, in arrival order, typed with herdr's own gate. A blocked pane (a permission prompt is open) refuses input, so they wait.
	const queue: string[] = [], recent: string[] = [];
	let intake: Promise<void> = Promise.resolve(), draining: Promise<void> | undefined;
	const statusOf = async () => (await world()).panes.find((p) => p.pane_id === pane)?.agent_status;
	const drain = (): Promise<void> => (draining ??= (async () => {
		let blocked = false;
		try {
			while (queue.length && !leaving) {
				const status = await statusOf().catch(() => undefined);
				if (status === "blocked") return void (blocked = true);
				const gate = status === "idle" || status === "done" ? ["--wait", "--until", "working", "--until", "blocked", "--timeout", String(GATE_MS)] : [];
				try {
					await run(["agent", "prompt", pane, queue[0]!, ...gate], GATE_MS + 5000);
					queue.shift();
				} catch (error) {
					// Herdr's own word (its stderr), not the error's text, which repeats the typed line.
					if (/agent_blocked/.test(String((error as { stderr?: unknown }).stderr ?? ""))) return void (blocked = true);
					// A stall or timeout means the input was sent and may sit in the composer: it is not sent again.
					log(`could not type a message into the pane: ${(error as Error).message}`);
					queue.shift();
				}
			}
		} finally {
			draining = undefined;
			if (queue.length && !blocked && !leaving) void drain();
		}
	})());
	const receive = (from: { id: string; name?: string }, message: Incoming) => {
		intake = intake.then(async () => {
			if (recent.includes(message.id)) return;
			recent.push(message.id);
			if (recent.length > SEEN_MAX) recent.shift();
			const info = (await client?.listSessions().catch(() => []))?.find((x) => x.id === from.id) ?? from as { id: string; name?: string; herdrLocation?: { paneId?: string } };
			const location = (info as { herdrLocation?: { paneId?: string } }).herdrLocation?.paneId;
			const sbRole = location ? (await panes(run).catch(() => [])).find((p) => p.pane_id === location)?.tokens?.sb_role : undefined;
			// A message relayed from another machine is named as pi names it, and cannot be answered from here (a sidecar sends only within this machine's intercom).
			const relay = message.crossMachine?.origin, attachments = message.content.attachments ?? [];
			const text = clean(message.content.text), attached = attachments.length ? ` [${attachments.length} attachment${attachments.length > 1 ? "s" : ""}: ${attachments.map((f) => clean(f.name)).join(", ")} — not carried into this pane]` : "";
			if (!text && !attached) return;
			const sender = relay ? `${clean(relay.name)}@${clean(relay.machine)} · unverified cross-machine` : clean(info.name ?? info.id), fromId = clean(info.id);
			const role = relay ? "session" : ["tower", "main", "member"].includes(sbRole ?? "") ? sbRole : "session";
			const reply = relay ? "" : ` reply="${shell(cli)} send --to ${shell(fromId)} --message '…'"`;
			queue.push(`[straw net from=${quote(sender)} id=${quote(fromId)} role=${role}${reply}] ${text}${attached}`);
			void drain();
		}).catch((error: Error) => log(`could not take a message: ${error.message}`));
	};

	// The pane: the agent leaves when Herdr says the pane closed or no longer runs it (read again once, a moment later, so a flicker is not a quit), and a blocked pane that frees takes its queue.
	let seen = false, checking: Promise<unknown> | undefined, again = false, unreadable: string | undefined; // a Herdr that does not answer is told once, not every poll
	const gone = async () => ((p) => !p || p.agent !== kind ? (p ? "the pane no longer runs " + kind : "the pane closed") : undefined)((await world()).panes.find((x) => x.pane_id === pane));
	const check = async () => {
		if (leaving) return;
		const why = await gone();
		if (!why) {
			seen = true;
			return void (queue.length && drain());
		}
		if (!seen && why !== "the pane closed" && now() - mine.startedAt < (deps.graceMs ?? 30_000)) return; // Herdr has not detected the agent yet
		await sleep(CONFIRM_MS);
		const still = await gone();
		if (still) await leave(still);
	};
	const watchPane = () => {
		const run1 = () => {
			if (checking) return void (again = true);
			checking = check().then(() => (unreadable = undefined), (error: Error) => unreadable !== error.message && log(`could not read the pane: ${(unreadable = error.message)}`)).finally(() => {
				checking = undefined;
				if (again) ((again = false), run1());
			});
		};
		timers.push(setInterval(run1, deps.pollMs ?? 5000));
		stops.push(cfg.events(PANE_EVENTS, (e) => {
			const target = e && String(e.data.pane_id ?? (e.data.pane as { pane_id?: string } | undefined)?.pane_id ?? "");
			if (!e || !target || target === pane) run1();
		}));
		run1();
	};

	// Promotion: the orchestrator record straw-boss writes for this session, found at the join (a resumed main agent) or appearing or changing later, makes it ask for the tab's main (never by force).
	const mtime = () => (record ? statSync(record, { throwIfNoEntry: false })?.mtimeMs : undefined);
	const watchRecord = () => {
		if (!record) return;
		let last: number | undefined, busy = false;
		timers.push(setInterval(() => {
			const now_ = mtime();
			if (busy || now_ === undefined || now_ === last) return;
			[last, busy] = [now_, true];
			membership.promote(false).then((r) => log(r.text), (error: Error) => log(`could not promote: ${error.message}`)).finally(() => (busy = false));
		}, deps.recordMs ?? 1000));
	};

	// What straw-net.py asks for.
	const text = (value: unknown, what: string) => {
		if (typeof value !== "string" || !value.trim()) throw new Error(`${what} is required`);
		return value;
	};
	const commands: Record<string, (r: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
		// Who answers on this pane's socket, and whether it is on its way out: how the commands tell a sidecar from a leftover state file.
		hello: async () => ({ pid: process.pid, session, leaving: Boolean(leaving) }),
		status: async () => ({ ...(await reach.status()) }),
		promote: async () => {
			const { promoted, text: said } = await membership.promote(false);
			if (!promoted) throw new Error(said);
			return { text: said, role: kit.role() };
		},
		"call-tower": async (r) => {
			const { text: said, details } = await reach.callTower(text(r.message, "message"), typeof r.workspace === "string" ? r.workspace : undefined);
			return { text: said, workspace: details.workspace, towerId: details.towerId, opened: details.opened };
		},
		broadcast: async (r) => {
			const scope = (r.scope ?? "workspace") as Scope;
			if (!["tab", "workspace", "towers", "all"].includes(scope)) throw new Error(`scope must be tab, workspace, towers, or all, not ${String(r.scope)}`);
			const { text: said, details } = await reach.broadcast(text(r.message, "message"), scope);
			return { text: said, ...details };
		},
		send: async (r) => {
			const to = text(r.to, "to"), result = await reach.send(to, text(r.message, "message"));
			if (result.status !== "sent") throw new Error(`The message to ${to} was not sent: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
			return { text: `Sent to ${to}.` };
		},
		rename: async (r) => {
			const phrase = String(r.name ?? "").replace(/\s+/g, " ").trim();
			if (!phrase) throw new Error("The name is empty");
			if (Array.from(phrase).length > 40) throw new Error(`The name has ${Array.from(phrase).length} characters; keep it a short phrase (at most 16 fit the tab)`);
			const was = s.ownName || name;
			client!.updatePresence({ name: phrase });
			s.ownName = phrase;
			await digest.note(s.at.workspaceId, `${was} renamed itself "${phrase}" (tab ${s.info.tab})`).catch(() => {});
			await presence.publish();
			return { text: `This session is now named "${phrase}".`, name: phrase };
		},
		stop: async () => (await leave("the stop command"), { text: "Left the net." }),
	};
	const request = async (r: Record<string, unknown>): Promise<Reply> => {
		try {
			const command = commands[String(r.cmd)];
			if (!command || !Object.hasOwn(commands, String(r.cmd))) throw new Error(`unknown command ${String(r.cmd)}`);
			if (r.cmd !== "stop" && r.cmd !== "hello") await ready.catch((error: Error) => { throw new Error(`this sidecar did not join the net: ${error.message}`); });
			return { ok: true, ...(await command(r)) };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	};
	server.on("connection", (conn) => {
		let line = "";
		conn.setEncoding("utf8").setTimeout(150_000, () => conn.destroy()); // longer than the slowest command's wait (cli.ts ASK_MS)
		conn.on("error", () => {});
		conn.on("data", (chunk) => {
			line += chunk;
			if (!line.includes("\n")) return;
			conn.removeAllListeners("data");
			let parsed: Record<string, unknown> = {};
			try { parsed = JSON.parse(line.split("\n")[0]!); } catch { /* answered as an unknown command */ }
			void request(parsed).then((reply) => conn.end(`${JSON.stringify(reply)}\n`));
		});
	});
	await new Promise<void>((resolve, reject) => {
		if (socketIsFile() && existsSync(socket)) unlinkSync(socket);
		server.once("error", reject);
		// A named pipe's default access lets only its creator, administrators, and SYSTEM write to it or make another instance of it.
		server.listen(socket, () => (server.off("error", reject), socketIsFile() && chmodSync(socket, 0o600), resolve()));
	}).catch(async (error) => (await leave("the control socket could not listen"), Promise.reject(error)));

	// The join: Herdr must say the pane is not in a sub workspace, then the broker, then the tab.
	const ready = (async () => {
		let sub;
		try {
			const { workspaceId } = await place(run), found = (await workspaces(run)).find((w) => w.workspace_id === workspaceId);
			sub = found && isSub(found) ? `${found.label} is a sub workspace, so this session cannot join the net; the main agent of its parent workspace represents it` : undefined;
		} catch (error) {
			throw new Error(`could not tell whether this is a sub workspace: ${(error as Error).message}`);
		}
		if (sub) throw new Error(sub);
		await open();
		await membership.joinNet();
		stops.push(cfg.watch(() => void foreign().then((other) => other || presence.restore())));
		void digest.note(s.at.workspaceId, `${name} joined tab ${s.info.tab}`).catch(() => {});
		watchRecord();
		watchPane();
		log(`joined tab ${s.info.tab} of ${s.info.workspace} as ${kit.role()}`);
	})();
	ready.catch((error: Error) => (log(`join failed: ${error.message}`), void leave("the join failed")));
	return { id, name, ready, done, request, stop: (reason = "stopped") => leave(reason) };
}
