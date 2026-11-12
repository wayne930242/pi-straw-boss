# Auto watch: the head tower runs the overnight watch (2026-11-12, issue #16)

Status: implemented on `feat/head-auto-watch` (base `main` 50aa96e7, 0.77.1); review by the sb main owner before the merge. Related: [2026-11-09-auto-mode.md](2026-11-09-auto-mode.md) (the period, the return list, D4), [2026-11-04-head-tower.md](2026-11-04-head-tower.md) (the head's tools), the stall watch (`src/server/stallwatch.ts`).

## Boss words (binding)

| # | Words (verbatim) |
|---|---|
| AW-W1 | 「watchdog 應該附屬在主塔台下面，畢竟他要看大家」 (11/12) |
| AW-W2 | Issue #16: the server wakes the head about every 15 minutes while auto mode is on; it reads output, not pane activity; the head acts with `tower_send` only and never decides past the mandate; the return list gains what the watch saw and did; the watch stops when auto mode ends. |

Why: on 11/12 an unattended box produced nothing from 00:23 to 09:46 while a watchdog in one main only checked that a pane said "Working". That watchdog lived in the session that handled 「我要睡了」, saw only what that session thought to check, and died with it.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| AW-D1 | Who keeps the time | The sb server: a timer that looks every 30 s and wakes the head when 15 minutes have passed since the last wake (`WATCH_MS`, a constant). No model polls, and no loop is armed from a session. | AW-W2; the stall watch's shape. A constant, since nothing yet says a boss needs another cadence. |
| AW-D2 | Where its state lives | In `auto-period.json`, with the period (`Period.watch`): the count, the last wake, the nudges, the output clock of each workspace. | Auto mode already survives a restart through that file, so the watch does too with no file of its own, and it ends with the period. |
| AW-D3 | A wake that was missed | One wake when the server is back, not one per 15 minutes missed (the computer slept). | The head needs the state now, not a backlog. |
| AW-D4 | Every 15 minutes, or only when something is wrong | Every 15 minutes. A notice with nothing to look at says so in its second line, and the head ends at once. | AW-W2 states the cadence; a quiet night is also what the 11/12 incident looked like from pane activity, so the head sees the output line each time. See Open questions. |
| AW-D5 | What the server reads | One reading of the net snapshot the pages draw (`net.ts`), plus the period's notes and the stall watch's incidents. Fields in [What a wake reads](#what-a-wake-reads). | It is what the server already knows; no new collector. |
| AW-D6 | What counts as output | Board lines written since the last wake (`BoardViewRow.updated`) and car notices delivered since (`landed` named, the others counted). | The server sees neither commits nor pushes nor MR APIs. The work board's auto line moves when a main's todo moves, and a car's `landed` is checked against the remote by the server itself. |
| AW-D7 | No output | A workspace with a main or a train that showed none for 2 hours (`QUIET_MS`) is flagged at each wake and listed in the morning. The clock starts when auto mode starts. | The lesson of 11/12. Two hours, because a long gate or a long subagent run writes no board line. |
| AW-D8 | Stuck | A train whose board and running gates did not move for 30 minutes (`STUCK_MS`), or whose writer is gone; a forward of the head (an ask `H<n>`) no tower took or acted on for 30 minutes. | The yard and the head's asks already hold both times. |
| AW-D9 | "Towers with unhandled cards" | A tower that is `held`, whose queued events have a `why` (no run is starting), that keeps events parked after a failed run, that shows a warning or error notice, or that holds a wait the boss answered and it has not resolved. | These are the states in which a card or an event sits with nobody acting on it. |
| AW-D10 | The head's tools | None added. The notice ends with a runbook; the head acts with `tower_send`, `tower_memory`, `board_read`, `tower_list`. | AW-W2; `HEAD_TOWER_TOOLS` is unchanged. |
| AW-D11 | What a nudge is | A forward of the head with no boss instruction behind it (an ask with no `relay`) made while auto mode is on. Counted from `head/asks.json` at each wake and at the end. | The server already records every forward and whether the boss's event started it; no new tool call hook, and nothing the model says is counted. |
| AW-D12 | No head tower | No watch: the wake is skipped, counted, and logged once per cause. The server does not open a head tower by itself at night. | Opening a workspace and a pane unasked is a visible act; the boss opens the head by talking to it. See Open questions. |
| AW-D13 | The GUI | The return panel's data (`auto/report`) carries `watch`; the panel does not draw it. `/boss auto off` prints it. | The panel draws fixed sections (`gui/autoback.ts`), not a generic list; a new section needs its messages in both languages and a size-cap measurement. |

## What a wake reads

`factsOf(net, …)` in `src/server/autowatch.ts`, per base of this computer (a box this computer operates is left out):

| In the notice | Read from |
|---|---|
| Waits refused or cancelled since the last wake | The period's notes (`auto-note`: session id, tool, kind, gist) with `at` after the last wake; the session id is placed in a workspace through the net's units. |
| Waiting on a dialog now | Units and their subagents with `mark: "waiting"`, and `pending.tool`. |
| Parked for the boss | `tower.service.memory.bossWaits` with `parked`, still open. |
| Mains idle with open work | Units of role `main` with `mark: "idle"` (a main that commands a subagent is `commanding`, not idle) whose board row has undone items (`count`, else `items`); `stale` from the row; "at the last wake too" from the watch's memory of the last wake (in process memory: a restart starts it again). |
| Its tower | `service.state === "held"`, the `why` of `tower.queued` rows, `service.parked`, `service.notices` that are not `info`, `bossWaits` with `answered` and no `state`. |
| Trains | `yards.projects[].trains[]`: `state` (`stale`, `unreadable`), `updated` and a running step's `gate.updated` for `live`; `forming[]` rows that are `refused` or 30 minutes past `departs.maxWaitMin`. The workspace is the train unit's, else the integrator's. |
| The head's forwards | `head.asks[]` with `state` `waiting` or `received` and `since` 30 minutes ago or more. |
| Stall watch | `stall.list()` (now with the pane's workspace). |
| Output | Board rows with `updated` after the last wake; cars whose `notice` is `delivered` after it. |

Bounds: 3 items of a kind in a workspace (`+N more`), 10 workspaces with something to look at (the rest counted and named), calm workspaces in one line, 6,000 characters cut at a line, the runbook never cut. Every word a session wrote is stripped of control characters, cut, quoted, kept from opening a header line or a code span, and withheld when it looks like a secret (`secretShaped`).

## The morning

`Report.watch` (`auto-report.json`, `auto/report`): `everyMinutes`, `wakes`, `skipped`, `first`, `last`, `nudges`, `sent` (the newest 20: time, workspace, first line), `quietHours`, `quiet` (workspace, label, hours with no output up to the end). Absent when the watch never came due (a period under 15 minutes) and in a list written before this change. `/boss auto off` prints it after the existing sections.

**What the GUI needs** to draw it: one more `list(...)` in the folded part of `gui/autoback.ts` (`BackReport.watch`), three messages in `gui/messages/en.json` and `zh-TW.json` (the summary line, a nudge row, the quiet heading), and the bundle caps of `tests/imports.test.ts` measured again.

## Limits

- The primary server's only, as auto mode is: a secondary Herdr slot's towers are not watched, and its head gets no notice.
- With `towerRuns.enabled: false`, or no head tower open, every wake is skipped; the return list says how many.
- The watch sees a main that works and writes no board line as quiet. Two hours is the bound before it says so.
- A slip a tower forwarded that no integrator received is not seen: the car book keeps forwards in process memory with no reader for this.
- The notice is data to the head, but the head is a model: the runbook bounds what it does, the server does not enforce it. Each forward it makes is on the return list.

## Open questions (issue #16)

| Question | Answer |
|---|---|
| Which signals count as output across hosts | This computer's board lines and car notices (AW-D6). Git refs, anchorloop books, and MR APIs are deferred: the server reads none of them today, and each needs a per-project source. |
| Per-workspace quiet hours | Deferred. The thresholds are constants; a `config.json` section like `stallWatch` is the place when a workspace needs its own. |
| A secondary server or an unattended box | Deferred. An unattended device has no auto mode. A box's units reach a controller through operate (`RemoteBox` bases), which the watch leaves out; reporting them to the controller's head needs the box's board and yards in the operate slice. |
| Skip a wake when nothing changed (new, AW-D4) | Open for the boss: a quiet night costs about 32 short head runs. Skipping calm wakes would save them and lose the regular "no output" reading. |
| Open the head tower when auto mode starts without one (new, AW-D12) | Open for the boss. |

When this ships, basic `going-to-sleep` drops its own watchdog step.

## Tests

`tests/auto-watch.test.ts` (clocks the test moves): the timer only while on, every 15 minutes, stopped by off, a new count the next night; a restart goes on from the period file, and a long sleep wakes once; skipped wakes counted; the facts from a net; the notice's sentences; the bounds and the cleaning; the return list's section and its printed lines; no new head tool; and, in the test server, the head's queue getting the notice, again after a restart, and none while off.
