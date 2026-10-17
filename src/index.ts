import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { collect, startDashboard } from "./dashboard.ts";
import { type Gui, openBrowser, startGui } from "./gui.ts";
import { collectNet } from "./net.ts";
import { ensureTower, headOf, herdrApi, type HerdrApi, herdrRun, type HerdrRun, isSub, type Pane, panes, parentOf, place, type Place, report, type Session, type Sleep, waitFor, workspaces, type Workspace } from "./herdr.ts";

// pi-intercom's extension API as constants and minimal types: intercom is a runtime requirement, not an import.
const REGISTER = "intercom:extension-register";
const OUTBOX = "intercom:outbox-request";
const OUTBOX_RESULT = "intercom:outbox-result";
const NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const ENTRY = "straw-boss";
const PROMPTS = ["main", "tower", "member", "reminder"];
const REFRESH_MS = 4 * 60_000;
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
interface Saved { asked?: boolean; joined?: boolean; tower?: boolean }
type Role = "tower" | "main" | "member";
type Scope = "tab" | "workspace" | "towers" | "all";
type Member = ReturnType<typeof netMembers>[number];
export interface Deps { run?: HerdrRun; api?: HerdrApi; env?: NodeJS.ProcessEnv; sleep?: Sleep; promptDir?: string; bundle?: string; openUrl?: (url: string) => Promise<void> }

/** Live sessions whose pane carries an `sb_role` token: the sessions that joined the net, and towers. */
function netMembers(sessions: Session[], ps: Pane[]) {
	return sessions.flatMap((s) => {
		const { workspace, tab, paneId } = s.herdrLocation ?? {};
		const role = ps.find((p) => p.pane_id === paneId)?.tokens?.sb_role;
		return workspace && tab && role ? [{ s, role, tab, workspace }] : [];
	});
}
const nameOf = (s?: Session) => (s ? (s.name ?? s.id) : "");

export function createStrawBoss({ run = herdrRun, api = herdrApi(), env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), promptDir = fileURLToPath(new URL("../prompts", import.meta.url)), bundle, openUrl = openBrowser }: Deps = {}) {
	return function strawBoss(pi: ExtensionAPI): void {
		// Outside Herdr there is no tab to coordinate. A pi-herdr-agents worker never joins: its parent represents it.
		if (!env.HERDR_PANE_ID || env.PI_SUBAGENT_ID) return;
		let isTower = env.STRAW_BOSS_ROLE === "tower";
		let asked = false, joined = false, isMain = false, holdsTower = false, requests = 0;
		// Why this session cannot join: it sits in a sub workspace, or Herdr could not say whether it does.
		let barred: string | undefined, dashboard: ReturnType<typeof startDashboard> | undefined, hasUI = false;
		let prompts: Record<string, string> = {}, info: Record<string, string> = {}, saved: Saved = {};
		let gui: Gui | undefined, viewer: Channel | undefined, lastGui: { port: number; token: string } | undefined;
		let c!: Channel, at!: Place, ui: ExtensionContext["ui"] | undefined, timer: ReturnType<typeof setInterval> | undefined;
		let queue: Promise<void> = Promise.resolve();
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
		const connect = (eligible: boolean) => {
			const namespace = `straw-boss/tab/${Buffer.from(at.tabId).toString("hex")}`;
			if (!NAMESPACE.test(namespace)) throw new Error(`Tab id ${at.tabId} is too long for an intercom namespace (limit 24 characters)`);
			pi.events.emit(REGISTER, { namespace, ownerEligible: eligible, onReady: (channel: Channel) => (c = channel), onEvent });
			if (!c) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
		};

		// Tokens are display and discovery only: a failed write waits for the next refresh, liveness comes from intercom.
		const publish = async () => {
			const sbRole = role();
			if (sbRole) await report(run, "pane", at.paneId, { sb_role: sbRole }).catch(() => {});
			if (holdsTower) await report(run, "workspace", at.workspaceId, { tower: me() }).catch(() => {});
		};
		const keepFresh = () => {
			timer ??= setInterval(() => void publish(), REFRESH_MS);
			timer.unref();
		};

		// The owner records who is main. The first joiner pins itself, so a later owner change never swaps the main agent.
		const pin = (main?: string) => {
			if (main && c.snapshot().owner?.sessionId === me()) c.commitState({ v: 1, main, since: Date.now() });
		};
		const onEvent = (event: { type: string; fromSessionId?: string; payload?: { type?: string } }) => {
			if (event.type === "message" && event.payload?.type === "claim") pin(event.fromSessionId);
			else if (["connection", "owner", "state", "session_left"].includes(event.type)) void sync();
			if (["presence_update", "session_joined", "session_left"].includes(event.type)) dashboard?.poke();
		};
		const refresh = async () => {
			if (!joined) return;
			try {
				const snap = c.snapshot();
				const sessions = await c.listSessions();
				let main = (snap.state?.payload as { main?: string } | undefined)?.main;
				if (!sessions.some((s) => s.id === main)) {
					// The pinned main is gone: the owner is main until it pins itself.
					main = snap.owner?.sessionId;
					pin(main);
				}
				const ws = (await workspaces(run)).find((w) => w.workspace_id === at.workspaceId);
				const tab = sessions.find((s) => s.id === me())?.herdrLocation?.tab?.label ?? at.tabId;
				info = { tab, workspace: ws?.label ?? at.workspaceId, main: nameOf(sessions.find((s) => s.id === main)), tower: nameOf(sessions.find((s) => s.id === ws?.tokens?.tower)) };
				const wasMain = isMain;
				isMain = main === me();
				if (isMain !== wasMain) tell(`This session is ${isMain ? "now" : "no longer"} the main agent of ${info.tab}`);
				await publish();
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
		const joinNet = async (restored = false) => {
			if (joined) return;
			if (barred) throw new Error(barred);
			at = await place(run);
			connect(true);
			await connected();
			if (!(await waitFor(sleep, () => c.snapshot().owner, CLAIM_MS))) throw new Error("No intercom owner was elected for this tab");
			joined = true;
			if (!restored) pi.appendEntry(ENTRY, { asked: true, joined: true });
			addNetTools();
			keepFresh();
			await sync();
		};
		const takeover = async () => {
			await joinNet();
			if (!isMain) {
				if (c.snapshot().owner?.sessionId === me()) pin(me());
				else c.publish({ type: "claim" }, { audience: "owner" });
				if (!(await waitFor(sleep, () => isMain, CLAIM_MS))) throw new Error("The owner did not confirm the takeover within 5 s");
			}
			return `This session is the main agent of tab ${info.tab}`;
		};
		const send = (to: string, message: string) =>
			new Promise<SendResult>((resolve) => {
				const requestId = `straw-boss-${me()}-${++requests}`;
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
			return { target, routed: target !== asked ? asked : undefined, ...(await ensureTower({ run, sleep, live, moveFirst }, target, process.cwd())) };
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
			keepFresh();
			await publish();
			// The dashboard lives exactly as long as this session holds the tower role.
			if (hasUI) dashboard = startDashboard({ ui: ui!, collect: () => collect({ run, sessions: () => c.listSessions(), workspaceId: at.workspaceId }) });
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

		pi.on("session_start", async (_event, ctx) => {
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, readFileSync(join(promptDir, `${name}.md`), "utf8").trim()]));
			saved = Object.assign({}, ...ctx.sessionManager.getBranch().flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [e.data] : [])));
			asked = Boolean(saved.asked);
			isTower ||= Boolean(saved.tower);
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
					tool("boss_join", "Join this Herdr workspace's Straw Boss net when your current work competes for resources with, or collaborates with, other work in the workspace. The first session of a tab to join becomes its main agent; later ones are members.", Type.Object({}), async () => {
						await joinNet();
						const text = isMain ? `Joined as the main agent of tab ${info.tab}.` : `Joined tab ${info.tab} as a member; its main agent is ${info.main}.`;
						return { text, details: { role: role() } };
					});
					if (saved.joined) starting = joinNet(true);
				}
			}
			starting?.catch((error: Error) => tell(`Straw Boss: ${error.message}`, "error"));
		});

		pi.on("before_agent_start", (event) => {
			const current = role();
			// A session outside the net is asked once, at its first run, whether it should join.
			const first = !current && !asked && !barred;
			if (first) {
				asked = true;
				pi.appendEntry(ENTRY, { asked: true });
			}
			let text: string | undefined;
			if (current) text = render(prompts[current]);
			else if (first) text = render(prompts.reminder);
			if (text) event.systemPromptOptions.sections[ENTRY] = text;
			else delete event.systemPromptOptions.sections[ENTRY];
		});

		pi.on("session_shutdown", async () => {
			await gui?.stop();
			gui = undefined;
			dashboard?.stop();
			dashboard = undefined;
			clearInterval(timer);
			timer = undefined;
			const held = holdsTower;
			holdsTower = false;
			if (!role() || !at) return;
			await report(run, "pane", at.paneId, { sb_role: null }).catch(() => {});
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
		const guiCommand = async (stop: boolean) => {
			if (stop) {
				const running = gui;
				gui = undefined;
				await running?.stop();
				return tell(running ? "Straw net GUI stopped" : "The straw net GUI is not running");
			}
			// A restarted server asks for the port and token it had, so a page that is still open reconnects by itself.
			gui ??= await startGui({ read: () => collectNet({ run, sessions }), dir: bundle, ...lastGui });
			lastGui = { port: gui.port, token: gui.token };
			tell(`Straw net GUI: ${gui.url}`);
			await openUrl(gui.url).catch((error: Error) => tell(`Could not open a browser (${error.message}); open the URL above yourself`, "warning"));
		};

		pi.registerCommand("boss", {
			description: "Join this tab's Straw Boss net and become its main agent. /boss status shows the coordinators; /boss tower opens and focuses the workspace tower; /boss gui opens the net in the browser (/boss gui stop closes it).",
			handler: async (args, ctx) => {
				ui = ctx.ui;
				try {
					if (/^gui( stop)?$/.test(args.trim())) return await guiCommand(args.trim() === "gui stop");
					if (args.trim() === "status") return tell(joined || isTower ? JSON.stringify(await status(), null, 2) : "Not in the net. /boss joins it.");
					if (isTower) throw new Error("This session is the tower, not a main agent");
					if (args.trim() !== "tower") return tell(await takeover());
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
