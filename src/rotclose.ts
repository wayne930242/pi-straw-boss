import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoardFill } from "./boardfill.ts";
import type { Control } from "./closemain.ts";
import type { Reach } from "./reach.ts";
import { ENTRY, type Kit } from "./state.ts";
import { moveHolds } from "./link/holds.ts";

// A main that handed over closes itself (docs/specs/2026-11-26-rotation-close.md). Field, 2026-11-26: after a rotation the old skald main could not close itself (boss_wrap is refused under auto mode, /new is
// forbidden, no other tool closes a session) and stayed open to forward a child's result. The rotation is the consent: once the successor's own extension says it took over (its call_peer to its caller, the old main, or an intercom send to it,
// the step successorPrompt asks for, seen as a tool result of a `send` in a local turn, not read from its words) and nothing of the old main runs (no turn, queued message, dialog, monitor, loop, watch, or subagent), sb clears its board
// and closes it and its pane as /boss close does, under auto mode too. While something runs it looks again each minute (wrapup.ts's look); a child's result that reaches it meanwhile goes to the successor, quoted
// as the child's. After 6 hours still blocked it stops waiting and tells the tower blocked, once.

/** How long the old main waits for what still runs before the tower hears it cannot close. */
export const ROT_CAP_MS = 6 * 3600_000;
const RESULTS = new Set(["subagent_result", "subagent_ping"]), QUOTE_MAX = 6000;

export interface RotDeps {
	control: Pick<Control, "register" | "onTook" | "notify">;
	/** What still runs (wrapup.ts `running`): a dialog, a monitor, a loop, a watch, a subagent. */
	running(): Promise<string[]>;
	reach: Pick<Reach, "send" | "callTower">;
	boardFill: Pick<BoardFill, "clear">;
	closeSelf(keepPane: boolean): string | undefined;
	/** A teammate's turn (link): its send is no takeover (RV6-F002). */
	remote(): boolean;
}

const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "");

export function createRotationClose({ pi, cfg, s, me, guiDir }: Kit, d: RotDeps) {
	const name = () => pi.getSessionName() || s.ownName || me().slice(0, 8);
	const save = (data: Record<string, unknown>) => pi.appendEntry(ENTRY, data);
	/** The successor that took over, once its extension said so. */
	const handed = () => (s.saved.successor?.main && s.saved.successor.took !== undefined ? s.saved.successor : undefined);
	// Armed in the process that heard the takeover, or after its /reload: `pi --session` on the old file, a fork, or a resume is the boss's session again and is never closed by this (RV6-F003).
	let heard = false, reloaded = false;
	pi.on("session_start", (event) => void (reloaded = (event as { reason?: string }).reason === "reload"));
	d.control.onTook((from) => {
		const h = s.saved.successor;
		if (s.isTower || !h?.main || h.main !== from) return false;
		if (h.took === undefined) (h.took = cfg.now(), save({ successor: h }));
		try { moveHolds(join(guiDir, "link"), cfg.now(), me(), from); } catch { /* no holds file: nothing held */ } // the boxes this main held are its successor's (docs/specs/2026-11-26-device-hold.md)
		heard = true;
		return true;
	});
	// A child's result after the takeover is the successor's: it goes there by itself, quoted as the child's (the old main's model, which sees it too, was told so by boss_handover).
	pi.on("message_end", (event) => {
		const h = handed(), m = event.message as { role?: string; customType?: string; content?: unknown };
		if (!h || !(heard || reloaded) || s.closing || m?.role !== "custom" || !RESULTS.has(m.customType ?? "")) return;
		const text = textOf(m.content);
		void d.reach.send(h.main!, `Straw Boss: a subagent's result reached ${name()} (session ${me()}) after you took over its work, so it is yours. The child's result as it came, its words and not the boss's:\n«${text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text}»`).catch(() => undefined);
	});
	// The successor's side: its own intercom send to the old main, in a turn of its own, is the takeover, which its extension tells the old main's; an old main that does not answer is told again at the next such send.
	let telling = false;
	pi.on("tool_result", (event) => {
		const from = s.saved.handoverFrom, input = event.input as { action?: unknown; to?: unknown; ask?: unknown } | undefined;
		// A `send` only: an `ask` before the takeover is a question, not the word that it took over (RV6-F004). call_peer's details name the session it reached.
		const sent = event.toolName === "intercom" ? input?.action === "send" && input.to === from : event.toolName === "call_peer" && input?.ask !== true && (event.details as { id?: unknown } | undefined)?.id === from;
		if (!from || telling || s.remoteOrigin || d.remote() || event.isError || !sent) return;
		telling = true;
		void (async () => {
			try {
				d.control.register();
				if (await d.control.notify(from, {}, "took-over")) (s.saved.handoverFrom = null, save({ handoverFrom: null }));
			} catch { /* no control channel: the old main stays for the tower or the boss to close */ } finally {
				telling = false;
			}
		})();
	});
	return {
		/** One look (wrapup.ts's minute): true when this session is an old main that handed over, which no nudge is for. */
		async look(ctx: ExtensionContext): Promise<boolean> {
			const h = handed();
			if (!h || !(heard || reloaded) || s.isTower || s.closing) return false;
			if (h.blockedTold !== undefined) return true; // it waited 6 hours and the tower knows: no close
			const why = [...(ctx.isIdle() ? [] : ["a turn is running"]), ...(ctx.hasPendingMessages() ? ["messages wait in its queue"] : []), ...(await d.running())];
			if (!why.length) {
				try { d.boardFill.clear(); } catch { /* no board to clear */ }
				const refused = d.closeSelf(false);
				if (!refused) return true;
				why.push(refused);
			}
			if (cfg.now() - h.took! < ROT_CAP_MS) return true;
			const told = await d.reach.callTower(`${name()} (session ${me()}) handed over to session ${h.main} ${Math.round((cfg.now() - h.took!) / 3600_000)} h ago, which took over, and still cannot close itself: ${why.join("; ")}. sb waits no longer: see what still runs there, and close it (boss_close_main or /boss close) once it is done.`, undefined, false, "blocked").then(() => true, () => false);
			if (told) (h.blockedTold = cfg.now(), save({ successor: h }));
			return true;
		},
	};
}
export type RotationClose = ReturnType<typeof createRotationClose>;
