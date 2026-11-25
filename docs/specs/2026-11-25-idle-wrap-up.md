# Idle wrap-up, and boss questions asked by the main (2026-11-25)

Status: part 1 implemented (`src/wrapup.ts`, `prompts/main.md`). The behavior is in [docs/how-it-works.md](../how-it-works.md#wrapping-up-an-idle-main).

## Part 1: an idle main wraps up

### Boss words (binding, 2026-11-25)

> 「如果 herdr idle 一陣子，可以問 agent 是否要收工。如果 agent 認為可以收工（如果可以繼續做，那就繼續做或是清理 todo），就 ask user，這會讓狀態變成 waiting。如果 user 同意收工，那就走收工流程（現在有流程嗎？看要不要也訂下來，像是清理 board 和回報塔台等等），然後用 herdr 把自己的 pane 關掉（僅限 user 同意）」

### Decisions

| # | Question | Decision |
|---|---|---|
| WU-D1 | How long idle before the nudge? | 30 minutes (boss). |
| WU-D2 | Where is the boss asked? | In the main's own pane, so Herdr shows it waiting; not as a wait card (boss). |
| WU-D3 | What does wrap-up leave behind? | A daily memory entry, written by the agent before `boss_wrap` (boss); sb does not depend on a memory extension. |
| WU-D4 | Auto mode? | No nudge and no wrap-up while it is on: the boss is away; wait until he is back (boss). |
| WU-D5 | Who keeps the clock? | The main's own session (left open by the brief). It sees each turn start and settle, so the turn the nudge itself starts is not counted as new work; the sb server's minute look sees only states, and a short turn falls between two looks. |
| WU-D6 | Which todos block `boss_wrap`? | Every one that is not completed or deleted (left open; the simplest rule). A task reported blocked to its owner is deleted first; a task that still waits on someone means the work is not done. |
| WU-D7 | What else blocks it? | An open dialog, a running monitor, an active pi-loop-monitor loop, a `boss_watch`, a running subagent. Intercom asks owed and worktrees made are not known to sb: the nudge and `prompts/main.md` name them. |
| WU-D8 | Which mains? | Kinds `coordinator` and `integrator`. Not a standing main (it has no end), a member, a train, a tower, or a main opened for a teammate's device (its device's stop or the tower closes it); `boss_wrap` is refused in a teammate's remote turn. |
| WU-D9 | The opener? | When a tower opened the main for a session (`sb_opened_by` is a session id), that session gets the summary too, as a plain intercom message; the tower gets it as `call_tower` `why: milestone`, `reply: false`. |
| WU-D10 | A tower that does not take the milestone? | Nothing closes, and the result says so; a later `boss_wrap` asks the boss again. |

### Behavior

1. **Nudge.** A coordinator or integrator main idle 30 minutes since its last turn settled gets one `straw-boss-wrap` message that starts a turn. It says: if work remains, go on or clean up stale todos; if it waits on someone other than the boss, set that todo's `metadata.waitsOn` and stop; if done, answer the intercom asks it owes, remove its worktrees, complete or delete every todo, stop its monitors and loops, write a daily memory entry if it has a memory tool, and call `boss_wrap`. At most one per idle period: the next comes after a turn that the nudge did not start, and 30 more idle minutes. None while a dialog is open or Herdr shows the pane blocked, while a monitor, loop, `boss_watch`, or subagent of the main runs, or while pi has messages queued. Under auto mode the clock stops; it starts again when auto mode ends.
2. **`boss_wrap({ summary })`.** One paragraph, 1 to 800 characters (whitespace folded). Checks in order: the role (WU-D8), the summary, auto mode (refused: "auto mode: the boss is away; wrap up when he is back"), a terminal to ask in, then every open todo by id, messages queued in pi, and everything that runs (WU-D7), all named in one refusal. Then `ctx.ui.confirm("Wrap up <name>?", summary)` in the pane; the GUI relays it as any dialog. No (or Esc): nothing closes, and no nudge comes this idle period. Yes: the same checks again, since the dialog may stand for hours (review RV-F001): a message that queued or a monitor that started meanwhile closes nothing and sends nothing. Then the milestone to the tower and the opener (WU-D9), the board cleared, and the close of `/boss close` (`closeSelf`): pi quits when the turn ends, and its pane closes, with its tab when emptied.
3. **Prompt.** `prompts/main.md`'s "Done when" line: every task landed or reported blocked, its worktree removed, every todo completed or deleted; then a daily memory entry if a memory tool exists, and `boss_wrap`; never close the pane otherwise.
