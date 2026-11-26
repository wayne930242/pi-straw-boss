import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoardFill } from "./boardfill.ts";
import { armWake, idleClock as clockOf, idleWake, idleWakes } from "./idlewake.ts";
import { todosOf } from "./items.ts";
import { heldHere } from "./hold.ts";
import { HELD_NUDGE, NUDGE_TEXT, WORKER_NUDGE, WRAP_DESCRIPTION } from "./moments.ts";
import type { Reach } from "./reach.ts";
import { noteLedger } from "./server/ledger.ts";
import type { Kit } from "./state.ts";
import { createProbe, type ProbeDeps } from "./stillruns.ts";
import { snapshotOfBranch } from "./todo.ts";

// Idle wrap-up (docs/specs/2026-11-25-idle-wrap-up.md, part 1; boss 2026-11-25): a coordinator or integrator main idle 30 minutes is asked once whether its work is done (the nudge, an idle wake of idlewake.ts),
// and `boss_wrap` asks the boss in this pane before it reports, clears the board, and closes the session as /boss close does. No nudge and no wrap-up while auto mode is on: the boss is away.
// A standing main has no end, so no nudge and no boss_wrap: its own wake (idlewake.ts `armWake`) tells it to re-arm what it minds. Each call is a `wrap` event of the ledger (server/ledger.ts): wrapped, auto, or refused.

export const IDLE_MS = 30 * 60_000, WORKER_IDLE_MS = 15 * 60_000, SUMMARY_MAX = 800, WRAP_MESSAGE = "straw-boss-wrap";

/** The nudge's idle clock (idlewake.ts). */
export const idleClock = (now: () => number, idleMs = IDLE_MS) => clockOf(now, idleMs);

export interface WrapDeps extends ProbeDeps {
	reach: Pick<Reach, "callTower" | "send">;
	boardFill: Pick<BoardFill, "clear">;
	closeSelf(keepPane: boolean): string | undefined;
	duty(): string;
	remote(): boolean;
	/** Looked at first each minute (rotclose.ts): true when this session is an old main that handed over, which gets no nudge. */
	first?(ctx: ExtensionContext): Promise<boolean>;
}

export function createWrapUp(kit: Kit, d: WrapDeps) {
	const { pi, cfg, s, me, role, guiDir } = kit, name = () => pi.getSessionName() || s.ownName || me().slice(0, 8), held = () => heldHere(guiDir, cfg.now()) !== undefined; // a held box words the nudge and the wake apart (docs/specs/2026-11-26-device-hold.md)
	const note = (why: string) => noteLedger(guiDir, { kind: "wrap", id: me(), session: me(), workspace: s.at?.workspaceId, why }, cfg.now(), (text) => kit.tell(text, "warning"));
	const noted = <T extends { details: unknown }>(how: Promise<T>) => how.then((r) => { const o = r.details as { wrapped?: boolean; auto?: boolean }; note(o.wrapped ? "wrapped" : o.auto ? "auto" : "refused"); return r; }, (error: unknown) => { note(s.autoOn() ? "auto" : "refused"); throw error; });
	const probe = createProbe({ cfg, s, me }, d); // what still runs for this session (stillruns.ts)
	const nudge = idleWake(cfg.now, { idleMs: IDLE_MS, eligible: () => d.duty() === "coordinator" || d.duty() === "integrator", ready: async () => !(await probe.nudge()).length, customType: WRAP_MESSAGE, text: () => (held() ? HELD_NUDGE : NUDGE_TEXT), underAuto: false });
	const worker = idleWake(cfg.now, { idleMs: WORKER_IDLE_MS, eligible: () => d.duty() === "worker", ready: async () => !(await probe.strict()).length, customType: WRAP_MESSAGE, text: WORKER_NUDGE, underAuto: true, forLink: true });
	const look = idleWakes(kit, [nudge, armWake(cfg.now, d.duty, probe, held), worker], d.first);

	type Ctx = Pick<ExtensionContext, "hasUI" | "hasPendingMessages">;
	/** Why this call may not wrap up at all, in the order the checks run; `text` is the summary as one line. */
	const refusal = (text: string, c: Ctx): string | undefined => {
		if (s.isTower || role() === "tower") return "A tower does not wrap up: it ends with its runs";
		if (role() === "train") return "A train does not wrap up: it ends with its milestone report and the tower closes it";
		if (role() !== "main") return "Only a tab's main agent wraps up; a member's work ends with its main's";
		if (s.remoteOrigin || d.remote()) return "A teammate's turn cannot wrap up this main";
		if (d.duty() === "standing") return "A standing main has no end: only the boss closes it (/boss close)";
		if (d.duty() === "worker") return "A worker ends with its one call_tower why: milestone, its final report: the tower closes it then";
		if (s.openedBy?.startsWith("link:")) return `A main opened for a teammate's device (${s.openedBy.slice(0, 40)}) is closed by that device's stop or the tower, not by boss_wrap`;
		if (!text || text.length > SUMMARY_MAX) return `summary is required: one paragraph of 1 to ${SUMMARY_MAX} characters`;
		if (s.autoOn()) return "auto mode: the boss is away; wrap up when he is back";
		if (!c.hasUI) return "This session has no terminal to ask the boss in";
	};
	/** What would be lost by closing: asked before the boss is, and again after his yes, since the dialog may stand for hours (a message queued, a monitor a parallel call started; RV-F001). */
	const notReady = async (c: Ctx) => {
		const open = (todosOf(snapshotOfBranch(s.branch())) ?? []).filter((t) => t.status !== "completed");
		return [...(open.length ? [`open todos ${open.map((t) => `#${t.id}`).join(", ")}: complete or delete each (a task you reported blocked to its owner: delete it)`] : []), ...(c.hasPendingMessages() ? ["messages wait in your queue: read them first"] : []), ...(await probe.wrap())];
	};
	/** The boss said yes and nothing runs: the milestone, the opener, the board, the close. */
	const finish = async (text: string) => {
		const line = `${name()} (session ${me()}) wrapped up, the boss agreeing: ${text}`;
		try { await d.reach.callTower(line, undefined, false, "milestone"); } catch (error) {
			return reply(`The tower did not take the wrap-up milestone (${(error as Error).message}): nothing closed. Try boss_wrap again later; the boss is asked again.`, { wrapped: false });
		}
		const opener = s.openedBy && !s.openedBy.includes(":") ? s.openedBy : undefined;
		const told = opener ? (await d.reach.send(opener, line).catch(() => ({ status: "failed" }))).status === "sent" : undefined;
		try { d.boardFill.clear(); } catch { /* no board to clear */ }
		const refused = d.closeSelf(false);
		if (refused) return reply(`Told the tower and cleared the board, but the session did not close: ${refused}`, { wrapped: false });
		return reply(`Wrapped up: the tower has your summary${opener ? (told ? ", and so does the session that asked for this main" : `; the session that asked for this main (${opener}) did not take it`) : ""}, and your board is cleared. This session quits when this turn ends and its pane closes: end your turn now.`, { wrapped: true });
	};

	return {
		look,
		/** What still runs for this session: a dialog, monitor, loop, watch, or subagent, or a pane Herdr shows blocked; a read that fails counts as running. */
		running: probe.strict,
		/** `boss_wrap`, with the net tools of a joined session that is no tower. */
		addTool() {
			pi.registerTool({
				name: "boss_wrap", label: "boss_wrap", description: WRAP_DESCRIPTION,
				parameters: Type.Object({ summary: Type.String({ description: `What this session finished: one paragraph, at most ${SUMMARY_MAX} characters.` }) }),
				execute: (_id, { summary }, _signal, _update, c) => noted((async () => {
					const text = summary.replace(/\s+/g, " ").trim(), refused = refusal(text, c);
					if (refused) throw new Error(refused);
					const why = await notReady(c);
					if (why.length) throw new Error(`Not ready to wrap up: ${why.join("; ")}.`);
					const yes = await c.ui.confirm(`Wrap up ${name()}?`, text);
					if (s.autoOn()) return reply("Auto mode started while the boss was asked: nothing closed. Wrap up when he is back.", { wrapped: false, auto: true });
					if (!yes) return (nudge.clock.hold(), reply("The boss said not now: nothing closed. Keep this session open and do nothing more about wrapping up; sb does not ask again until you have worked again.", { wrapped: false }));
					const since = await notReady(c);
					if (since.length) return reply(`The boss said yes, but while he was asked: ${since.join("; ")}. Nothing closed and nothing was sent: handle them, then call boss_wrap again.`, { wrapped: false });
					return finish(text);
				})()),
			});
		},
	};
}
const reply = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
export type WrapUp = ReturnType<typeof createWrapUp>;
