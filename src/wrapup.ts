import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoardFill } from "./boardfill.ts";
import { panes } from "./herdr.ts";
import type { Ask } from "./host.ts";
import { todosOf } from "./items.ts";
import { subagents } from "./netdata.ts";
import type { Reach } from "./reach.ts";
import { armedLoop } from "./server/capops.ts";
import type { Kit } from "./state.ts";
import { snapshotOfBranch } from "./todo.ts";

// Idle wrap-up (docs/specs/2026-11-25-idle-wrap-up.md, part 1; boss 2026-11-25): a coordinator or integrator main idle 30 minutes is asked once whether its work is done, and `boss_wrap` asks the boss in
// this pane before it reports, clears the board, and closes the session as /boss close does. The clock is the session's own: it sees each turn start and end, so the turn the nudge starts is not counted as
// new work (the server's minute look could not tell them apart). No nudge and no wrap-up while auto mode is on: the boss is away, and the clock starts again when he is back.

export const IDLE_MS = 30 * 60_000;
const LOOK_MS = 60_000, SUMMARY_MAX = 800;
export const WRAP_MESSAGE = "straw-boss-wrap";
export const NUDGE_TEXT = "sb: you have been idle 30 minutes. Is your work done? If work remains: dispatch your ready todos now; none ready, take your next eligible work; or clean up stale todos. If you wait on someone other than the boss, set that todo's `metadata.waitsOn` (who) and stop. If it is done: answer the intercom asks you owe, remove the worktrees you made, complete or delete every todo, stop your monitors and loops, write a daily memory entry if you have a memory tool, then call boss_wrap with a summary: it asks the boss before this pane closes.";
export const WRAP_DESCRIPTION = "Main only, when your work is done: asks the boss here whether to wrap up; on yes it sends your summary to the tower as a milestone (and to whoever a tower opened you for), clears your board, and closes this session and its pane. Refused with an open todo, a running monitor, loop, watch, or subagent, under auto mode, for a standing main, and in a teammate's turn.";

/** The idle clock of one main: when its last turn settled, and whether this idle period had its nudge (or the boss's no). */
export function idleClock(now: () => number, idleMs = IDLE_MS) {
	let since: number | undefined = now(), busy = false, nudged = false, nudgeTurn = false;
	return {
		/** A turn starts: one the nudge did not start is new work, and opens a new idle period. */
		start() {
			busy = true;
			if (nudgeTurn) nudgeTurn = false;
			else nudged = false;
		},
		/** The turn and its follow-ups ended: idle from now. */
		settle() { busy = false; since = now(); },
		/** Whether a nudge is due. `away` (auto mode) stops the clock; it starts again when the boss is back. */
		due(away: boolean): boolean {
			if (away) return (since = undefined), false;
			if (busy) return false;
			since ??= now();
			return !nudged && now() - since >= idleMs;
		},
		/** The nudge went out: the turn it starts is its own, not new work. */
		sent() { nudged = true; nudgeTurn = true; },
		/** The boss said not yet: no nudge until the main has worked again. */
		hold() { nudged = true; },
	};
}

export interface WrapDeps {
	reach: Pick<Reach, "callTower" | "send">;
	boardFill: Pick<BoardFill, "clear">;
	closeSelf(keepPane: boolean): string | undefined;
	/** What a stop would lose that an abort does not end (bridge.ts): an open dialog, a running monitor. */
	blockers(): string | undefined;
	duty(): string;
	remote(): boolean;
	ask?: Ask;
	/** pi-loop-monitor's folder (`~/.pi/loops`). */
	loopsDir?: string;
}

export function createWrapUp({ pi, cfg, s, me, role }: Kit, d: WrapDeps) {
	const clock = idleClock(cfg.now);
	let ctx: ExtensionContext | undefined, stop: (() => void) | undefined, looking = false;
	const name = () => pi.getSessionName() || s.ownName || me().slice(0, 8);
	const kindOk = () => d.duty() === "coordinator" || d.duty() === "integrator";
	/** What still runs for this session: a dialog or monitor, a loop, a boss_watch, a subagent, and (for the nudge) a pane Herdr shows blocked. */
	const running = async (pane: boolean): Promise<string[]> => {
		const why: string[] = [];
		const b = d.blockers();
		if (b) why.push(b);
		if (armedLoop(d.loopsDir ?? join(homedir(), ".pi", "loops"), me(), cfg.now())) why.push("a loop is active");
		const watches = await d.ask?.({ cmd: "watch-list", session: me() }, { start: "never" }).catch(() => undefined);
		if (watches?.ok && Array.isArray(watches.watches) && watches.watches.length) why.push(`${watches.watches.length} boss_watch watch${watches.watches.length > 1 ? "es run" : " runs"} (boss_watch stop ends one)`);
		const all = await panes(cfg.run).catch(() => undefined), mine = all?.find((p) => p.pane_id === s.at?.paneId);
		const kids = all ? subagents(mine, all, cfg.now()).filter((r) => !r.ended).length : 0;
		if (kids) why.push(`${kids} subagent${kids > 1 ? "s are" : " is"} running`);
		if (pane && mine?.agent_status === "blocked") why.push("this pane waits on a dialog");
		return why;
	};
	const look = async () => {
		if (looking || !ctx) return;
		looking = true;
		try {
			if (role() !== "main" || s.isTrain || s.closing || !kindOk() || s.openedBy?.startsWith("link:")) return;
			if (!clock.due(s.autoOn()) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			if ((await running(true)).length || !ctx.isIdle()) return;
			clock.sent();
			pi.sendMessage({ customType: WRAP_MESSAGE, content: NUDGE_TEXT, display: true }, { triggerTurn: true });
		} catch { /* the next look tries again */ } finally {
			looking = false;
		}
	};
	pi.on("session_start", (_e, c) => {
		ctx = c;
		stop?.();
		stop = (cfg.idleLook ?? ((fn) => ((t) => (t.unref?.(), () => clearInterval(t)))(setInterval(() => void fn(), LOOK_MS))))(look);
	});
	pi.on("session_shutdown", () => void (stop?.(), (stop = undefined)));
	pi.on("agent_start", (_e, c) => void ((ctx = c), clock.start()));
	pi.on("agent_settled", (_e, c) => void ((ctx = c), clock.settle()));

	return {
		look,
		/** `boss_wrap`, with the net tools of a joined session that is no tower. */
		addTool() {
			pi.registerTool({
				name: "boss_wrap", label: "boss_wrap", description: WRAP_DESCRIPTION,
				parameters: Type.Object({ summary: Type.String({ description: `What this session finished: one paragraph, at most ${SUMMARY_MAX} characters.` }) }),
				execute: async (_id, { summary }, _signal, _update, c) => {
					if (s.isTower || role() === "tower") throw new Error("A tower does not wrap up: it ends with its runs");
					if (role() === "train") throw new Error("A train does not wrap up: it ends with its milestone report and the tower closes it");
					if (role() !== "main") throw new Error("Only a tab's main agent wraps up; a member's work ends with its main's");
					if (s.remoteOrigin || d.remote()) throw new Error("A teammate's turn cannot wrap up this main");
					if (d.duty() === "standing") throw new Error("A standing main has no end: only the boss closes it (/boss close)");
					if (s.openedBy?.startsWith("link:")) throw new Error(`A main opened for a teammate's device (${s.openedBy.slice(0, 40)}) is closed by that device's stop or the tower, not by boss_wrap`);
					const text = summary.replace(/\s+/g, " ").trim();
					if (!text || text.length > SUMMARY_MAX) throw new Error(`summary is required: one paragraph of 1 to ${SUMMARY_MAX} characters`);
					if (s.autoOn()) throw new Error("auto mode: the boss is away; wrap up when he is back");
					if (!c.hasUI) throw new Error("This session has no terminal to ask the boss in");
					// What would be lost by closing: asked before the boss is, and again after his yes, since the dialog may stand for hours (a message queued, a monitor a parallel call started; RV-F001).
					const notReady = async () => {
						const open = (todosOf(snapshotOfBranch(s.branch())) ?? []).filter((t) => t.status !== "completed");
						return [...(open.length ? [`open todos ${open.map((t) => `#${t.id}`).join(", ")}: complete or delete each (a task you reported blocked to its owner: delete it)`] : []), ...(c.hasPendingMessages() ? ["messages wait in your queue: read them first"] : []), ...(await running(false))];
					};
					const why = await notReady();
					if (why.length) throw new Error(`Not ready to wrap up: ${why.join("; ")}.`);
					const yes = await c.ui.confirm(`Wrap up ${name()}?`, text);
					if (s.autoOn()) return reply("Auto mode started while the boss was asked: nothing closed. Wrap up when he is back.", { wrapped: false, auto: true });
					if (!yes) return (clock.hold(), reply("The boss said not now: nothing closed. Keep this session open and do nothing more about wrapping up; sb does not ask again until you have worked again.", { wrapped: false }));
					const since = await notReady();
					if (since.length) return reply(`The boss said yes, but while he was asked: ${since.join("; ")}. Nothing closed and nothing was sent: handle them, then call boss_wrap again.`, { wrapped: false });
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
				},
			});
		},
	};
}
const reply = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
export type WrapUp = ReturnType<typeof createWrapUp>;
