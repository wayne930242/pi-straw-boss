import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { startBridge } from "./bridge.ts";
import { collect, startDashboard } from "./dashboard.ts";
import { createHub, type Hub } from "./dialogs.ts";
import { answers, type Gui, openBrowser, readRecord, sharedGui, startGui, urlOf } from "./gui.ts";
import { netSource } from "./net.ts";
import { clearOrder, markKids, netTokens } from "./order.ts";
import { opener } from "./opener.ts";
import { orphans } from "./orphan.ts";
import { copyText, pairingKeys, showLines } from "./pairing.ts";
import { type Run, switchRemote, tailscale } from "./remote.ts";
import { ensureTower, headOf, towerModel, herdrApi, type HerdrApi, herdrCall, type HerdrCall, herdrRun, type HerdrRun, isSub, type Pane, panes, parentOf, place, type Place, report, type Session, type Sleep, waitFor, workspaces, type Workspace } from "./herdr.ts";

// pi-intercom's extension API as constants and minimal types: intercom is a runtime requirement, not an import.
const REGISTER = "intercom:extension-register";
const OUTBOX = "intercom:outbox-request";
const OUTBOX_RESULT = "intercom:outbox-result";
const NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const ENTRY = "straw-boss";
const PROMPTS = ["main", "tower", "member", "member-no-main"];
const REFRESH_MS = 4 * 60_000;
const KID_MARK_MS = [3_000, 15_000];
const NUDGE_MS = 15_000;
const CLAIM_MS = 5000;
const CONNECT_MS = 15_000;
const SEND_MS = 30_000;
const SETTLE_MS = 2000;

interface Channel {
	snapshot(): { connected: boolean; supported: boolean; owner?: { sessionId: string }; state?: { payload: unknown } };
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
	commitState(payload: unknown, expectedRevision?: number): void;
	listSessions(): Promise<Session[]>;
}
interface SendResult { requestId?: string; status: string; code?: string; detail?: string }
interface Saved { tower?: boolean }
type Role = "tower" | "main" | "member";
type Scope = "tab" | "workspace" | "towers" | "all";
type Member = ReturnType<typeof netMembers>[number];
export interface Deps { run?: HerdrRun; api?: HerdrApi; call?: HerdrCall; tailscale?: Run; copy?: (text: string) => Promise<void>; env?: NodeJS.ProcessEnv; sleep?: Sleep; promptDir?: string; bundle?: string; openUrl?: (url: string) => Promise<void>; stateDir?: string; autoTower?: boolean; nudgeMs?: number }

/** Live sessions whose pane carries an `sb_role` token: the sessions that joined the net, and towers. */
function netMembers(sessions: Session[], ps: Pane[]) {
	return sessions.flatMap((s) => {
		const { workspace, tab, paneId } = s.herdrLocation ?? {};
		const role = ps.find((p) => p.pane_id === paneId)?.tokens?.sb_role;
		return workspace && tab && role ? [{ s, role, tab, workspace }] : [];
	});
}
const nameOf = (s?: Session) => (s ? (s.name ?? s.id) : "");

export function createStrawBoss({ run = herdrRun, api = herdrApi(), call = herdrCall(), tailscale: ts = tailscale, copy = copyText, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), promptDir = fileURLToPath(new URL("../prompts", import.meta.url)), bundle, openUrl = openBrowser, stateDir, autoTower = true, nudgeMs = NUDGE_MS }: Deps = {}) {
	return function strawBoss(pi: ExtensionAPI): void {
		// Outside Herdr there is no tab to coordinate. Every session in Herdr relays its dialogs to the GUI (bridge.ts), subagents too: they ask
		// questions as well. A pi-herdr-agents worker never joins: its parent represents it.
		if (!env.HERDR_PANE_ID) return;
		const guiDir = stateDir ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss");
		let hub: Hub | undefined;
		const bridge = startBridge(pi, { env, dir: guiDir, local: () => (hub?.running ? hub : undefined) });
		if (env.PI_SUBAGENT_ID) return;
		let isTower = env.STRAW_BOSS_ROLE === "tower";
		// A tab the tower opened for a request starts its pi with this role: it promotes itself as soon as it has joined (opener.ts).
		const opensAsMain = env.STRAW_BOSS_ROLE === "main";
		let joined = false, isMain = false, holdsTower = false, requests = 0;
		const nonce = randomUUID().slice(0, 8);
		// The tab's live main agent as of the last refresh, and the main this session pinned as owner before the broker echoes it back.
		let mainId: string | undefined, pinned: string | undefined, joining: Promise<void> | undefined;
		// Why this session cannot join: it sits in a sub workspace, or Herdr could not say whether it does.
		let barred: string | undefined, dashboard: ReturnType<typeof startDashboard> | undefined, hasUI = false;
		let prompts: Record<string, string> = {}, info: Record<string, string> = {}, saved: Saved = {};
		let gui: Gui | undefined, viewer: Channel | undefined, opening: Promise<string> | undefined;
		let c!: Channel, at!: Place, ui: ExtensionContext["ui"] | undefined, timer: ReturnType<typeof setInterval> | undefined;
		let queue: Promise<void> = Promise.resolve();
		// This session's intercom name, which the subagents it launched show as their launcher, and the subagent panes it has marked.
		let ownName = "", openedBy: string | undefined, kids = new Set<string>();
		// Watches for subagents this session launched whose result can no longer reach it (orphan.ts).
		let nudges: ReturnType<typeof orphans> | undefined, nudgeTimer: ReturnType<typeof setInterval> | undefined;
		const me = () => env.PI_INTERCOM_SESSION_ID ?? "";
		const role = (): Role | undefined => {
			if (isTower) return "tower";
			if (!joined) return undefined;
			return isMain ? "main" : "member";
		};
		const tell = (text: string, level: "info" | "warning" | "error" = "info") => ui?.notify(text, level);
		const render = (text = "") => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: promptDir, ...info })[key] || "none yet");
		const tool = <P extends TSchema>(name: string, description: string, parameters: P, body: (params: Static<P>) => Promise<{ text: string; details?: unknown }>) =>
			pi.registerTool({
				name, label: name, description, parameters,
				execute: async (_id, params) => {
					const { text, details } = await body(params);
					return { content: [{ type: "text", text }], details };
				},
			});
		// A join that failed after registering retries on the tab the session is in now: its channel when it has registered there already, else a new
		// one. Intercom has no unregister, so a tab left behind stays registered; see `onEvent` for what that channel still does.
		const channels = new Map<string, Channel>();
		const use = (channel: Channel) => ((pinned = channel === c ? pinned : undefined), (c = channel)); // what was pinned on another tab's channel is not this one's
		const connect = (eligible: boolean) => {
			const namespace = `straw-boss/tab/${Buffer.from(at.tabId).toString("hex")}`;
			if (channels.has(namespace)) return void use(channels.get(namespace)!);
			if (!NAMESPACE.test(namespace)) throw new Error(`Tab id ${at.tabId} is too long for an intercom namespace (limit 24 characters)`);
			let mine: Channel | undefined;
			pi.events.emit(REGISTER, { namespace, ownerEligible: eligible, onReady: (channel: Channel) => { mine = channel; channels.set(namespace, channel); use(channel); }, onEvent: (event: Event) => mine && onEvent(mine, event) });
			if (!mine) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
		};

		// Tokens are display and discovery only: a failed write waits for the next refresh, liveness comes from intercom.
		// One publish at a time, and shutdown waits for the one in flight: a write that lands after the clear would leave tokens behind.
		let publishing: Promise<void> = Promise.resolve(), stopped = false;
		const publishOnce = async (known?: Session[]) => {
			const sbRole = stopped ? undefined : role();
			if (sbRole) {
				ownName = nameOf((known ?? (await c.listSessions().catch(() => []))).find((s) => s.id === me())) || ownName;
				// A failed read of Herdr leaves the subagents' tokens as they are; their TTL still runs.
				const net = await netTokens(run, at, sbRole, ownName || me().slice(0, 8)).catch(() => undefined);
				await report(run, "pane", at.paneId, { sb_role: sbRole, ...net?.own, ...(openedBy ? { sb_opened_by: openedBy } : {}) }).catch(() => {});
				if (net) kids = await markKids(run, net.kids, kids, net.joined);
			}
			if (holdsTower && !stopped) await report(run, "workspace", at.workspaceId, { tower: me() }).catch(() => {});
		};
		const publish = (known?: Session[]) => (publishing = publishing.then(() => publishOnce(known)).catch(() => {}));
		const keepFresh = () => {
			timer ??= setInterval(() => void publish(), REFRESH_MS);
			timer.unref();
		};

		// The owner records who is main. Promotion is first come, first served, and the main stays until it leaves: a later owner change never swaps it.
		const pin = (channel: Channel, main: string) => {
			if (channel.snapshot().owner?.sessionId !== me()) return;
			channel.commitState({ v: 1, main, since: Date.now() });
			if (channel === c) pinned = main;
		};
		// The owner decides a claim: a tab has one main, so a claim is dropped while a live main exists, unless the user forced it with /boss.
		const claim = async (channel: Channel, from: string, force: boolean) => {
			try {
				if (channel.snapshot().owner?.sessionId !== me()) return;
				const current = (channel === c ? pinned : undefined) ?? (channel.snapshot().state?.payload as { main?: string } | undefined)?.main;
				if (!force && current && current !== from && (await channel.listSessions()).some((s) => s.id === current)) return;
				pin(channel, from);
			} catch (error) {
				tell(`Straw Boss: ${(error as Error).message}`, "warning");
			}
		};
		type Event = { type: string; fromSessionId?: string; owner?: { sessionId: string }; payload?: { type?: string; force?: boolean } };
		// A tab this session left stays registered, and if the session owns that channel it still decides that tab's claims (or its members could
		// never promote); nothing else that channel says concerns the session's role.
		const onEvent = (channel: Channel, event: Event) => {
			if (event.type === "message" && event.payload?.type === "claim" && event.fromSessionId) {
				const [from, force] = [event.fromSessionId, Boolean(event.payload.force)];
				queue = queue.then(() => claim(channel, from, force));
			}
			if (channel !== c) return;
			// Ownership moved away: what this session pinned as owner is no longer its to defend.
			if (event.type === "owner" && event.owner?.sessionId !== me()) pinned = undefined;
			// A join that failed at start (intercom not connected yet, no owner yet) is retried when the channel changes.
			if (!joined && !barred && !isTower && ["connection", "owner"].includes(event.type)) void joinNet().catch(() => {});
			if (["connection", "owner", "state", "session_left"].includes(event.type)) void sync();
			if (["presence_update", "session_joined", "session_left"].includes(event.type)) dashboard?.poke();
		};
		const refresh = async () => {
			if (!joined) return;
			try {
				const snap = c.snapshot();
				if (snap.owner?.sessionId !== me()) pinned = undefined;
				const sessions = await c.listSessions();
				// A main that has left leaves the tab without one until a member promotes.
				const recorded = (snap.state?.payload as { main?: string } | undefined)?.main;
				if (pinned === recorded) pinned = undefined; // the broker has echoed it
				mainId = sessions.find((s) => s.id === (pinned ?? recorded))?.id;
				const ws = (await workspaces(run)).find((w) => w.workspace_id === at.workspaceId);
				const tab = sessions.find((s) => s.id === me())?.herdrLocation?.tab?.label ?? at.tabId;
				info = { tab, workspace: ws?.label ?? at.workspaceId, main: nameOf(sessions.find((s) => s.id === mainId)), tower: nameOf(sessions.find((s) => s.id === ws?.tokens?.tower)) };
				const wasMain = isMain;
				isMain = mainId === me();
				if (isMain !== wasMain) tell(`This session is ${isMain ? "now" : "no longer"} the main agent of ${info.tab}`);
				await publish(sessions);
				// The workspace's first main opens the tower at once; later mains find it open.
				if (isMain && !wasMain && autoTower) void openTower().catch((error: Error) => tell(`Straw Boss: could not open the tower: ${error.message}`, "warning"));
			} catch (error) {
				tell(`Straw Boss: ${(error as Error).message}`, "warning");
			}
		};
		const sync = () => (queue = queue.then(refresh));
		// A session that has just started connects to the broker a moment after session_start.
		const connected = async (channel = c) => {
			if (await waitFor(sleep, () => channel.snapshot().connected && channel.snapshot().supported, CONNECT_MS)) return;
			throw new Error(channel.snapshot().connected ? "The intercom broker lacks extension-bus-v1" : "pi-intercom is not connected");
		};
		// Every joinable session joins at start as a member (owner-eligible, so the tab channel always has an owner). One join at a time.
		const joinNet = () =>
			(joining ??= (async () => {
				if (joined) return;
				if (barred) throw new Error(barred);
				at = await place(run);
				connect(true);
				await connected();
				if (!(await waitFor(sleep, () => c.snapshot().owner, CLAIM_MS))) throw new Error("No intercom owner was elected for this tab");
				joined = true;
				addNetTools();
				addPromote();
				keepFresh();
				await sync();
			})().catch((error) => {
				joining = undefined;
				throw error;
			}));
		// Becoming the tab's main agent. Without `force` a tab that already has a live main refuses; /boss forces.
		const promote = async (force: boolean): Promise<{ promoted: boolean; text: string }> => {
			await joinNet();
			await sync();
			if (isMain) return { promoted: true, text: `You are already the main agent of tab ${info.tab}.` };
			const refused = () => ({ promoted: false, text: `Tab ${info.tab} already has a main agent, ${info.main}. Stay a member: you may dispatch your own subagents, but tell ${info.main} through intercom first what you will do and which resources you will use.` });
			if (!force && mainId) return refused();
			if (c.snapshot().owner?.sessionId === me()) await (queue = queue.then(() => claim(c, me(), force)));
			else c.publish({ type: "claim", force }, { audience: "owner" });
			if (!(await waitFor(sleep, () => isMain, CLAIM_MS))) {
				await sync();
				if (isMain) return { promoted: true, text: `You are now the main agent of tab ${info.tab}.` };
				if (!force && mainId && mainId !== me()) return refused();
				throw new Error("The owner did not confirm the promotion within 5 s");
			}
			return { promoted: true, text: `You are now the main agent of tab ${info.tab}.` };
		};
		const send = (to: string, message: string) =>
			new Promise<SendResult>((resolve) => {
				// pi-intercom keeps a message id per sender session and refuses it again with other content, and a restarted pi keeps its session id: the id carries this process's own nonce.
				const requestId = `straw-boss-${me()}-${nonce}-${++requests}`;
				const done = (result: SendResult) => {
					off();
					clearTimeout(timeout);
					resolve(result);
				};
				const off = pi.events.on(OUTBOX_RESULT, (data) => (data as SendResult).requestId === requestId && done(data as SendResult));
				const timeout = setTimeout(() => done({ status: "failed", detail: `no result within ${SEND_MS / 1000} s` }), SEND_MS);
				pi.events.emit(OUTBOX, { version: 1, requestId, extensionId: "pi-straw-boss", extensionName: "Pi Straw Boss", to, message });
			});
		const openTower = async (query?: string) => {
			const all = await workspaces(run);
			const found = all.filter((w) => (query ? w.workspace_id === query || w.label === query : w.workspace_id === at.workspaceId));
			if (found.length !== 1) {
				throw new Error(`${found.length ? "Several workspaces match" : "No workspace matches"} "${query}". Workspaces: ${all.map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
			}
			// A sub workspace never has a tower: its parent workspace's tower serves it.
			const asked = found[0]!;
			const target = isSub(asked) ? parentOf(all, asked) : asked;
			if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower; open the parent workspace first`);
			if (isTower && target.workspace_id === at.workspaceId) throw new Error("This session is the tower of that workspace");
			const live = async (id: string) => (await c.listSessions()).some((s) => s.id === id);
			const moveFirst = (tabId: string) => api("tab.move", { tab_id: tabId, insert_index: 0 }).catch((error: Error) => tell(`Straw Boss: could not move the tower tab first: ${error.message}`, "warning"));
			return { target, routed: target !== asked ? asked : undefined, ...(await ensureTower({ run, sleep, live, moveFirst, model: towerModel(guiDir) }, target, process.cwd())) };
		};
		const status = async () => {
			const sessions = await c.listSessions();
			const [ps, all] = [await panes(run), await workspaces(run)];
			const mine = all.find((w) => w.workspace_id === at.workspaceId);
			const towerOf = (w?: Workspace) => {
				const s = sessions.find((x) => x.id === w?.tokens?.tower);
				return s && w && { workspace: w.label, id: s.id, name: nameOf(s), head: w === headOf(all) };
			};
			const own = netMembers(sessions, ps).filter((m) => m.workspace.id === at.workspaceId && m.role !== "tower");
			const tabs = Object.values(Object.groupBy(own, (m) => m.tab.id)).map((group = []) => ({
				id: group[0]?.tab.id,
				label: group[0]?.tab.label,
				main: group.find((m) => m.role === "main")?.s.id ?? null,
				sessions: group.length,
			}));
			return {
				me: { id: me(), role: role() },
				workspace: { id: at.workspaceId, label: mine?.label },
				head: headOf(all)?.workspace_id,
				tower: towerOf(mine) ?? null,
				tabs,
				towers: all.filter((w) => w !== mine).flatMap((w) => towerOf(w) ?? []),
			};
		};
		const broadcast = async (message: string, scope: Scope) => {
			const others = (await c.listSessions()).filter((s) => s.id !== me());
			const inScope = (m: Member) => ({ tab: m.tab.id === at.tabId, workspace: m.workspace.id === at.workspaceId, towers: m.role === "tower" })[scope as Exclude<Scope, "all">];
			// tab, workspace, and towers reach the net only; all reaches every other pi session on the machine.
			const targets = scope === "all" ? others : netMembers(others, await panes(run)).filter(inScope).map((m) => m.s);
			const results = await Promise.all(targets.map(async (s) => ({ id: s.id, name: nameOf(s), ...(await send(s.id, message)) })));
			const summary = results.map((r) => `${r.name}: ${r.status}${r.code ? ` (${r.code})` : ""}`).join("\n") || "no recipients";
			if (results.some((r) => r.status !== "sent")) throw new Error(`Not every recipient received it:\n${summary}`);
			return { text: `Broadcast to ${results.length} session(s):\n${summary}`, details: { scope, results } };
		};
		function addNetTools() {
			tool("boss_status", "Show this workspace's Straw Boss coordinators: each tab's main agent, this workspace's tower, the head tower, and the other towers.", Type.Object({}), async () => {
				const result = await status();
				return { text: JSON.stringify(result, null, 2), details: result };
			});
			tool("call_tower", "Send a message to the tower of your workspace, or of another workspace by id or exact label. Opens the tower tab when none is running; the tower replies through intercom.",
				Type.Object({
					message: Type.String({ description: "What the tower needs to know or do: at most two sentences, details by reference." }),
					workspace: Type.Optional(Type.String({ description: "Another workspace's id or exact label. Omit for your own." })),
				}),
				async ({ message, workspace }) => {
					const tower = await openTower(workspace);
					const result = await send(tower.id, message);
					if (result.status !== "sent") throw new Error(`The tower of ${tower.target.label} did not take the message: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
					const via = tower.routed ? ` (${tower.routed.label} is a sub workspace)` : "";
					const text = `Sent to the tower of ${tower.target.label}${via}${tower.opened ? " (opened it)" : ""}. It replies through intercom.`;
					return { text, details: { workspace: tower.target.workspace_id, towerId: tower.id, opened: tower.opened, status: result.status } };
				});
			tool("boss_broadcast", "Send one message to every other session in a scope. tab, workspace, and towers reach only sessions that joined the net; all reaches every pi session on this machine (for notices such as the boss going to sleep).",
				Type.Object({
					message: Type.String({ description: "The message, once; receivers do not re-broadcast it." }),
					scope: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("workspace"), Type.Literal("towers"), Type.Literal("all")], { description: "Default workspace." })),
				}),
				({ message, scope }) => broadcast(message, scope ?? "workspace"));
		}
		function addPromote() {
			tool("boss_promote", "Become the main agent of this Herdr tab when your work grows: several steps, dispatching workers, or touching more than one app. Refused when the tab already has a main agent.", Type.Object({}), async () => {
				const { promoted, text } = await promote(false);
				if (!promoted) throw new Error(text);
				return { text, details: { role: role() } };
			});
		}
		// Tower only. The tower runs no commands: this is its one way to start work, in a new tab of its own workspace.
		function addOpenMain() {
			const open = opener({ run, sleep, workspaceId: at.workspaceId, cwd: process.cwd(), sessions: () => c.listSessions(), send });
			tool("boss_open_main", "Open a new tab in this workspace with a new pi as its main agent and hand it a request that no session owns. Does not ask the boss and does not take focus. Opens at most one main per request; when it fails, tell the sender.",
				Type.Object({
					request: Type.String({ description: "The sender's request exactly as it reached you, with every boss decision it quotes kept verbatim." }),
					sender: Type.String({ description: "The intercom name or session id of the session that made the request; the new main reports back to it." }),
					label: Type.Optional(Type.String({ description: "A short label for the new tab." })),
				}),
				async (input) => {
					const opened = await open(input);
					const text = opened.repeated ? `A main was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with a main agent (session ${opened.main}) and handed it the request. It reports to ${opened.sender}.`;
					return { text, details: opened };
				});
		}
		const startTower = async () => {
			at = await place(run);
			connect(false);
			await connected();
			if (!saved.tower) pi.appendEntry(ENTRY, { tower: true, workspaceId: at.workspaceId });
			await report(run, "pane", at.paneId, { sb_role: "tower" });
			await sleep(SETTLE_MS);
			const all = await workspaces(run);
			const [ps, sessions] = [await panes(run, at.workspaceId), await c.listSessions()];
			const ws = all.find((w) => w.workspace_id === at.workspaceId);
			const holder = ws?.tokens?.tower;
			const rival = ps.find((p) => p.pane_id !== at.paneId && p.agent === "pi" && p.tokens?.sb_role === "tower");
			// A second tower in one workspace yields before it publishes: the live token holder wins, otherwise the lower tab id.
			if ((holder && holder !== me() && sessions.some((s) => s.id === holder)) || (rival && rival.tab_id < at.tabId)) {
				await report(run, "pane", at.paneId, { sb_role: null });
				await run(["tab", "close", at.tabId]);
				return;
			}
			holdsTower = true;
			info = { workspace: ws?.label ?? at.workspaceId, head: headOf(all)?.label ?? "" };
			addNetTools();
			addOpenMain();
			keepFresh();
			await publish();
			// The dashboard lives exactly as long as this session holds the tower role.
			if (hasUI) dashboard = startDashboard({ ui: ui!, collect: () => collect({ run, sessions: () => c.listSessions(), workspaceId: at.workspaceId, gui: async () => { const r = readRecord(guiDir); return r && (await answers(r)) ? urlOf(r) : undefined; } }) });
		};

		// A session in a sub workspace (a linked git worktree) acts like a subagent: it never joins. Failing to tell bars it too.
		const barReason = async () => {
			try {
				const { workspaceId } = await place(run);
				const all = await workspaces(run);
				const sub = all.find((w) => w.workspace_id === workspaceId);
				return sub && isSub(sub) ? { text: `${sub.label} is a sub workspace, so this session cannot join the net; the main agent of its parent workspace represents it`, level: "info" as const } : undefined;
			} catch (error) {
				return { text: `Straw Boss could not tell whether this is a sub workspace: ${(error as Error).message}`, level: "error" as const };
			}
		};

		// STRAW_BOSS_ROLE=main stays in the new tab's shell, so a later pi started there would self-promote. The tower's one-time pane token is what
		// authorises it: this pi consumes the token and keeps the opener's marker (sb_opened_by) fresh, which the tower counts to enforce its limits.
		const claimOpened = async () => {
			if (!opensAsMain) return false;
			const mine = (await panes(run, at.workspaceId).catch(() => [])).find((p) => p.pane_id === at.paneId);
			if (mine?.tokens?.sb_open_main !== "1") return false;
			openedBy = mine.tokens.sb_opened_by;
			await report(run, "pane", at.paneId, { sb_open_main: null }).catch(() => {});
			return true;
		};

		pi.on("session_start", async (_event, ctx) => {
			stopped = false;
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, readFileSync(join(promptDir, `${name}.md`), "utf8").trim()]));
			saved = Object.assign({}, ...ctx.sessionManager.getBranch().flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [e.data] : [])));
			isTower ||= Boolean(saved.tower);
			const log = ctx.sessionManager;
			clearInterval(nudgeTimer);
			nudges?.stop();
			nudges = orphans({ run, file: () => log.getSessionFile(), entries: () => log.getEntries(), sessions, send, type: ENTRY, remember: (key) => pi.appendEntry(ENTRY, { nudged: key }), me, tell });
			nudgeTimer = setInterval(() => void nudges?.poll().catch(() => {}), nudgeMs).unref();
			// Starting runs in the background: pi awaits session_start handlers in turn, and pi-intercom connects in its own, after this one.
			let starting: Promise<void> | undefined;
			if (isTower) {
				starting = startTower();
			} else {
				const bar = await barReason();
				barred = bar?.text;
				if (bar) {
					tell(bar.text, bar.level);
				} else {
					starting = joinNet().then(async () => {
						const taken = (await claimOpened()) && (await promote(false));
						if (taken && !taken.promoted) tell(taken.text, "warning");
					});
				}
			}
			starting?.catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
		});

		pi.on("before_agent_start", (event) => {
			const current = role();
			const name = current === "member" && !mainId ? "member-no-main" : current;
			if (name) event.systemPromptOptions.sections[ENTRY] = render(prompts[name]);
			else delete event.systemPromptOptions.sections[ENTRY];
		});

		// A member that dispatches or resumes a subagent without promoting is promoted here, before the subagent starts, unless the tab already has a main.
		pi.on("tool_call", async (event) => {
			if (!["subagent", "subagent_resume"].includes(event.toolName) || isTower || barred) return;
			try {
				await joinNet();
				if (!isMain) await promote(false);
			} catch (error) {
				tell(`Straw Boss: ${(error as Error).message}`, "warning");
			}
		});

		// A launched subagent is marked within seconds, once its pane shows its session file, instead of at the next 4 minute refresh.
		pi.on("tool_result", (event) => {
			if (["subagent", "subagent_resume"].includes(event.toolName) && !isTower && !barred && role()) for (const ms of KID_MARK_MS) setTimeout(() => void publish(), ms).unref();
		});

		pi.on("session_shutdown", async () => {
			if (gui) await switchRemote(gui, false, guiDir, ts).catch(() => {});
			await gui?.stop();
			gui = undefined;
			dashboard?.stop();
			dashboard = undefined;
			clearInterval(timer);
			timer = undefined;
			clearInterval(nudgeTimer);
			nudges?.stop();
			stopped = true; // a refresh still in flight must not write tokens after they are cleared
			await publishing;
			const held = holdsTower;
			holdsTower = false;
			if (!role() || !at) return;
			await report(run, "pane", at.paneId, { sb_role: null, sb_opened_by: null, sb_order: null, sb_mark: null, sb_indent: null, sb_tab: null }).catch(() => {});
			await clearOrder(run, [...kids]);
			if (held) await report(run, "workspace", at.workspaceId, { tower: null }).catch(() => {});
		});

		// /boss gui is a read-only viewer: any session may open it, and it joins nothing and writes no token. A session outside the net
		// reads the sessions through a channel of its own that never takes part in a tab (no owner, no role).
		const sessions = async () => {
			if (!c && !viewer) {
				const namespace = `straw-boss/view/${Buffer.from(env.HERDR_PANE_ID!).toString("hex")}`;
				pi.events.emit(REGISTER, { namespace, ownerEligible: false, onReady: (channel: Channel) => (viewer = channel), onEvent: () => {} });
				if (!viewer) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
				await connected(viewer);
			}
			return (c ?? viewer!).listSessions();
		};
		// `mode` is "", "stop", "remote", or "remote off". Remote access (remote.ts) belongs to the session that runs the server.
		const guiCommand = async (mode: string) => {
			const elsewhere = async (what: string) => {
				const record = readRecord(guiDir);
				return tell(record && (await answers(record)) ? `The straw net GUI runs in session ${record.owner}; ${what}` : "The straw net GUI is not running");
			};
			if (mode === "stop") {
				const running = gui;
				gui = undefined;
				if (running) {
					const off = await switchRemote(running, false, guiDir, ts).catch((error: Error) => ({ text: error.message, changed: true }));
					if (off.changed) tell(off.text);
					return (await running.stop(), tell("Straw net GUI stopped"));
				}
				return elsewhere("stop it there with /boss gui stop");
			}
			if (mode === "remote off") return gui ? tell((await switchRemote(gui, false, guiDir, ts)).text) : elsewhere("turn remote access off there with /boss gui remote off");
			// One server per machine: a second /boss gui, here or in another session, opens the one that runs. Two calls in flight
			// in this session share one start. A server started here has remote off, so a serve entry a crashed one left goes (remote takes it over).
			opening ??= (async () => {
				if (gui) return gui.url;
				const start = (prefer: { port?: number; token?: string; csrf?: string }, net = netSource({ run, sessions, hub: (hub = hub?.me === me() ? hub : createHub(pi, me(), bridge)) })) => startGui({ read: net.read, net, call, hub, dir: bundle, ...prefer });
				const shared = await sharedGui(guiDir, [`${me() || "unknown"} (pane ${env.HERDR_PANE_ID})`, me()], start, sleep);
				if ((gui = shared.mine) && mode !== "remote") await switchRemote(gui, false, guiDir, ts).catch(() => {});
				return shared.url;
			})().finally(() => (opening = undefined));
			const url = await opening;
			if (mode === "remote") {
				if (!gui) return elsewhere("run /boss gui remote there");
				const { text, lines, link } = await switchRemote(gui, true, guiDir, ts), block = (active: boolean) => pi.events.emit("herdr:blocked", { active, label: "Showing the remote pairing QR code" });
				tell(text);
				return void (lines && link && ui && (await showLines(ui, lines, { block, keys: pairingKeys(link, copy, openUrl) })));
			}
			tell(`Straw net GUI: ${url}`);
			await openUrl(url).catch((error: Error) => tell(`Could not open a browser (${error.message}); open the URL above yourself`, "warning"));
		};

		pi.registerCommand("boss", {
			description: "Take over as this tab's main agent (every session already joins as a member). /boss status shows the coordinators; /boss tower opens and focuses the workspace tower; /boss gui opens the net in the browser (/boss gui stop closes it; /boss gui remote opens it to your phone over Tailscale, /boss gui remote off closes that).",
			handler: async (args, ctx) => {
				ui = ctx.ui;
				try {
					if (/^gui( stop| remote( off)?)?$/.test(args.trim())) return await guiCommand(args.trim().slice(4));
					if (args.trim() === "status") return tell(joined || isTower ? JSON.stringify(await status(), null, 2) : "Not in the net: still joining, or this session cannot join.");
					if (isTower) throw new Error("This session is the tower, not a main agent");
					if (args.trim() !== "tower") return tell((await promote(true)).text);
					await joinNet();
					const tower = await openTower();
					const where = (await c.listSessions()).find((s) => s.id === tower.id)?.herdrLocation;
					if (where?.tab) await run(["tab", "focus", where.tab.id]);
				} catch (error) {
					tell((error as Error).message, "error");
				}
			},
		});
	};
}

export default createStrawBoss();
