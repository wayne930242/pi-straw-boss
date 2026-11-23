# The tower closes agent panes: a main that handed over, and a dead agent pane (2026-11-23)

Status: implemented on `feat/tower-close-panes` (base `main` 3cda0f59, 0.82.0), for 0.82.1. How it behaves for a user: [how-it-works, Closing a main that handed over, and a dead agent pane](../how-it-works.md#closing-a-main-that-handed-over-and-a-dead-agent-pane).

## Boss words (binding)

> 「tower agent 應該也要有能力把 agent 的 pane 用 herdr cli 關閉，特別是交接以後」

## Before

- `boss_close_main` (`src/closemain.ts`) closed only a main a tower opened (`sb_opened_by`), and refused a standing main. A main the boss opened was refused with "was not opened by a tower (the boss opened it), so only the boss closes it".
- After `boss_handover` (0.82.0) the old main stepped down and waited "for the user, or the tower that opened it, to close it". An old main the boss opened stayed open until the boss closed it by hand, and a tower-opened one counted beside its successor against its sender's cap (RVR-F007).
- A revive (D3) closes a dead main's old tab only when a tower opened it; every other dead pane stayed.

## Decisions

| # | Question | Decision |
|---|---|---|
| C1 | One tool or two | One: `boss_close_main` takes `main` (as before), or `pane`, or neither (the list). It is registered in the same places, a tower run reaches it through the same `run-tool` request, and its gate rules stay as they are. |
| C2 | When is a successor live | The broker lists the session id the handover mark names, and Herdr shows pi (`agent: "pi"`) in the pane the broker places it in. The mark itself is written only after the successor took the handoff, so a successor that died later is not live, and the old main stays open. |
| C3 | When does the tower hear of a handover | At the take: the old main sends the notice right after `markHandedOver`. A `why: milestone` with no reply holds a run's wake for 30 s (runs.ts `holdable`), which leaves the old main time to step down; the prompt says to retry after its next message when it is still working. |
| C4 | Which panes carry an agent's marks | A token whose key starts with `sb_` or `piha_` (pi-herdr-agents' delegated marker), or a pi session Herdr's integration named (`agent_session`). Seen live on 2026-11-23: a main pane whose pi had exited kept `sb_role=main` and `sb_main_tab`, and a different one ran a dev server, so the marks alone prove nothing and the foreground decides. |

## 1. A main that handed over

`boss_close_main {main}` on the tower's side (`createCloseMain().closeMain`):

1. The session is in the tower's workspace and is a main or a train, as before.
2. `handedOverOf(stateDir, pane)` reads the main's role record: the record of the session file Herdr names for the pane (`agent_session`), else the newest main record of that pane and workspace (Herdr's pi integration may be missing). A tab keeps one main record (`roles.remember`), so another main's record cannot stand there.
3. Neither `sb_opened_by` nor the mark: refused with the words of before.
4. The mark and no live successor (C2): refused, "handed over to session <id> (tab <tab>), which is not live …", and nothing is asked.
5. Otherwise the ask goes out as before.

The main's own check (`judge`) accepts a sender that is its workspace's tower when its pane carries `sb_opened_by` or its own session holds the `successor` entry with the successor's id. The busy checks are unchanged. A main that handed over registers `straw-boss/control` when the handover succeeds (`listen`, tools.ts) and at each start after (session.ts), since a main the boss opened never registered it before.

`refuseStanding(net, query, stateDir)` lets a standing main pass when its record says it handed over: the mark proves the step-down. An ally run's check passes no state folder, since a main opened for a teammate's device never hands over (RVR-F002).

`HandedOver` gains the successor's `tab` and `pane` (optional, checked when read), so the refusal names the tab.

## 2. What stays refused

| Case | Words |
|---|---|
| a live main the boss opened that did not hand over | `<name> was not opened by a tower (the boss opened it), so only the boss closes it` |
| a live standing main that did not hand over | `<name> is a standing main: it has no end and sends no done report, so only the boss closes it` |

## 3. A dead agent pane

`src/deadpane.ts` decides from one table (its header), as `dead.ts` decides a death. The rows, in order:

| Row | Evidence | Refusal |
|---|---|---|
| missing | Herdr lists no such pane | `No pane <id> in Herdr's list` |
| elsewhere | another workspace | `<id> is not in this workspace` |
| tower | the tower's own pane or tab, the pane of the workspace's tower session, or `sb_role` tower or head (a standing pane waits at its shell between runs) | `<id> is a tower's pane` |
| unmarked | no agent mark (C4) | `<id> carries no mark of an agent` |
| opening | `sb_open_main` or `sb_revive` in its tokens: an open, a revive, or a handover is starting its pi (each writes the one-time claim before `startPi`, and the claim clears it) | `<id> is being opened right now` |
| reviving | a revive lock younger than 5 min (revive.ts `takeLock`) for a session whose role record names this pane | `<id> is being revived right now` |
| listed | the broker lists a session at the pane | `<id> is not dead: a live session (<name>) is at it` |
| busy | `herdr pane process-info` lists anything but the shell (`shell_pid`) in the foreground, or gives no shell pid | `<id> is not at a bare shell: <names> runs in it` |

`boss_close_main {pane}` re-reads everything and closes the pane that passes: `herdr tab close <tab>` when it is the tab's only pane, else `herdr pane close <pane>`. `boss_close_main {}` lists the panes that pass, with their tab, whether they are alone in it, and what their tokens say they were. The process-info step is the D3 proof of the revive, applied to any agent pane.

A tower run gets `closePane` and `deadPanes` on its tool host (towers.ts) from the workspace's control; an ally run is refused `pane` and the list before the gate (runtools.ts).

## 4. The notice

On a handover that took, the old main calls `reach.openTower(undefined, false)` (the live tower of its workspace; none is opened) and posts a `call_tower` with `why: milestone`, no reply:

> Straw Boss: main `<name>` (session `<id>`) handed over to its successor in tab `<tab>` (session `<successor>`), which took the handoff. `<name>` steps down now; once it is idle and its successor is live, close it with boss_close_main with main "`<id>`".

The `boss_handover` result ends with "your workspace's tower was told and closes this session once your successor is live", or, when no tower took the notice, that the boss closes it. `details.towerTold` says which.

## 5. Prompts and budgets

- `tower.md`: close a main that handed over once its successor is live, whoever opened it; `boss_close_main` with no argument lists dead agent panes, close each with `pane`. Measured: on 508 to 538, off 438 to 468 words (`tests/prompts.test.ts`, dated 2026-11-23).
- `tower-run.md`: the same, with the milestone that names the handover, "if it is still working, close it after its next message", and the dead panes closed once any `main_died` for them is settled. It has no word budget.
- The run brief's tools block (`towerbrief.ts`) is unchanged: it is capped at 900 characters (`tests/wait-cards.test.ts`) and stands at 897 in zh-TW, so the tool's description and `tower-run.md` carry the new closes.
- Source budgets (`tests/imports.test.ts`, measured): `tools.ts` 341 to 357, `closemain.ts` 111 to 141, `session.ts` 398 to 399; `deadpane.ts` is new with 116.

## 6. The basic rule (outside this repository)

weihung-basic-agent `rules/session-rotation.md` says the old main "waits for the user, or the tower that opened it, to close it". Proposed text, for its owner to apply:

> waits for its workspace's tower to close it: `boss_handover` tells the tower, which closes the old main once its successor is live, whoever opened it. With no tower in the workspace, the user closes it.

## 7. Tests

`tests/tower-close-panes.test.ts`, written red first and seen red on 3cda0f59 (7 of 8; the refusals of §2 pass there, since they pin behaviour that stays):

| Case | Test |
|---|---|
| §1 | the tower closes a boss-opened standing main that handed over once its successor is live; it refuses while the successor is not live and asks nothing; the old main refuses another workspace's tower |
| §2 | the two refusals keep their words |
| §3 | a dead pane alone in its tab closes with the tab, one beside another pane closes alone; the list; a live pi (listed), a pi process not listed, the tower's pane, another workspace, a pane mid-open or mid-revive (`sb_open_main` + `sb_revive`), a pane whose session a revive lock holds, an unmarked shell, a missing pane, and `main` with `pane` are refused |
| §4 | the tower of the old main's workspace gets one milestone naming both sessions, another tower none, and the result says the tower closes the old main |
| run | a local run's `pane` and list reach the tower's control; an ally run is refused both |

Two fixes were reverted one at a time and their cases went red: the successor's live check (§1, "refuses while not live") and the main's own acceptance of a handed-over main (§1, "closes", "refuses another tower").

## 8. Limits

- A pane can change between the check and the close (the boss types `pi` into it in that moment); the window is one Herdr call.
- An agent pane whose marks expired and that Herdr's pi integration never named carries no mark, so the tower cannot tell it from the boss's shell and leaves it.
- A sub workspace's main is closed only by a tower of that same workspace id, as before.
