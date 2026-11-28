# The done nudge: a child idle too long is asked to finish

Status: released in 0.114.0 ([notes](../releases/0.114.0.md)), its idle poll made cheaper in 0.114.1. The behavior is in [how-it-works](../how-it-works.md#the-subagent-host).

## Decision

The boss, 2026-11-28: 「然後 subagent idle/finished 太久，也要提醒他們做 subagent done」.

That night several children of sb's host ended a turn with a "needs help" report or a pending wait and stayed open. One sat idle in a stale poll loop. Their parents only got `no-progress advisory` lines, which say how long a child has been quiet but do not ask it to do anything.

Maestro already asks once. Its child protocol (`adapters/pi/child/done-nudge.js`) asks a child that does not exit by itself "Is your task complete?" 3 seconds after a run ends, and asks again only after new input. A child that answers "waiting" is never asked again, so it can sit open for hours.

## What it does

When a child of sb's host has had its turn ended for `idleMinutes` (default 10) without delivering a result, sb asks it to finish. The question goes into the child's own session as a user message. It tells the child to write its final report and call `subagent_done`, or to use `caller_ping` if it really waits on its caller. A stretch of idleness gets one nudge, and a run gets `max` nudges in all (default 2). If the child is still idle `idleMinutes` after the last one, the parent is told once, and sb stops asking.

It never nudges:

- an auto-exit child (`PI_SUBAGENT_AUTO_EXIT=1`). Maestro writes `done` and closes such a child when a turn ends, so a nudge's fresh turn would deliver unfinished work as a success, even when the child answers that it is not done (review 2026-11-28, F001). The child answers the request with `auto-exit`, and the parent is told once instead;

- an interactive child (`interactive`, which the user drives in its pane);
- a persistent specialist (idle between tasks is its normal state; the simple host does not run them, but the check stays);
- a child whose turn runs, a long tool call included, or that is blocked on a dialog;
- a child being cancelled (a cancel revokes the open request);
- a child whose input box holds unsent text;
- a child that still waits on subagents of its own.

## The states it reads

The parent's lifecycle projection, as Maestro 0e1dd78 computes it (`core/lifecycle.js`, `projectLifecycle`): Herdr's `idle` and `done` become `waiting`, and `working` becomes `active`. A `blocked` agent becomes `blocked`, and Pi's own activity file stands in when Herdr gives no status. Only `waiting` counts as idle. Its `stateDurationSince` is when the stretch began. A nudge the child sent also starts a new stretch, because a reply turn that ends between two looks leaves the projection's start where it was.

A request belongs to the stretch it was written for. When the parent next sees the child not `waiting`, or `waiting` with another `stateDurationSince`, it removes the request; a request already gone was taken by the child, so the parent waits for its ack, which is how the nudge's own turn is still counted. The child refuses on its side too: it notes when each of its turns starts (`turn_start`) and acks `stale` for a request written before its latest turn, since a turn can start and end between two looks of the parent (F004).

## Where it runs

No new watcher. The parent's side runs inside the status loop that already looks at every running child once a second (`src/host/widgets.ts`, `startStatusRefresh`, the loop that sends the stall and no-progress lines). The parent's notice is one more line in the `subagent_status` message that loop sends, so it wakes the parent the way those lines do. Notices wait in a queue until pi has taken the message that carries them: they go first, and the message's line cap (`lineLimit`) counts only the other lines, so a cap never folds a notice into `+N more running` (F005). `pi.sendMessage` returns before pi takes the message, and pi reports a failure (a run that cannot start, for one) only to its own UI, so the send proves nothing (review 2026-11-28, F009). The message lists its notices' ids in `details.nudgeNotices`, and a notice leaves the queue when that message starts in the parent's session (`message_start`). One not confirmed goes again 30 seconds after it was sent, then 60, doubling up to 10 minutes, and only while the parent session is idle (`ctx.isIdle()`): while a turn runs, pi may still hold it as a steer. A send that throws leaves its notices for the next tick, and a throw anywhere in the tick stays in the tick. The loop keeps running after the last run left while a notice waits. With `status.enabled: false` in `herdr-agents/config.json` that loop does not run, and neither does the nudge. A look at a run touches no file unless the run has a request open or is due one: below its threshold, active, done, or waiting on a retry, it is a few comparisons in memory. The settings are read at most every 15 seconds for all runs together.

Delivery goes through the child's own pi. The parent cannot tell from outside whether the child's input box holds a draft. Reading the screen cannot tell a draft from model text (AGENTS.md, Design), and typing into a pane with a draft would submit the user's half-written words with the nudge. The extension that owns the editor can tell. So the parent writes a request into the run's folder beside the child's session file, and sb's child entry (`src/host/child.ts`) takes it. The child checks it is idle, has no queued message, has an empty input box, and has no undelivered subagent of its own. Only then does it send the nudge with `pi.sendUserMessage(text, { deliverAs: "followUp" })`. That is the same path Maestro's own done nudge and its persistent-task inbox use. The child answers with an ack. Maestro is not changed: its pin stays at 0e1dd78.

| File | Written by | Content |
|---|---|---|
| `<session>.sb-nudge/<run id>/<request id>.req` | parent, by rename | `{ "v": 2, "id": "<request id>", "runId": "<run id>", "sessionFile": "<session>", "at": <ms>, "idleMs": 600000 }` |
| `<session>.sb-nudge/<run id>/<request id>.ack` | child, by rename | `{ "v": 2, "id": "<request id>", "runId": "<run id>", "outcome": "sent" \| "draft" \| "busy" \| "stale" \| "lost" \| "auto-exit", "at": <ms> }` |

Runs and parents are kept apart (F002). The run id in the path is the one Maestro gives the child as `PI_SUBAGENT_ID`, so a run resumed on the same session file reads its own folder and never an orphan of the run before it. A request id is a random UUID, so a parent that reloads never reuses one and cannot take an old ack for its new request. The child answers only a request whose `runId` and `sessionFile` are its launch identity (`PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`). Each request has files of its own, so a parent removes exactly its own request and ack and never another parent's; the folders go when they are empty.

The child's inbox stands still while the session it is in (`ctx.sessionManager.getSessionFile()`) is not the file it was launched with, so after a `/resume` into another session it neither reads the launch file's requests nor sends into the other transcript (F003).

The child polls its folder every 2 seconds and deletes a request when it reads it. An idle poll is one `stat` of the run's folder (none there is the common case, and builds no error): the child lists the folder only when its mtime moved since the last listing, or when that listing ran within 2 seconds of the mtime it saw, since a change in the same tick of the file system's clock would not move it (the boss, 2026-11-28: 「也要注意一下效能問題」). A watch (`fs.watch`) is not used: the folder comes and goes with each request, and the stat costs about 2 µs. A request written more than 20 seconds before the child reads it is `stale`: its parent may have revoked it or gone (F007). `pi.sendUserMessage` returns before pi takes the input, and a failure surfaces only later, so the call proves nothing (F006). The nudge's text carries a mark of its request (`reminder` and the request id's last 8 characters), and the child acks `sent` only when a user message that holds that marked text starts in its session (`message_start`) within 30 seconds of the send; a message quoting an earlier reminder carries another mark (F008). A nudge that has not entered after 30 seconds, whether the poll or the message comes first, or whose send throws, is acked `lost`. The child writes no ack once its request is a minute old, since its parent has stopped waiting by then. The parent deletes the ack once it has read it, and ignores one whose `id` or `runId` is not its open request's.

- `sent` counts a nudge.
- `lost` is no delivery, but it is one of the `max` tries and starts a stretch, since the nudge may have gone in after all (an input handler of another extension that rewrites the text, for one). The parent's notice says how many reminders the child could not confirm.
- `draft`, `busy`, and `stale` count nothing, and the parent asks again 60 seconds later if the child is still idle.
- `auto-exit`: the parent tells its own session once and stops.

When a request has had no ack for 60 seconds, the parent removes it, tells its own session once that the request was not acknowledged, and stops. It does not guess why: the child may run an older Straw Boss whose entry has no inbox, or its pi may be stuck. When a run leaves the registry (delivered, cancelled, lost), the parent removes any request of its that is still open.

A reload or a quit stops the status loop, and the stop revokes every open request: one whose ack is already there is counted first, and one still in the folder is removed, so the child never takes it (F007). A request the child already took, and any other the parent revoked after the child took it (a cancel, no ack in time), is watched for two minutes, and an ack that still arrives is removed at the next tick. After a stop that revoked a taken request, the next request waits a minute, since the nudge may be in.

What the parent keeps (the counts of each run, the notices not yet confirmed, the revoked requests it watches) lives in a process-wide slot (`globalThis[Symbol.for("pi-straw-boss/done-nudge/v1")]`), so the nudger of a reload's new load takes it over, as Maestro's registry of runs survives a reload. At session start the new load sends the notices still waiting even when no run is left to start the loop (F009).

## The nudge text

Only a child that does not exit on its own is nudged, so the one wording names `subagent_done`:

> Straw Boss (reminder 8b6c1a90): you have been idle for 10 minutes, and your caller still has no result from you. If your task is done, write your final report now and call subagent_done. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping. If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.

## The parent's notice

In sb's language (`locale` in `config.json`, else the environment), one line in `subagent_status`:

- en: `build-api has been idle 32m and has not delivered its result, after 2 reminders to finish. Straw Boss will not remind it again. Read its pane; subagent_cancel stops it, and subagent_resume with its session file (…/x.jsonl) continues it later.`
- zh-TW: `build-api 已閒置 32m，還沒交回結果；Straw Boss 已提醒它收尾 2 次，不會再提醒。請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（…/x.jsonl）。`

When some reminders were sent but not confirmed: `… after 2 reminders to finish (its pi could not confirm that 1 of them entered its session). …`, and in zh-TW `…已提醒它收尾 2 次（其中 1 次它的 pi 無法確認已送進它的 session），…`.

An auto-exit child (it stayed open because its last run was aborted, or something held its exit):

- en: `build-api has been idle 10m and has not delivered its result. Straw Boss did not remind it: it closes when a turn ends, so a reminder would close it and deliver its unfinished work as done. Read its pane; …`
- zh-TW: `build-api 已閒置 10m，還沒交回結果。Straw Boss 沒有提醒它：它一輪結束就會關閉，提醒會讓它把沒做完的工作當成結果交回。請看它的窗格；…`

A request with no acknowledgement:

- en: `build-api has not delivered its result, and its pi sent no acknowledgement of Straw Boss's reminder request within a minute, so Straw Boss will not remind it. Read its pane; …`
- zh-TW: `build-api 還沒交回結果；Straw Boss 要提醒它收尾，但它的 pi 一分鐘內沒有回應這個請求，所以不會再提醒。請看它的窗格；…`

## Settings

`subagentNudge` in `<state dir>/config.json` (`~/.pi/agent/straw-boss/config.json`), read at most every 15 seconds, so a change applies without a reload:

```json
{ "subagentNudge": { "idleMinutes": 10, "max": 2 } }
```

`idleMinutes` is a number from 0 to 1440, where 0 turns the nudge off; fractions are allowed. `max` is a whole number from 1 to 10. A missing key, a value out of range, or a file that cannot be read means the default.

Why 10 minutes. Maestro's own question has already gone 3 seconds after the run ended, so a child still idle 10 minutes later either answered "waiting" or ignored it. A child that waits on its caller should have used `caller_ping`. The parent's own follow-up (a resume, a message the user types) normally comes within that time. The no-progress advisory (`supervision.hangWarningMinutes`, 15) reports a quiet child after 15 minutes, so a forgotten report is chased before the parent would hear of a hang. With `max` 2 the parent hears of a child that will not finish after about 30 minutes: two nudges and one more quiet stretch.

## Known limits

- An auto-exit child that sits open after an aborted run is only reported, never asked: closing it as done would be worse than leaving it to the parent.
- A child that does not exit by itself gets Maestro's own question 3 seconds after it answers sb's nudge, because Maestro treats any input as new work. That is one more turn per nudge, at most `max` times.
- The clock is the parent process's. A reload keeps the counts; after the parent restarts, Maestro adopts the child again and the counts start from zero.
- A notice pi dropped while a turn ran waits for the parent to be idle before it goes again, and one pi took twice (a steer it restored after an abort, say) may show twice.
- A child that never reaches `waiting`, such as one hung inside a tool, is not nudged. The no-progress advisory still reports it.

## Tests

- `tests/host-nudge.test.ts`: the parent's decision table (eligibility, threshold, one per stretch, the cap and the single notice, `draft`, `busy` and `stale` retries, `lost`, a missing ack, an auto-exit child, en and zh-TW, the settings). It covers the review's findings one by one: F001 (an auto-exit child sends nothing and its parent is told), F002 (run folders, request ids across reloads, a parent removing only its own files, a resumed run), F003 (the inbox off the launch file), F004 (a cancel and a new stretch revoke; the child refuses a request older than its latest turn), F005 (the cap and a failed send), F006 (`sent` only on entry, `lost`, the no-acknowledgement wording), F007 (a stop revokes and counts, a late ack is removed, the child's expiry and its last ack), F008 (the mark, the deadline at entry), and F009 (a notice kept until its message starts, resent only while idle, a throw inside the tick, the store across a reload, `resumeNotices`). It also covers the child's inbox (sent, draft, busy, its own children, persistent), the cost of its idle poll (one `stat`, a listing only when the folder's mtime moved), and the status loop carrying the notices.
- Measured 2026-11-28 on an Apple M4 Pro at a load average of about 20, 10 children: an idle child's poll costs 1.8 µs with no folder and 2.0 µs with an unchanged folder (0.114.0: 4.4 and 14.4 µs). The nudge's share of the parent's tick is 0.04 µs per child below its threshold or active, and 5.3 µs per child with a request open (one ack read).
- The live check: a real pi child in a scratch Herdr workspace ends its turn without reporting, is nudged, and then reports; an auto-exit child left idle gets no nudge, and its parent gets the notice.
