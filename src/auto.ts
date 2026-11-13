import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTO_FILE, type AutoState, autoOnForTrust, readAuto } from "./autostate.ts";
import { underBoss } from "./autoscope.ts";
import { type AgentKind, CALL_TOWER_LINE, cancelledText, offNotice, onNotice, refusedText, SHOW_DOC_LINE, typedHint } from "./autotext.ts";
import type { Bridge, Ended } from "./bridge.ts";
import type { Declined } from "./declined.ts";
import type { Ask } from "./host.ts";
import type { Kit } from "./state.ts";
import { secretShaped } from "./server/waitcard.ts";

// The session's part of auto mode (docs/specs/2026-11-09-auto-mode.md, §3 and §4): it follows `auto.json`, refuses every call that would wait for the boss, answers a dialog opened inside a tool call as Escape, and tells the
// agent why in words the code writes. It is registered before the child return, so it holds in mains, members, trains, subagents, and the standing panes' hand runs. The state changes only through the server (automode.ts):
// this module reads the file, and acts on a change only after the server says the write is its own (§1, task 3).

/** The tools whose call waits for the boss: pi-code's `question` (drawn with ui.custom), rpiv's ask_user_question, pi-robot-hand's two, and Straw Link's approval. */
const WAITING = new Set(["ask_user_question", "question", "robot_hand", "secret_drop", "link_request"]);
/** pi-mcp-adapter's `mcp` waits for a browser login only for these actions. */
const MCP_LOGIN = new Set(["auth-start", "auth-complete"]);
const POLL_MS = 2000;
const waits = (tool: string, input: unknown) => WAITING.has(tool) || (tool === "mcp" && typeof input === "object" && input !== null && MCP_LOGIN.has(String((input as { action?: unknown }).action)));
const GIST_MAX = 120;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** A gist of what was asked, at most 120 characters, withheld when it looks like a secret (§5): a question's header, a command's first line, a secret's label. Never an answer. */
export function gistOf(tool: string, input: unknown): string {
	const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const first = Array.isArray(i.questions) ? (i.questions[0] as Record<string, unknown> | undefined) : undefined;
	const raw = tool === "ask_user_question" || tool === "question" ? text(first?.header) || text(first?.question) || text(i.question) : text(i.label) || text(i.command) || text(i.message) || text(i.title) || text(i.action);
	const line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, GIST_MAX);
	return line && secretShaped(line) ? "(withheld)" : line;
}
export interface Note { tool: string; kind: "refused" | "cancelled" | "escaped" | "trust"; gist: string }

export type Auto = ReturnType<typeof createAuto>;
export interface AutoDeps {
	ask?: Ask;
	running?: () => boolean;
	/** The session's bridge: it ends the open waits at the transition (bridge.ts `cancelWaits`) and aborts the turn when one cannot be ended. */
	bridge?: Pick<Bridge, "cancelWaits" | "turn">;
	/** Esc before a decline (declined.ts): a cancel sb made is never the boss's. */
	declined?: Declined;
	/** An ally run is told nothing of auto mode (D5). */
	silent?: () => boolean;
}
export function createAuto({ pi, cfg, s, guiDir, me }: Kit, d: AutoDeps = {}) {
	let key = "", current: AutoState | undefined, warned = false, hinted = false;
	let ctx: ExtensionContext | undefined, timer: ReturnType<typeof setInterval> | undefined, confirmedRev = -1, lastOn: boolean | undefined, checking = false;
	let tracker: { unrelayed(): number } | undefined, queued: string[] | undefined;
	/** Calls auto mode cancelled: their result is replaced by id, and the Esc rule leaves them alone. */
	const cancelledIds = new Map<string, string>(), bossDialogs = new Set<string>();
	let running = d.running ?? (() => false);
	/** Calls whose dialog was answered as Escape without drawing: their result gains the refusal. */
	const escaped = new Map<string, string>();
	/** Reads the file again when it moved (a stat, then a read). An unreadable file keeps the last good state the session read (§1). */
	const refresh = () => {
		try {
			const stat = statSync(join(guiDir, AUTO_FILE), { throwIfNoEntry: false }), next = stat ? `${stat.mtimeMs}:${stat.size}` : "none";
			if (next === key) return;
			key = next;
			if (!stat) return void (current = undefined);
			const seen = readAuto(guiDir);
			if (seen.kind === "ok") current = seen.state;
			else if (!warned) (warned = true, s.ui?.notify("Straw Boss: auto.json is unreadable; auto mode stays as this session last read it", "warning"));
		} catch { /* a stat that fails keeps what was read */ }
	};
	const on = () => (refresh(), current?.on === true);
	const kind = (): AgentKind => (cfg.env.PI_SUBAGENT_ID ? "subagent" : running() ? "run" : s.isTrain ? "train" : "main");
	/** Tells the server what auto mode refused or cancelled here, for the return list; a note that fails is dropped. */
	const note = (n: Note) => void d.ask?.({ cmd: "auto-note", session: me(), at: new Date(cfg.now()).toISOString(), ...n }, { start: "never" }).catch(() => undefined);

	pi.on("tool_call", (event) => {
		try {
			if (!on() || !waits(event.toolName, event.input)) return;
			note({ tool: event.toolName, kind: "refused", gist: gistOf(event.toolName, event.input) });
			return { block: true, reason: refusedText(current?.since, event.toolName, kind()) };
		} catch {
			// A guard that throws refuses the call while auto mode is on, and lets it be while it is off (pi blocks a call whose hook throws).
			return current?.on ? { block: true, reason: refusedText(current.since, event.toolName, kind()) } : undefined;
		}
	});
	pi.on("tool_result", (event) => {
		// A call sb cancelled never reads as the boss's Esc: the result is replaced, by the call's id.
		const cancelledTool = cancelledIds.get(event.toolCallId);
		if (cancelledTool !== undefined) return (cancelledIds.delete(event.toolCallId), { content: [{ type: "text" as const, text: cancelledText(current?.since, cancelledTool, kind()) }] });
		const dialog = escaped.get(event.toolCallId);
		escaped.delete(event.toolCallId);
		let line: string | undefined;
		if (dialog) line = refusedText(current?.since, dialog, kind());
		else if (on() && event.toolName === "show_doc") line = SHOW_DOC_LINE;
		else if (on() && event.toolName === "call_tower" && (event.input as { why?: unknown } | undefined)?.why === "blocked") line = CALL_TOWER_LINE;
		return line ? { content: [...event.content, { type: "text" as const, text: line }] } : undefined;
	});
	// The boss's first typed input while auto mode is on: how to end it (D2), once per session.
	pi.on("input", (event, ctx) => {
		if (hinted || event.source !== "interactive" || !on()) return;
		hinted = true;
		if (ctx.hasUI) ctx.ui.notify(typedHint(current?.since), "info");
	});

	// --- the transition (§1, §5) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const idle = () => { try { return ctx?.isIdle() !== false; } catch { return true; } };
	const send = (text: string, trigger: boolean) => void pi.sendMessage({ customType: "straw-auto", content: text, display: true }, trigger ? { triggerTurn: true } : { deliverAs: idle() ? "nextTurn" : "steer" });
	const tell = (text: string) => { if (!d.silent?.()) send(text, false); };
	/** What the wait was about, for the return list: a question's header, a command's first line, a secret's label; a secret-shaped gist is withheld. */
	const gistOfDialog = (e: Ended): string => {
		const dlg = e.dialog, raw = dlg.questions?.[0]?.header ?? dlg.questions?.[0]?.question ?? dlg.secret?.label ?? dlg.select?.title ?? "";
		const line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, GIST_MAX);
		return line && secretShaped(line) ? "(withheld)" : line;
	};
	/** A confirmed `on`: the open waits end (an owner that takes a cancel gets it; for the rest the turn is aborted), each with sb's text; a first `on` also tells the session once. */
	function cancelOpen(st: AutoState, first: boolean) {
		const unrelayed = tracker?.unrelayed() ?? 0, ended = d.bridge?.cancelWaits?.((dlg) => bossDialogs.has(dlg.id)) ?? { cancelled: [], stuck: [] };
		for (const e of [...ended.cancelled, ...ended.stuck]) {
			if (e.toolCallId) (cancelledIds.set(e.toolCallId, e.tool), d.declined?.sbCancelled(e.toolCallId));
			note({ tool: e.tool, kind: "cancelled", gist: gistOfDialog(e) });
		}
		const texts = [...new Set([...ended.cancelled, ...ended.stuck].map((e) => cancelledText(st.since, e.tool, kind())))];
		if (first && !d.silent?.()) texts.push(onNotice(st.since));
		// An owner that took the cancel closes the ui.custom it drew (rpiv, robot_hand 0.8.0), which the wrap counts as a dialog nobody relays: those do not need the turn aborted (AMC-F001).
		const open = Math.max(0, unrelayed - ended.cancelled.length);
		if (!ended.stuck.length && !open) return void (texts.length && tell(texts.join("\n")));
		// A wait that cannot be ended (secret_drop and a robot_hand before 0.8.0 take no cancel, nor does a dialog nobody relays) goes with the turn: abort it, and once pi has settled, a message starts the next turn with sb's text (AM-F004).
		if (d.bridge?.turn?.running()) (queued = texts.length ? texts : [cancelledText(st.since, "dialog", kind())], d.bridge.turn.abort());
		else if (texts.length) send(texts.join("\n"), true);
	}
	/** Asks the server whether the file's write is its own; acts once per confirmed rev. A server that does not answer is waited for (the next poll). */
	async function poll() {
		if (checking) return;
		checking = true;
		try {
			refresh();
			const st = current;
			if (!st || st.rev === confirmedRev) return;
			const answer = await d.ask?.({ cmd: "auto-check", rev: st.rev, hash: st.hash }, { start: "never" });
			if (!answer?.ok || answer.own !== true || current?.rev !== st.rev) return;
			confirmedRev = st.rev;
			const was = lastOn;
			lastOn = st.on;
			if (st.on) cancelOpen(st, was !== true);
			else if (was === true) tell(offNotice(new Date(cfg.now()).toISOString()));
		} catch { /* the next poll tries again */ } finally {
			checking = false;
		}
	}
	/** Registered by the entry point after the train signs (their session_start handler must come first, index.ts). */
	function attach() {
		pi.on("session_start", (_event, context) => {
			ctx = context;
			refresh();
			clearInterval(timer);
			timer = setInterval(() => void poll(), cfg.adoptMs || POLL_MS);
			timer.unref?.();
			void poll();
		});
		pi.on("session_shutdown", () => (clearInterval(timer), (timer = undefined)));
		pi.on("agent_settled", () => {
			const texts = queued;
			queued = undefined;
			if (texts) send(texts.join("\n"), true);
		});
	}

	return {
		attach, poll, track: (t: { unrelayed(): number }) => void (tracker = t), boss: (id: string) => void (bossDialogs.add(id), bossDialogs.size > 64 && bossDialogs.delete(bossDialogs.values().next().value as string)),
		on, since: () => current?.since, kind, refresh, note,
		state: () => current,
		/** For the entry point: the session is a tower run when this says so. */
		running: (fn: () => boolean) => void (running = fn),
		/** The wrap of ctx.ui asks, for a dialog opened now: whether it is answered as Escape without drawing (inside a tool call, outside the boss's own commands). The calls in flight are marked, so their results say why. */
		escape(flying: ReadonlyMap<string, string>): boolean {
			if (!on() || !flying.size || underBoss()) return false;
			for (const [id, tool] of flying) escaped.set(id, `a dialog inside ${tool}`);
			note({ tool: [...flying.values()][0]!, kind: "escaped", gist: "" });
			return true;
		},
		/** The trust question reads the files itself (pi asks it before any session starts; AM-F010, AM2-F009). */
		trust: { on: () => autoOnForTrust(guiDir), note: (gist: string) => note({ tool: "trust", kind: "trust", gist }) },
	};
}
