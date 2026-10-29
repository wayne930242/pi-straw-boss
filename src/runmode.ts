import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BOSS_MARK, CRASH_FLAG, cleanLabel } from "./eventmarks.ts";
import { panes, type Place, TOWER_LABEL, tabs } from "./herdr.ts";
import { createApproval } from "./link/approval.ts";
import type { Level } from "./link/config.ts";
import type { Link } from "./link/runtime.ts";
import { HERE_ONLY } from "./link/request.ts";
import type { ServerLook } from "./server-look.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import { markRun } from "./runmark.ts";
import { startOf as processStart } from "./startof.ts";
import { ENTRY, type Kit } from "./state.ts";
import { MEMORY_DESCRIPTION, memoryParameters } from "./memorytool.ts";
import { createTools, LINK_REQUEST_DESCRIPTION, linkRequestParameters } from "./tools.ts";

// A pi the sb server started for a tower run (docs/specs/2026-10-26-sb-backend.md, Local runs): it is a short life of its own and no part of a tab's net. At its start it claims its run over the
// control socket (`--sb-run <run id>`; a pi without the flag in a standing pane asks `pane-role`), gets the brief and a run token, registers the tower tools as clients of the server, and lives off
// the server's queue: it polls, takes one event at each idle moment as a `straw-tower` message, and ends with `tower_done`. Nothing here joins a net, publishes tokens, or runs the guard.

type Answer = { ok: boolean; error?: string; [key: string]: unknown };
export interface RunSideDeps {
	/** Replaces the control socket: one request to the sb server, answered (a test hands the run the server of its world). */
	ask?: (request: Record<string, unknown>) => Promise<Answer>;
	/** How often a run polls, how long its claim is held, how long the server may stay out of reach (no answer, or a refusal) before the run gives up, how long a trigger may take to start the turn, and how long a pi in a tower-glyph tab waits for a server. */
	pollMs?: number;
	claimWaitMs?: number;
	towerAskMs?: number;
	lostMs?: number;
	startMs?: number;
	glyphWaitMs?: number;
	/** Reads a process's start time (a test counts the reads); `startOf` by default. */
	startOf?: (pid: number) => string | undefined;
}
export const MESSAGE = "straw-tower";
const POLL_MS = 1000, CLAIM_WAIT_MS = 10_000, LOST_MS = 30_000, TURN_START_MS = 15_000, GLYPH_WAIT_MS = 30_000;
/** The boss's words in the run's session are told to the server at most this often: its silence is judged in minutes. */
const BOSS_SIGN_MS = 15_000;
/** A run's pane tokens: the tower's standing pane and an ally run's pane. */
const RUN_PANE_ROLES = new Set(["tower", "ally"]);
/** A `/reload` makes a new instance of the extension in the same process: the claim stays with the process. */
const KEPT = Symbol.for("pi-straw-boss.run");
interface Peer { device: string; label: string; short: string; team: string; teamName: string }
interface Claim { token: string; kind: "local" | "ally"; level?: string; peer?: Peer; run: string; workspace: string; identity: string; label: string; brief: string; hand?: boolean }
interface Event { id: string; kind: string; text: string; from?: { id: string; name?: string }; flag?: string }
type Command = { type: "steer"; text: string } | { type: "quit" } | { type: "confirmed"; dialogId: string; allow: boolean };

const NO_SUBAGENTS = "A tower run dispatches no subagents: one would outlive the run. Open a main for the work with boss_open_main, or route it to the main that owns it.";
const BLOCKED = "In a tower run, answer a local session with tower_reply (or tower_send to a tower): intercom would carry this run's own short-lived id, and the answer would reach a pi that has already exited.";
/** The tower tools a local run registers (the same descriptions and schemas as a resident tower's, tools.ts), each now a client of the server. */
const REGISTERED = new Set(["boss_status", "call_tower", "boss_server", "tower_list", "board_read", "tower_send", "boss_open_main", "boss_close_main"]);
/** What an ally run registers: no `call_tower`, `boss_server`, or `link_request`; the server refuses them by the run's kind as well. */
const ALLY_REGISTERED = new Set(["boss_status", "tower_list", "board_read", "tower_send", "boss_open_main", "boss_close_main"]);
/** pi-intercom's custom message: an ally run's context drops it, as a backstop to the blocked tool. */
const INTERCOM_MESSAGE = "intercom_message";
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** How an event reads to the model: an intercom one opens with a line this code writes from the broker's sender (the text after it is the sender's own, and may claim anything), then the header the sender's code wrote. */
export function eventText(e: Pick<Event, "kind" | "text" | "flag" | "from">): string {
	// The flag line comes after the marker line, so an event still opens with its marker: only the boss line marks the boss.
	const flag = e.flag === "crash" ? `\n${CRASH_FLAG}` : "";
	if (e.kind === "boss") return `${BOSS_MARK}${flag}\n${e.text}`;
	if (e.kind === "notice") return `[notice from the sb server]${flag}\n${e.text}`;
	if (e.kind === "timer") return `[your wakeAfter follow-up is due]${flag}\n${e.text}`;
	// A teammate's message to an ally run: the server wrote the verified header (device, team, the ask it carries) before the peer's text.
	if (e.kind === "link") return e.text;
	const label = (v = "") => cleanLabel(v);
	const sender = e.from ? `${label(e.from.name) ? `${label(e.from.name)} ` : ""}(${label(e.from.id)})` : "an unknown sender";
	return `[intercom from ${sender}]${flag}\n${e.text}`;
}

export function createRunMode(kit: Kit, look: ServerLook | undefined, deps: RunSideDeps = {}, link?: Link) {
	const { pi, cfg, s, guiDir, tell } = kit;
	const { env } = cfg;
	const { pollMs = POLL_MS, claimWaitMs = CLAIM_WAIT_MS, lostMs = LOST_MS, startMs = TURN_START_MS, glyphWaitMs = GLYPH_WAIT_MS, towerAskMs = 2500, startOf = processStart } = deps;
	pi.registerFlag("sb-run", { description: "The id of the tower run this pi was started for (set by the sb server; do not pass it by hand)", type: "string" });

	let mode: "unknown" | "run" | "normal" = "unknown", claim: Claim | undefined, ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined, polling = false, ending = false, closing = false;
	// The turn a message was sent for has not begun, or one is under way: the run is not idle for the server until it settles.
	let inTurn = false, triggered: number | undefined, outOfReach: number | undefined;
	// A quit the server ordered while the turn runs. pi would keep `ctx.shutdown()` itself and honour it at its next idle moment with no way to take it back, so the run holds the order instead: a server that restarted meanwhile (the run claims again) never ordered it, and the run goes on.
	let quitOrdered = false;
	let registered = false, bossSign: number | undefined, bossTyped = false, signing: Promise<unknown> | undefined;
	// The pane-role ask of a pi with STRAW_BOSS_ROLE=tower that did not come back within `towerAskMs` is still in flight: the session is undecided, neither a run nor a normal session (so it joins nothing, hands nothing
	// over and quits nothing) until the answer comes. `epoch` counts session starts and shutdowns, so an answer for a session that is gone is released instead of acted on; `afterNormal` holds the session start that waits for a `none`.
	let epoch = 0, deciding: (() => void)[] | undefined;

	// Every request goes through the session's look at the server (server-look.ts), which passes the record through the owner gate before it is trusted or a secret is sent to its socket (R13-F003):
	// a run never reads the record itself. It starts nothing: a run of a server that is gone has nothing to run for.
	const ask = deps.ask ?? (async (request: Record<string, unknown>): Promise<Answer> => {
		if (!look) throw new Error("this session has no look at the sb server");
		return look.ask(request, { start: "never" });
	});
	const sleep = (ms: number) => cfg.sleep(ms);

	/** One request of a run with its token: the answer, or the reason it was refused as an error. */
	const call = async (request: Record<string, unknown>): Promise<Answer> => {
		const answer = await ask({ ...request, token: claim?.token });
		if (!answer.ok) throw Object.assign(new Error(String(answer.error ?? "the sb server refused the request")), { reply: answer });
		return answer;
	};

	// An ally run is one remote turn for its whole session (docs/specs/2026-10-26-sb-backend.md, Security: Remote turns after the split): the hooks of link/hooks.ts, registered by the session's link module, hold every
	// call to the level of its sender, which the claim fixes and the policy can only lower. The `forward` confirm to the sender's device goes through the server with the run's token, which pins the device; its answer
	// comes back as a command at the poll.
	/** Pins an ally run's turn to its sender; false for an ally claim that cannot be pinned (no peer, or no link module), which must not run unpinned with every tool. */
	const pinPeer = (): boolean => {
		if (claim?.kind !== "ally") return true;
		const peer = claim.peer;
		if (!peer || !link) return false;
		link.pinRun({ id: peer.device, short: peer.short, label: peer.label, team: peer.team, floor: (["reply", "forward", "dispatch"].includes(claim!.level ?? "") ? claim!.level : "reply") as Level }, async (op) => (await call({ cmd: "link", body: op })).answer as Answer);
		return true;
	};
	const approval = createApproval({ bus: pi.events, onError: () => {} });

	// --- claiming --------------------------------------------------------------------------------------------------------------------------------------------------

	/** The claim of the run id this pi was started with; held answers are asked again each second for `claimWaitMs`. Rejects with the server's reason. */
	async function claimRun(runId: string): Promise<Claim> {
		const end = cfg.now() + claimWaitMs, started = startOf(process.pid);
		for (;;) {
			const answer = await ask({ cmd: "claim", runId, pane: env.HERDR_PANE_ID ?? "", pid: process.pid, ...(started ? { started } : {}) });
			if (!answer.ok) throw new Error(String(answer.error ?? "the claim was refused"));
			if (!answer.wait) {
				// SAFETY: a claim answered `ok` and not `wait` carries the Claim fields (runs.ts, ClaimReply).
				return answer as unknown as Claim;
			}
			if (cfg.now() >= end) throw new Error("the sb server did not settle the claim in time");
			await sleep(1000);
		}
	}
	function residentTower(context: ExtensionContext): boolean {
		try { return context.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === ENTRY && (e.data as { tower?: unknown } | undefined)?.tower === true); } catch { return false; }
	}
	/** A pi without the flag in a standing pane: the server says whether to quit, wait, or take the pane as a run of the boss's own. */
	type Found = { role: "none" | "quit" | "hand"; reason?: string; claim?: Claim };
	async function paneRole(context: ExtensionContext, reason: string): Promise<Found | { role: "late"; settle: Promise<Found | undefined> }> {
		const pane = env.HERDR_PANE_ID, workspace = env.HERDR_WORKSPACE_ID;
		// Without the flag file no sb server runs towers, so no pane is one (and a session asks Herdr nothing at its start for this).
		if (!pane || !workspace || !towerRunsEnabled(guiDir)) return { role: "none" };
		// A resident tower (it carries STRAW_BOSS_ROLE=tower) is no pi the boss typed into a standing pane: it hands its pane over itself (tower.ts). A /reload right after the server registered its identity finds its pane marked
		// `tower` already, and asking would make it a hand run that never hands over and never ends (B6 VM F4).
		// Only a session that already wrote its tower entry is one: the env alone stays in a migrated standing pane's tab, and a pi the boss types there is a hand run. That pi always starts with `startup`: a /reload, /new,
		// /resume, or /fork of a resident tower is its in-process switch (the server holds the pane for it while it lives), and the new branch has no entry yet (B6 VM review RV6B-F001).
		if (env.STRAW_BOSS_ROLE === "tower" && (reason !== "startup" || residentTower(context))) return { role: "none" };
		// The env alone may be a fresh resident (it hands over itself) or a pi the boss typed in a migrated standing pane: the server knows which pane it holds. An error or an older server means resident. An answer
		// that does not come within `towerAskMs` (a cold Windows server took 3.9 s) decides nothing: quitting or handing over on a guess ended a hand pi that was only waiting, so the ask stays in flight and the
		// answer is acted on when it comes (`late`). The start time is read once, before the clock starts (the read is a sync PowerShell call of seconds there).
		if (env.STRAW_BOSS_ROLE === "tower") {
			const started = startOf(process.pid);
			// An ask that fails is no answer: resident when it fails within the bound (no server), a plain session when it fails after it (`late` settles undefined).
			const asked = ask({ cmd: "pane-role", pane, pid: process.pid, ...(started ? { started } : {}) }).then((answer): Found | undefined => {
				// SAFETY: same `pane-role` answer shape as below (runs.ts, paneRole).
				return answer?.ok && (answer.role === "hand" || answer.role === "quit") ? (answer as unknown as Found) : { role: "none" };
			}, () => undefined);
			const quick = await Promise.race([asked.then((found) => ({ found })), sleep(towerAskMs).then(() => undefined)]);
			if (quick) return quick.found ?? { role: "none" };
			tell("Straw Boss: the sb server has not said yet whether this pane is the tower's; this session does nothing and stays a plain session until it answers", "warning");
			return { role: "late", settle: asked };
		}
		const mine = (await panes(cfg.run, workspace).catch(() => [])).find((p) => p.pane_id === pane);
		const marked = RUN_PANE_ROLES.has(mine?.tokens?.sb_role ?? "");
		// Herdr drops the pane tokens at a restart until the server publishes them again, so a pi resumed first finds its pane unmarked: a pane in a tab with the tower label is asked about too (not a resident tower the session started itself, which carries STRAW_BOSS_ROLE=tower), and waits
		// up to 30 s for a live server and for its takeover (docs/specs/2026-10-26-sb-backend.md, Local runs, step 2).
		const glyph = !marked && mine !== undefined && (await tabs(cfg.run, workspace).catch(() => [])).some((t) => t.tab_id === mine.tab_id && t.label === TOWER_LABEL);
		if (!marked && !glyph) return { role: "none" };
		const end = cfg.now() + (glyph ? glyphWaitMs : claimWaitMs), started = startOf(process.pid);
		for (;;) {
			const answer = await ask({ cmd: "pane-role", pane, pid: process.pid, ...(started ? { started } : {}) }).catch(() => undefined);
			// No server to ask: a marked pane's pi is what it was before; one in a tower tab keeps asking until its wait is over.
			if (!answer?.ok && !glyph) return { role: "none" };
			if (answer?.ok && answer.role !== "wait") {
				// SAFETY: a `pane-role` answer carries the role, and a claim when the role is `hand` (runs.ts, paneRole).
				return answer as unknown as Found;
			}
			if (cfg.now() >= end) return { role: "none" };
			await sleep(1000);
		}
	}

	// --- the tools ---------------------------------------------------------------------------------------------------------------------------------------------------

	/** A tower tool of the run: the server does the work as the tower identity and the run only shows what came back. */
	const tool = async (name: string, args: unknown, toolCallId?: string): Promise<{ text: string; details?: unknown }> => {
		const answer = await call({ cmd: "run-tool", tool: name, args, ...(toolCallId ? { toolCallId } : {}) });
		return { text: text(answer.text) || "(no text)", ...(answer.details !== undefined ? { details: answer.details } : {}) };
	};
	function registerTools() {
		if (registered) return;
		registered = true;
		// The tools a tower has keep their descriptions and schemas (tools.ts): the same registrations are made through a pi whose registerTool swaps the body for a request to the server.
		const proxy = new Proxy(pi, {
			get(target, key) {
				if (key === "registerTool") {
					return (def: Parameters<ExtensionAPI["registerTool"]>[0]) => {
						if (!(claim!.kind === "ally" ? ALLY_REGISTERED : REGISTERED).has(def.name)) return;
						target.registerTool({ ...def, execute: async (id: string, params: unknown) => {
							const done = await tool(def.name, params, id);
							return { content: [{ type: "text" as const, text: done.text }], details: done.details };
						} } as never);
					};
				}
				const value = Reflect.get(target, key) as unknown;
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		});
		const unused = () => { throw new Error("not available in a tower run"); };
		// SAFETY: only the registrations of createTools run here (their bodies are replaced above); `s.at` is what addOpenMain builds from.
		s.at = { workspaceId: claim!.workspace, paneId: env.HERDR_PANE_ID ?? "", tabId: env.HERDR_TAB_ID ?? "" } as Place;
		const tools = createTools({ ...kit, pi: proxy }, { post: unused, callTower: unused, status: unused, broadcast: unused, towerList: unused, towerSend: unused, read: unused, promote: unused, digest: undefined as never, closeMain: unused, link: undefined as never, server: claim!.kind === "local" ? ({} as never) : undefined, towerCall: true } as never);
		tools.addNetTools();
		tools.addOpenMain();
		tools.addTowerComms();
		if (claim!.kind === "local") registerLinkRequest();
		// The memory of the tower (towermemory.ts) is a local run's: the server refuses the tool to an ally run by its kind as well.
		if (claim!.kind === "local") pi.registerTool({ name: "tower_memory", label: "tower_memory", description: MEMORY_DESCRIPTION, parameters: memoryParameters(), execute: async (id, params) => ({ content: [{ type: "text", text: (await tool("tower_memory", params, id)).text }], details: undefined }) });
		pi.registerTool({
			name: "tower_reply", label: "tower_reply",
			description: "Answer one local session (a main or a member) by its intercom name or session id. It goes out under the tower's header, as the tower identity, so the answer reaches the session that asked. In a run this replaces intercom send.",
			parameters: Type.Object({
				to: Type.String({ description: "The session's intercom name or session id." }),
				message: Type.String({ description: "The answer, terse: what the session needs to know or do." }),
				reply: Type.Optional(Type.Boolean({ description: "Whether you wait for an answer. Default false." })),
			}),
			execute: async (id, params) => {
				const done = await tool("tower_reply", params, id);
				return { content: [{ type: "text", text: done.text }], details: done.details };
			},
		});
		pi.registerTool({
			name: "tower_done", label: "tower_done",
			description: "End this run. Call it when nothing is left for you, with a handoff note for your next run (what you routed, what waits for whom, what to check): one item per line, 1 to 1,200 characters. wakeAfter (5 to 240 minutes) asks for a follow-up run at that time; a later one replaces an earlier one. Refused while events are still for you: they come to you at your next idle moment.",
			parameters: Type.Object({
				note: Type.String({ description: "The handoff note: one item per line, 1 to 1,200 characters." }),
				wakeAfter: Type.Optional(Type.Number({ description: "Minutes until a follow-up run, 5 to 240. Local runs only." })),
			}),
			execute: async (_id, params, _signal, _update, context) => {
				await signing;
				const answer = await call({ cmd: "run-done", note: params.note, ...(params.wakeAfter !== undefined ? { wakeAfter: params.wakeAfter } : {}) });
				// The boss is in this run: the server does not end it, and the model is told why (docs/how-it-works.md, The boss in a run).
				if (answer.stay === true) return { content: [{ type: "text", text: text(answer.text) || "The boss is in this session: stay and answer them; the run ends when they quit it." }], details: { stay: true } };
				closing = true;
				// Pi leaves once this result is written: the server has recorded the note and marked the run closing.
				context.shutdown();
				return { content: [{ type: "text", text: "Done: the note is kept for your next run. This run ends now." }], details: { closing: true } };
			},
		});
	}

	/**
	 * `link_request` in a local run: the boss approves it in the dialog this run publishes, as in any session; the server asks the holder what the request does (`open`), carries it out only when the hub saw
	 * this approval close with a yes for this call (`run`), and an approval the boss refuses withdraws it (`drop`). An ally run has none (the server refuses it by the run's kind).
	 */
	function registerLinkRequest() {
		pi.registerTool({
			name: "link_request", label: "link_request", description: LINK_REQUEST_DESCRIPTION, parameters: linkRequestParameters(),
			execute: async (toolCallId, params, signal, _update, context) => {
				const args = Object.fromEntries(Object.entries(params.args ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
				const opened = await tool("link_request", { phase: "open", action: params.action, args, reason: params.reason }, toolCallId);
				const details = opened.details as { id: string; lines: string[]; reason: string };
				const asker = `tower run of ${claim!.label}`;
				const lines = [...details.lines, `Asked by session: ${asker} (${claim!.run.slice(0, 8)})`, `Reason: ${details.reason}`];
				const verdict = await approval.approve({ hereOnly: (HERE_ONLY as readonly string[]).includes(params.action), toolCallId, lines, asker, ...(context.hasUI ? { ui: context.ui } : {}), ...(signal ? { signal } : {}) });
				if (!verdict.approved) {
					await tool("link_request", { phase: "drop", id: details.id }, toolCallId).catch(() => undefined);
					throw new Error(verdict.reason);
				}
				const ran = await tool("link_request", { phase: "run", id: details.id }, toolCallId);
				return { content: [{ type: "text", text: ran.text }], details: { action: params.action } };
			},
		});
	}

	// --- living off the server's queue ----------------------------------------------------------------------------------------------------------------------------

	const send = (message: string, details: unknown) => {
		triggered = cfg.now();
		pi.sendMessage({ customType: MESSAGE, content: message, display: true, details }, { triggerTurn: true, deliverAs: "steer" });
	};
	const apply = async (answer: Answer) => {
		const command = answer.command as Command | undefined, event = answer.event as Event | undefined;
		// A run that lives long is given a newer brief when what it is made of moved (runs.ts `refreshed`): `before_agent_start` reads it at the next turn.
		if (typeof answer.brief === "string" && answer.brief && claim) (claim = { ...claim, brief: answer.brief }, keep());
		if (command?.type === "quit") return void ((quitOrdered = true), flushQuit());
		if (command?.type === "confirmed") return link?.answerForward(command.dialogId, command.allow);
		if (command?.type === "steer") return send(`[sb server] ${command.text}`, { steer: true });
		if (!event) return;
		// Idle and nothing queued are read again at the moment of delivery, after the round trip: a run that got busy meanwhile is offered the event again at its next idle poll.
		if (!idle() || ctx?.hasPendingMessages()) return;
		send(eventText(event), { id: event.id, kind: event.kind, ...(event.from ? { from: event.from } : {}) });
		await call({ cmd: "run-taken", id: event.id }).catch((error: Error) => tell(`Straw Boss: the server did not take note of an event: ${error.message}`, "warning"));
	};
	/** Whether the ordered quit went out: only at an idle moment, which is when pi would have done it. */
	function flushQuit(): boolean {
		if (!quitOrdered || !ctx?.isIdle()) return false;
		quitOrdered = false;
		ctx.shutdown();
		return true;
	}
	const idle = () => Boolean(ctx?.isIdle()) && !inTurn && (triggered === undefined || cfg.now() - triggered > startMs);
	async function tick() {
		if (polling || ending || !claim) return;
		if (flushQuit()) return;
		polling = true;
		try {
			const answer = await ask({ cmd: "run-poll", token: claim.token, idle: idle() });
			if (!answer.ok) {
				// A restarted server has no tokens: the run claims again with its run id and the server, which kept the run, answers (or refuses and the run leaves).
				if (answer.error === "unknown_token") return await reclaim();
				// No server (the look answers `no server` for a socket that is gone) or a refusal: out of reach, and the run leaves when it stays so for `lostMs`.
				return unreachable(String(answer.error ?? "no answer"));
			}
			outOfReach = undefined;
			await apply(answer);
		} catch (error) {
			unreachable((error as Error).message);
		} finally {
			polling = false;
		}
	}
	/** The server did not answer, or refused: the run waits for it (a restart takes up to 30 s) and ends when `lostMs` has passed without an answer. */
	function unreachable(why: string) {
		outOfReach ??= cfg.now();
		if (cfg.now() - outOfReach <= lostMs) return;
		// A turn the boss is in (a hand run, or their words in the run) is not cut: it waits for idle as before. pi keeps a shutdown until its next idle moment, and a model call can last many minutes: an orphaned run in the middle of a turn aborts it first (B6 VM F9).
		if (!ending && !(claim?.hand || bossTyped)) try { if (ctx && !ctx.isIdle()) ctx.abort(); } catch { /* the session is already gone */ }
		end(`the sb server has been out of reach for ${Math.round(lostMs / 1000)} s; this run ends: ${why}`);
	}
	async function reclaim() {
		try {
			const again = await claimRun(claim!.run);
			claim = again;
			quitOrdered = false; // the stop that ordered it was the old server's
			if (!pinPeer()) return refuseUnpinned();
			outOfReach = undefined;
			keep();
		} catch (error) {
			unreachable(`the server no longer knows this run: ${(error as Error).message}`);
		}
	}
	/** An ally claim with no peer (or a session with no link module) is never run unpinned: the server is told to let the run go and pi leaves. */
	function refuseUnpinned() {
		end("this ally run names no sender it can be pinned to, so it cannot run");
		void ask({ cmd: "run-release", token: claim?.token, reason: "unpinned" }).catch(() => {});
	}
	const keep = () => void ((globalThis as Record<symbol, unknown>)[KEPT] = claim ? { claim } : undefined);
	function end(reason: string) {
		if (ending) return;
		ending = true;
		tell(`Straw Boss: ${reason}`, "warning");
		try {
			ctx?.shutdown();
		} catch { /* the session is already gone (a stale ctx after a reload or dispose) */ }
	}

	// --- the session's events --------------------------------------------------------------------------------------------------------------------------------------------

	// The boss's own words in this session (the keyboard, not an event or a steer of the server's) make them part of the run: the server then keeps it until they leave (docs/how-it-works.md, The boss in a run).
	pi.on("input", (event) => {
		if (mode !== "run" || claim?.kind !== "local" || event.source !== "interactive") return;
		// Their words protect the turn from the abort whether or not the server heard them (it may be the very thing that is away): the flag is not undone by a failed request, the rate-limit mark is.
		bossTyped = true;
		if (bossSign !== undefined && cfg.now() - bossSign < BOSS_SIGN_MS) return;
		bossSign = cfg.now();
		// Not waited for: pi takes the boss's words only after this handler, and a round trip here would let the run's own event start a turn first and the words be refused as "already processing". The request goes out now;
		// a tower_done waits for it (below), so it is heard before the model can end the run. A server that did not hear is asked again at their next words.
		signing = call({ cmd: "run-boss" }).catch(() => void (bossSign = undefined));
	});
	pi.on("agent_start", () => void ((inTurn = true), (triggered = undefined)));
	pi.on("agent_settled", () => void ((inTurn = false), flushQuit()));
	pi.on("tool_call", (event) => {
		if (mode !== "run") return;
		if (event.toolName === "intercom") return { block: true, reason: BLOCKED };
		// A subagent would outlive the run (a pane and a process left behind after tower_done): a run routes work through the mains it opens.
		if (event.toolName === "subagent" || event.toolName === "subagent_resume") return { block: true, reason: NO_SUBAGENTS };
	});
	// An ally run has no business with pi-intercom: its own id is fresh and no header names it, so a message from it is dropped from the context as a backstop.
	pi.on("context", (event) => {
		if (mode !== "run" || claim?.kind !== "ally") return;
		const kept = event.messages.filter((m) => (m as { customType?: unknown }).customType !== INTERCOM_MESSAGE);
		return kept.length === event.messages.length ? undefined : { messages: kept };
	});
	pi.on("before_agent_start", (event) => {
		if (mode !== "run" || !claim) return;
		const sections = event.systemPromptOptions.sections;
		const head = /head tower: ([^\n;.]+)/.exec(claim.brief)?.[1]?.trim() ?? "none yet";
		const role = readFileSync(join(cfg.promptDir, claim.kind === "ally" ? "ally-run.md" : "tower-run.md"), "utf8").trim().replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ workspace: claim!.label, head })[key] ?? "none yet");
		sections[ENTRY] = `${role}\n\n${claim.brief}`;
	});
	/** A pane the server owns: this pi quits with the server's reason. */
	const quitPane = (context: ExtensionContext, reason?: string) => {
		mode = "run";
		markRun();
		ending = true;
		tell(`Straw Boss: ${reason ?? "this pane belongs to the sb server"}`, "warning");
		return void context.shutdown();
	};
	/** The session is a run (the claim is held): its tools, its file, and its poll. */
	const enterRun = async (context: ExtensionContext) => {
		mode = "run";
		markRun(claim?.kind); // balance.ts reads it at the quit
		keep();
		if (!pinPeer()) return void refuseUnpinned();
		registerTools();
		await call({ cmd: "run-file", file: context.sessionManager.getSessionFile() ?? "", session: context.sessionManager.getSessionId() }).catch(() => {});
		timer = setInterval(() => void tick(), pollMs);
		timer.unref();
		void tick();
	};
	/** The pane-role answer that came after the bound: acted on if this session is still the one that asked, else a claim it carries is released. */
	const decideLate = async (context: ExtensionContext, mine: number, found: Found | undefined) => {
		const waiting = deciding;
		if (mine !== epoch || mode !== "unknown") {
			if (found?.role === "hand" && found.claim) await ask({ cmd: "run-release", token: found.claim.token, reason: "the session ended before the server answered" }).catch(() => {});
			return;
		}
		deciding = undefined;
		if (!found) return void tell("Straw Boss: the sb server did not answer, so this session stays a plain session", "warning");
		if (found.role === "none") {
			mode = "normal";
			return void waiting?.forEach((start) => start());
		}
		if (found.role === "quit") return quitPane(context, found.reason);
		claim = found.claim;
		await enterRun(context);
	};
	pi.on("session_start", async (event, context) => {
		ctx = context;
		s.ui = context.ui; // the notices of a run (a refused claim, a lost server) reach the terminal
		epoch++;
		deciding = undefined;
		if (mode === "run") return; // a /reload of a run: the claim is kept
		const kept = (globalThis as Record<symbol, { claim?: Claim } | undefined>)[KEPT]?.claim;
		const flag = pi.getFlag("sb-run");
		try {
			// A hand run (no flag: the boss started pi in the standing pane) keeps its claim across /reload, /new, /resume and /fork: it is the same process in the same pane, and asking again would be told the pane is taken.
			if (kept && typeof flag === "string" && kept.run === flag && event.reason === "reload") claim = kept;
			else if (kept?.hand && !flag && event.reason !== "startup") claim = kept;
			else if (typeof flag === "string" && flag) claim = await claimRun(flag);
			else {
				const found = await paneRole(context, event.reason);
				if (found.role === "late") {
					deciding = [];
					const mine = epoch;
					return void found.settle.then((late) => decideLate(context, mine, late)).catch((cause: Error) => tell(`Straw Boss: ${cause.message}`, "error"));
				}
				if (found.role === "none") return void (mode = "normal");
				if (found.role === "quit") return quitPane(context, found.reason);
				claim = found.claim;
			}
		} catch (error) {
			mode = "run";
			markRun();
			ending = true;
			tell(`Straw Boss: this run cannot start: ${(error as Error).message}`, "error");
			return void context.shutdown();
		}
		await enterRun(context);
	});
	pi.on("session_shutdown", async (event) => {
		epoch++;
		deciding = undefined;
		clearInterval(timer);
		timer = undefined;
		if (mode !== "run" || !claim || ending) return;
		// /new, /resume, and /fork end the claim; a /reload keeps it, and a quit after tower_done or by the server's command is the server's own.
		if (event.reason === "reload" || (claim.hand && event.reason !== "quit")) return void (mode = "unknown");
		if (!closing && event.reason !== "quit") await ask({ cmd: "run-release", token: claim.token, reason: event.reason }).catch(() => {});
		// A quit that tower_done did not come before is the boss's /quit or the server's own order; the server knows which (a run it is ending ignores this) and ends a run the boss was in as done, not crashed.
		if (!closing && event.reason === "quit" && claim.kind === "local") await ask({ cmd: "run-done", token: claim.token, left: true }).catch(() => {});
		(globalThis as Record<symbol, unknown>)[KEPT] = undefined;
	});

	return {
		/** Whether this session is a run (or leaves as one): nothing of the net starts then. `unknown` before `session_start` has decided. */
		get mode() { return mode; },
		active: () => mode === "run",
		/** Whether the pane-role answer is still awaited: the session start (session.ts) waits for it (`afterNormal`). */
		get deciding() { return deciding !== undefined; },
		/** Runs `start` once the late answer makes this a normal session; never when it becomes a run or stays plain. */
		afterNormal: (start: () => void) => void deciding?.push(start),
	};
}
export type RunMode = ReturnType<typeof createRunMode>;
