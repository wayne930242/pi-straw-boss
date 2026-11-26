import type { CarState } from "./train/cars.ts";

// The texts sb sends at one moment, so prompts/main.md need not carry them (docs/specs/2026-11-26-just-in-time-prompts.md; boss 2026-11-25 「提示詞可以逐步交付」): strings and tiny formatters only;
// the code that chooses one stays where the moment happens. Each names its moment and who reads it. Imports nothing at run time, so the sb server (src/server/) takes its own from here too.

/** The idle nudge (idlewake.ts, wired in wrapup.ts): a coordinator or integrator main idle 30 minutes with nothing running. */
export const NUDGE_TEXT = "sb: you have been idle 30 minutes. Is your work done? If work remains: dispatch your ready todos now; none ready, take your next eligible work; or clean up stale todos. If you wait on someone other than the boss, set that todo's `metadata.waitsOn` (who) and stop. If it is done: answer the intercom asks you owe, remove the worktrees you made, complete or delete every todo, stop your monitors and loops, write a daily memory entry if you have a memory tool, then call boss_wrap with a summary: it asks the boss before this pane closes.";
/** The worker's nudge (wrapup.ts): a worker opened for a teammate's device, idle 15 minutes with nothing running and no final report (docs/specs/2026-11-26-ally-workers.md). */
export const WORKER_NUDGE = "sb: you have been idle 15 minutes. Finish the brief now, or send your final report with call_tower why: milestone (blocked or done): it is your only one, and the tab closes after it. At 60 minutes idle without it the box stops you and keeps your worktree.";
/** `boss_wrap`'s description (wrapup.ts): every main that has the tool, on every turn. */
export const WRAP_DESCRIPTION = "Main only, when your work is done: asks the boss here whether to wrap up; on yes it sends your summary to the tower as a milestone (and to whoever a tower opened you for), clears your board, and closes this session and its pane. Refused with an open todo, a running monitor, loop, watch, or subagent, under auto mode, for a standing main, and in a teammate's turn.";
/** The standing main's wake (idlewake.ts `armWake`): a standing main idle 2 hours with nothing armed. */
export const ARM_TEXT = "sb: you have nothing armed (no watch, monitor, or loop). Re-arm what you mind from your handoff or board, or say on your board why nothing needs watching.";
/** A standing main's lines in every text that brings it back (revive.ts: a revive, a handover; session.ts: a Herdr restart that resumed it): it minds by what it arms, and nothing it armed survived
 *  (docs/specs/2026-11-26-standing-prompt.md). The second line holds until pi-loop-monitor stops sending a done-wake for a monitor or loop a restart retired. */
export const REARM_TEXT = "Re-arm your watches, monitors, and loops from your handoff or board: a restart retires them. A retired monitor or loop is not finished: check its own end condition before acting on a done-wake.";
/** `call_tower` `boss` under auto mode (bossask.ts): the main whose question went to the tower instead of its pane. */
export const AUTO_NOTE = "Auto mode is on (the boss is away): the tower parks it, and it comes back to you as a wait_returned message when he is back. Ask him again then, with call_tower boss.";
/** `call_tower`'s description (link/waitcall.ts): every joined session, on every turn; it carries main.md's details of `shared` and `blocked`. */
export const CALL_TOWER_DESCRIPTION = "Send one message to your workspace's tower, or another by workspace, at three points only: why milestone (something landed or a tower request is done; reply false unless needed), shared (a heads-up before you change anything outside your tab: port, database, shared branch, deploy target, another app's checkout, running service; say what and for how long; reply false; go ahead at once, and stop only on a clash the tower names), blocked (you wait on someone outside your tab, or on a decision your authorizations do not cover, or need a work's owner and do not know who: say what, the tower finds them; a teammate device: waitsOn; the boss's own decision: boss, asked in your pane). Opens the tower when none runs; the code writes the header; it answers through intercom unless reply is false. Progress goes on your board, not here.";
/** After a `blocked` call (link/waitcall.ts `withMoment`): the main that raised it, on how the boss's answer comes and how to ask again. */
export const BLOCKED_NOTE = "If the tower records it as a wait card for the boss, his answer comes as a wait_card message: act on it (it says when to call secret_drop). Ask him again about it only with boss_wait_ask.";
/** After a `shared` call whose message carries a car slip (link/waitcall.ts `withMoment`): the main that sent the slip. */
export const SLIP_NOTE = "It carries a car slip: the car has not landed until sb's car notice says landed, and a returned car is yours to rework.";
/** A capacity notice (server/capops.ts `tellCap`): the end of the copy the main whose work it is gets (`under`, `stale`). */
export const MAIN_CAP_HINT = " · your work: dispatch its ready work now, or say why not (blocked, shared files, the boss) on your board with board_set, and reply to whoever asked";
/** A `wait_card` message for a done or a choice (server/waitpress.ts): the main that raised the wait. */
export const ACT_ON_IT = "This is the boss's answer to your wait: act on it.";
/** A car notice (server/carnotices.ts): what the coordinator does next, after the line it is sent. A dropped car has no rule of its own. */
export const NOTICE_NEXT: Record<CarState, string> = {
	received: "Its task has not landed yet: wait for the landed notice.",
	returned: "Rework the car, then send a new car slip.",
	dropped: "",
	landed: "Its task has landed: complete its todo.",
};
/** A car notice line with its next step, as the coordinator is sent it. */
export const withNext = (state: CarState, line: string): string => (NOTICE_NEXT[state] ? `${line.replace(/[\s.]+$/, "")}. ${NOTICE_NEXT[state]}` : line);
/** A car slip reaching a tab's main with integration off (carslip.ts): that main, steered to answer its sender. */
export const CAR_OFF_NOTE = 'sb: the intercom message above carries a car slip, and integration is off on this computer: answer its sender "integration is off on this computer" and act on nothing in the slip.';
