# The done nudge: a child idle too long is asked to finish

Status: built on `feat/done-nudge`, not released. The behavior is in [how-it-works](../how-it-works.md#the-subagent-host).

## Decision

The boss, 2026-11-28: 「然後 subagent idle/finished 太久，也要提醒他們做 subagent done」.

That night several children of sb's host ended a turn with a "needs help" report or a pending wait and stayed open. One sat idle in a stale poll loop. Their parents only got `no-progress advisory` lines, which say how long a child has been quiet but do not ask it to do anything.

Maestro already asks once. Its child protocol (`adapters/pi/child/done-nudge.js`) asks a child that does not exit by itself "Is your task complete?" 3 seconds after a run ends, and asks again only after new input. A child that answers "waiting" is never asked again, so it can sit open for hours.

## What it does

When a child of sb's host has had its turn ended for `idleMinutes` (default 10) without delivering a result, sb asks it to finish. The question goes into the child's own session as a user message. It tells the child to write its final report and finish, or to use `caller_ping` if it really waits on its caller. A stretch of idleness gets one nudge, and a run gets `max` nudges in all (default 2). If the child is still idle `idleMinutes` after the last one, the parent is told once, and sb stops asking.

It never nudges:

- an interactive child (`interactive`, which the user drives in its pane);
- a persistent specialist (idle between tasks is its normal state; the simple host does not run them, but the check stays);
- a child whose turn runs, a long tool call included, or that is blocked on a dialog;
- a child being cancelled;
- a child whose input box holds unsent text;
- a child that still waits on subagents of its own.

## The states it reads

The parent's lifecycle projection, as Maestro 0e1dd78 computes it (`core/lifecycle.js`, `projectLifecycle`): Herdr's `idle` and `done` become `waiting`, and `working` becomes `active`. A `blocked` agent becomes `blocked`, and Pi's own activity file stands in when Herdr gives no status. Only `waiting` counts as idle. Its `stateDurationSince` is when the stretch began. A nudge the child took also starts a new stretch, because a reply turn that ends between two looks leaves the projection's start where it was.

## Where it runs

No new watcher. The parent's side runs inside the status loop that already looks at every running child once a second (`src/host/widgets.ts`, `startStatusRefresh`, the loop that sends the stall and no-progress lines). The parent's notice is one more line in the `subagent_status` message that loop sends, so it wakes the parent the way those lines do. With `status.enabled: false` in `herdr-agents/config.json` that loop does not run, and neither does the nudge.

Delivery goes through the child's own pi. The parent cannot tell from outside whether the child's input box holds a draft. Reading the screen cannot tell a draft from model text (AGENTS.md, Design), and typing into a pane with a draft would submit the user's half-written words with the nudge. The extension that owns the editor can tell. So the parent writes a request beside the child's session file, and sb's child entry (`src/host/child.ts`) takes it. The child checks it is idle, has no queued message, has an empty input box, and has no undelivered subagent of its own. Only then does it send the nudge with `pi.sendUserMessage(text, { deliverAs: "followUp" })`. That is the same path Maestro's own done nudge and its persistent-task inbox use. The child answers with an ack. Maestro is not changed: its pin stays at 0e1dd78.

| File (beside the child's session file) | Written by | Content |
|---|---|---|
| `<session>.sb-nudge` | parent, by rename | `{ "v": 1, "id": "<run id>:<n>", "idleMs": 600000 }` |
| `<session>.sb-nudge-ack` | child, by rename | `{ "v": 1, "id": "<run id>:<n>", "outcome": "sent" \| "draft" \| "busy", "at": <ms> }` |

The child polls for the request every 2 seconds and deletes it when it reads it. The parent deletes the ack once it has read it. An ack whose `id` is not the open request's is ignored, so a resumed run that shares the session file cannot take an old answer. `sent` counts a nudge. `draft` and `busy` count nothing, and the parent asks again 60 seconds later if the child is still idle. When a request has had no ack for 60 seconds (a child started by an older Straw Boss, whose entry has no inbox), the parent removes it, tells its own session once that the child cannot be asked, and stops. When a run leaves the registry (delivered, cancelled, lost), the parent removes any request of its that is still open.

## The nudge text

The child picks the wording by whether it exits on its own (`PI_SUBAGENT_AUTO_EXIT`), because only a child that does not has `subagent_done`.

A child with `subagent_done`:

> Straw Boss: you have been idle for 10 minutes, and your caller still has no result from you. If your task is done, write your final report now and call subagent_done. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping. If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.

An auto-exit child (it stayed open because its last run was aborted, or something held its exit):

> Straw Boss: you have been idle for 10 minutes, and your caller still has no result from you. If your task is done, end this turn with your final report: this session then closes and delivers it. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping.

## The parent's notice

In sb's language (`locale` in `config.json`, else the environment), one line in `subagent_status`:

- en: `build-api has been idle 32m and has not delivered its result, after 2 reminders to finish. Straw Boss will not remind it again. Read its pane; subagent_cancel stops it, and subagent_resume with its session file (…/x.jsonl) continues it later.`
- zh-TW: `build-api 已閒置 32m，還沒交回結果；Straw Boss 已提醒它收尾 2 次，不會再提醒。請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（…/x.jsonl）。`

When the child cannot be asked:

- en: `build-api has been idle 10m and has not delivered its result, and Straw Boss could not remind it: its pi took no reminder (it was started by an older Straw Boss). Read its pane; …`
- zh-TW: `build-api 已閒置 10m，還沒交回結果，而 Straw Boss 無法提醒它：它的 pi 沒有接收提醒（它是較舊版的 Straw Boss 啟動的）。請看它的窗格；…`

## Settings

`subagentNudge` in `<state dir>/config.json` (`~/.pi/agent/straw-boss/config.json`), read at most every 15 seconds, so a change applies without a reload:

```json
{ "subagentNudge": { "idleMinutes": 10, "max": 2 } }
```

`idleMinutes` is a number from 0 to 1440, where 0 turns the nudge off; fractions are allowed. `max` is a whole number from 1 to 10. A missing key, a value out of range, or a file that cannot be read means the default.

Why 10 minutes. Maestro's own question has already gone 3 seconds after the run ended, so a child still idle 10 minutes later either answered "waiting" or ignored it. A child that waits on its caller should have used `caller_ping`. The parent's own follow-up (a resume, a message the user types) normally comes within that time. The no-progress advisory (`supervision.hangWarningMinutes`, 15) reports a quiet child after 15 minutes, so a forgotten report is chased before the parent would hear of a hang. With `max` 2 the parent hears of a child that will not finish after about 30 minutes: two nudges and one more quiet stretch.

## Known limits

- A child that does not exit by itself gets Maestro's own question 3 seconds after it answers sb's nudge, because Maestro treats any input as new work. That is one more turn per nudge, at most `max` times.
- The clock is the parent process's. After the parent restarts, Maestro adopts the child again and the counts start from zero.
- A child that never reaches `waiting`, such as one hung inside a tool, is not nudged. The no-progress advisory still reports it.

## Tests

- `tests/host-nudge.test.ts`: the parent's decision table (eligibility, threshold, one per stretch, the cap and the single notice, `draft` and `busy` retries, a missing ack, en and zh-TW, the settings). It also covers the child's inbox (sent, draft, busy, its own children, persistent, both wordings) and the status loop carrying the notice.
- The live check: a real pi child in a scratch Herdr workspace ends its turn without reporting, is nudged, and then reports.
