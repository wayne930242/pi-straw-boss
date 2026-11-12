# Auto watch: the head tower runs the overnight watch (2026-11-12, issue #16)

Status: implemented on `feat/head-auto-watch` (base `main` 50aa96e7, 0.77.1; `main` 7075c567, 0.77.2, merged in), reworked after its review (R-F001 to R-F008), the boss's decisions of 11/12 (AW-D14, AW-D15), its second review (R2-F001, R2-F002: AW-D18, AW-D19), and its third (RV3-F001 to RV3-F004, folded into AW-D18 and AW-D19); review by the sb main owner before the merge. Related: [2026-11-09-auto-mode.md](2026-11-09-auto-mode.md) (the period, the return list, D4), [2026-11-04-head-tower.md](2026-11-04-head-tower.md) (the head's tools), the stall watch (`src/server/stallwatch.ts`).

## Boss words (binding)

| # | Words (verbatim) |
|---|---|
| AW-W1 | 「watchdog 應該附屬在主塔台下面，畢竟他要看大家」 (11/12) |
| AW-W3 | 「一一修好」, with two decisions (11/12): skip calm wakes, and open the head tower at the switch on when none is open (AW-D14, AW-D15). |
| AW-W2 | Issue #16: the server wakes the head about every 15 minutes while auto mode is on; it reads output, not pane activity; the head acts with `tower_send` only and never decides past the mandate; the return list gains what the watch saw and did; the watch stops when auto mode ends. |

Why: on 11/12 an unattended box produced nothing from 00:23 to 09:46 while a watchdog in one main only checked that a pane said "Working". That watchdog lived in the session that handled 「我要睡了」, saw only what that session thought to check, and died with it.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| AW-D1 | Who keeps the time | The sb server: a timer that looks every 30 s and reads the net when 15 minutes have passed since the last reading (`WATCH_MS`, a constant); a reading wakes the head only as AW-D14 says. No model polls, and no loop is armed from a session. | AW-W2; the stall watch's shape. A constant, since nothing yet says a boss needs another cadence. |
| AW-D2 | Where its state lives | In `auto-period.json`, with the period (`Period.watch`): the counts (readings, calm, wakes, skipped), the last reading (`last`, the cadence) and the last wake that reached the head (`told`, what the next notice tells since), the findings told (`shown`), the readings with no head, the nudges, the output clock of each workspace. Read field by field (`watchOf`): a broken entry is dropped, and a section that still cannot be built costs only the watch's part of the return list (R-F004). | Auto mode already survives a restart through that file, so the watch does too with no file of its own, and it ends with the period. |
| AW-D3 | A reading that was missed | One reading when the server is back, not one per 15 minutes missed (the computer slept). | The head needs the state now, not a backlog. |
| AW-D4 | Every 15 minutes, or only when something is wrong | Superseded by AW-D14: the server reads every 15 minutes, and wakes the head only for something new. | The boss's decision (AW-W3). |
| AW-D5 | What the server reads | One reading of the net snapshot the pages draw (`net.ts`), plus the period's notes and the stall watch's incidents. Fields in [What a wake reads](#what-a-wake-reads). | It is what the server already knows; no new collector. |
| AW-D6 | What counts as output | Board lines written since the last wake (`BoardViewRow.updated`) and car notices delivered since (`landed` named, the others counted). | The server sees neither commits nor pushes nor MR APIs. The work board's auto line moves when a main's todo moves, and a car's `landed` is checked against the remote by the server itself. |
| AW-D7 | No output | A workspace with a main or a train that showed none for 2 hours (`QUIET_MS`) is flagged once, until output is seen there again, and listed in the morning. The clock starts when the workspace is first seen (R-F006), moves to the time of the newest output each reading sees, whether its wake reached the head or not (R-F005), and does not flag a workspace whose mains are all idle with nothing open and where no train runs (R-F002). | The lesson of 11/12. Two hours, because a long gate or a long subagent run writes no board line. A finished workspace is no finding. |
| AW-D8 | Stuck | A train whose board and running gates did not move for 30 minutes (`STUCK_MS`), or whose writer is gone; a forward of the head (an ask `H<n>`) no tower took or acted on for 30 minutes. | The yard and the head's asks already hold both times. |
| AW-D9 | "Towers with unhandled cards" | A tower that is `held`, whose queued events have a `why` (no run is starting), that keeps events parked after a failed run, that shows a warning or error notice, or that holds a wait the boss answered and it has not resolved. | These are the states in which a card or an event sits with nobody acting on it. |
| AW-D10 | The head's tools | None added. The notice ends with a runbook; the head acts with `tower_send`, `tower_memory`, `board_read`, `tower_list`. | AW-W2; `HEAD_TOWER_TOOLS` is unchanged. |
| AW-D11 | What a nudge is | A forward of the head with no boss instruction behind it (an ask with no `relay`) made while auto mode is on, that its tower took (an ask the forward closed on failure is none, R-F008). Counted from `head/asks.json` at each wake and at the end. | The server already records every forward and whether the boss's event started it; no new tool call hook, and nothing the model says is counted. |
| AW-D12 | No head tower | At the switch on the server opens one (AW-D15). Later in the night it does not: a reading with something new is skipped, counted, and logged once per cause, and every reading with no head is counted from the first (`noHead`) and named in the morning. | Opening a workspace and a pane unasked at night is a visible act nobody is there to see. |
| AW-D14 | Calm readings (boss, 11/12) | The server reads every 15 minutes and wakes the head only when the reading holds something new (`assess`): a wait refused or cancelled since the last wake, or a finding no wake told yet (`keys`: a dialog waiting, a parked wait, a main idle at two readings in a row, a tower's trouble, a stuck train, a forward of the head's with no answer, a stall), or a quiet of 2 hours not told yet. A main first seen idle is no finding. A calm reading moves the output clocks and the idle set and is counted (`calm`); the return list counts readings, calm ones, and wakes. Each finding is told once a period; a forward told once is left out of the later notices (R-F008). | The model adds nothing on a calm reading; the server decides calm or hot from its own state. |
| AW-D15 | Opening the head (boss, 11/12) | Switching auto mode on opens the head tower when none is open (`watchSwitch`, `towers.head.ensure`). A head that closes or dies later in the night is not reopened; the readings without it are counted for the morning. | The boss is at their switch; without a head the watch has nobody to wake. |
| AW-D16 | One notice at a time (R-F001) | While a notice of the watch (`auto-watch:` keys) waits untaken in the head's queue, a reading with something new is skipped and counted, and `told` does not move, so the next notice carries what the skipped readings saw. Switching auto mode off drops the watch's notices no run took, queued or parked; one offered to the run in flight stays. | A head that takes no events must not come back to a pile of stale notices, and nothing of the watch acts once the boss is back. |
| AW-D17 | A wait the head's memory covers (R-F003) | The runbook and `head-run.md` have the head send the owning tower the wait's id and the standing instruction's own words; the tower decides from its own memory (a tower's `basis` names its own S<n> or D<n>, `basisOf`), or records the wait for the morning. The head names no S<n> or D<n> of its own. | A head's memory id means nothing in a tower's memory: it would record as `none`, or match the tower's own unrelated entry, on the return list. |
| AW-D18 | Told means taken (R2-F001) | A notice queued is `pending` in the watch state (in the period file: the head's workspace, the notice's key, its time, the keys it tells with their lines, the quiet workspaces it tells). It counts as a wake, and its keys as `shown`, its quiet as told, and its time as `told`, only at a later reading (or at the switch off) where `runs.noticeState` says `gone`: neither in the head's queue nor parked. `runs.noticeState` reads the head's own folder (`towerDir(slot, HEAD_KEY)`), not the workspace's binding, which the head's close, `lose`, and `towers.stop` remove (RV3-F001). It says `taken` while a head run that has not ended holds the notice, `queued` while it waits (or its run is gone), `parked` after two crashed runs. While it is `queued` or `taken` every reading is skipped and counted, calm ones too. A `parked` notice is dropped from `pending` without its keys going to `shown`, its quiet to told, or its time to `told`, so the next notice carries them again; it is neither a wake nor a block, takes the next number for its key, and is kept as `parked` (their count, and the last one's time and lines) for the return list (RV3-F002). At the switch off a notice still pending is named on the return list with its findings (`untaken`, 20 lines at most, the rest counted): as told to nobody, or, when `taken`, as taken by a head run still in flight (`inFlight`), not yet a wake (RV3-F004); the watch's notices are then dropped as AW-D16 says. | A notice queued is not a notice read: a head run that hangs, a start refused, or a notice parked after crashes left the findings marked told, the later readings calm, and a morning list that read "1 wake, 31 calm" with no finding named. |
| AW-D19 | Still open at the end (R2-F002) | Each reading keeps its findings with a short line (`said`, by key) as `open`, leaving out those the pending notice tells and the parked waits (the parked section lists those) before it keeps 20 and counts the rest (RV3-F003). The return list names those of the last reading that are not in `untaken`, under "Still open at the last reading", whenever one is left or some were counted. The watch reads no net at the switch off: the last reading, at most 15 minutes old, is what it knows. | A finding is told once a period (AW-D14). A held tower or a stall in a workspace whose other mains write would otherwise appear nowhere in the morning. |
| AW-D13 | The GUI | The return panel's data (`auto/report`) carries `watch`; the panel does not draw it. `/boss auto off` prints it. | The panel draws fixed sections (`gui/autoback.ts`), not a generic list; a new section needs its messages in both languages and a size-cap measurement. |

## What a wake reads

`factsOf(net, …)` in `src/server/autowatch.ts`, per base of this computer (a box this computer operates is left out):

| In the notice | Read from |
|---|---|
| Waits refused or cancelled since the last wake | The period's notes (`auto-note`: session id, tool, kind, gist) with `at` after the last wake; the session id is placed in a workspace through the net's units. |
| Waiting on a dialog now | Units and their subagents with `mark: "waiting"`, and `pending.tool`. |
| Parked for the boss | `tower.service.memory.bossWaits` with `parked`, still open. |
| Mains idle with open work | Units of role `main` with `mark: "idle"` (a main that commands a subagent is `commanding`, not idle) whose board row has undone items (`count`, else `items`); `stale` from the row; "at the last reading too" from the watch's memory of the last reading (in process memory: a restart starts it again). |
| Its tower | `service.state === "held"`, the `why` of `tower.queued` rows, `service.parked`, `service.notices` that are not `info`, `bossWaits` with `answered` and no `state`. |
| Trains | `yards.projects[].trains[]`: `state` (`stale`, `unreadable`), `updated` and a running step's `gate.updated` for `live`; `forming[]` rows that are `refused` or 30 minutes past `departs.maxWaitMin`. The workspace is the train unit's, else the integrator's. |
| The head's forwards | `head.asks[]` with `state` `waiting` or `received` and `since` 30 minutes ago or more. |
| Stall watch | `stall.list()` (now with the pane's workspace). |
| Output | Board rows with `updated` after the last wake; cars whose `notice` is `delivered` after it. |

Bounds: 3 items of a kind in a workspace (`+N more`), 10 workspaces with something to look at (the rest counted and named), the others in one line, 6,000 characters cut at a line, the runbook never cut. Every word a session wrote (names, labels, tools, board lines, wait texts, notices, train and stall names) is stripped of control characters, cut, quoted, kept from opening a header line or a code span, and withheld when it looks like a secret (`secretShaped`) (R-F007). A session's note dated in the future is dated now.

## The morning

`Report.watch` (`auto-report.json`, `auto/report`): `everyMinutes`, `readings`, `calm`, `wakes`, `skipped`, `noHead` (the first reading with no head tower open and their count), `first`, `last`, `nudges`, `sent` (the newest 20: time, workspace, first line), `quietHours`, `quiet` (workspace, label, hours with no output up to the end; a workspace whose mains were all done at the last reading is left out), `open` (the last reading's findings still open, AW-D19), `untaken` (the last notice when the head never took it, with its findings, and `inFlight` when a head run still holds it, AW-D18), `parked` (the notices parked after crashes: their count, the last one's time and lines, AW-D18). Absent when the watch never came due (a period under 15 minutes) and in a list written before this change. `/boss auto off` prints it after the existing sections.

**What the GUI needs** to draw it: one more `list(...)` in the folded part of `gui/autoback.ts` (`BackReport.watch`), three messages in `gui/messages/en.json` and `zh-TW.json` (the summary line, a nudge row, the quiet heading), and the bundle caps of `tests/imports.test.ts` measured again.

## Limits

- The primary server's only, as auto mode is: a secondary Herdr slot's towers are not watched, and its head gets no notice.
- With `towerRuns.enabled: false`, or no head tower open, every reading with something new is skipped; the return list says how many.
- The unattended box (a controller's `b.box` bases) is not watched: `factsOf` leaves out a box this computer operates, and the box's own watches (basic `going-to-sleep` on the box) stay until the box's board and yards reach the controller through operate.
- The watch sees a main that works and writes no board line as quiet. Two hours is the bound before it says so.
- A slip a tower forwarded that no integrator received is not seen: the car book keeps forwards in process memory with no reader for this.
- The notice is data to the head, but the head is a model: the runbook bounds what it does, the server does not enforce it. Each forward it makes is on the return list.

## Open questions (issue #16)

| Question | Answer |
|---|---|
| Which signals count as output across hosts | This computer's board lines and car notices (AW-D6). Git refs, anchorloop books, and MR APIs are deferred: the server reads none of them today, and each needs a per-project source. |
| Per-workspace quiet hours | Deferred. The thresholds are constants; a `config.json` section like `stallWatch` is the place when a workspace needs its own. |
| A secondary server or an unattended box | Deferred. An unattended device has no auto mode. A box's units reach a controller through operate (`RemoteBox` bases), which the watch leaves out; reporting them to the controller's head needs the box's board and yards in the operate slice. |
| Skip a wake when nothing changed (new, AW-D4) | Decided by the boss: skip calm wakes (AW-D14). |
| Open the head tower when auto mode starts without one (new, AW-D12) | Decided by the boss: open it at the switch on only (AW-D15). |

When this ships, basic `going-to-sleep` drops its own watchdog step for this computer; the box's stays.

## Tests

`tests/auto-watch-night.test.ts` (one test per review finding R-F001 to R-F008, R2-F001 (the reviewer's probe B, queued, over 32 readings; and a notice taken late, at the switch off), R2-F002, RV3-F002 (probe A, parked) and RV3-F003, and per decision AW-D14, AW-D15), `tests/auto-watch-notice.test.ts` (RV3-F001 and RV3-F004 against the test server's real queue), and `tests/auto-watch.test.ts` (clocks the test moves): the timer only while on, every 15 minutes, stopped by off, a new count the next night; a restart goes on from the period file, and a long sleep wakes once; skipped wakes counted; the facts from a net; the notice's sentences; the bounds and the cleaning; the return list's section and its printed lines; no new head tool; and, in the test server, the switch on opening the head, a calm reading waking nobody, one notice waiting at a time across a restart and pending in the period file, and the switch off dropping it and naming it on the return list.
