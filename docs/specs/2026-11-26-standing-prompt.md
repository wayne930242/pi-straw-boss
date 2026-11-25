# A standing main's own prompt and wake rules (2026-11-26)

Status: implemented, not yet released (planned for 0.93.0). Follows [just-in-time prompts](2026-11-26-just-in-time-prompts.md). Tests: `tests/duty-prompts.test.ts`, `tests/duty-session.test.ts`, `tests/wrapup.test.ts`, `tests/revive.test.ts`, `tests/watch-link.test.ts`, `tests/capwatch.test.ts`, `tests/link-capacity.test.ts`, `tests/tools-budget.test.ts`; items 8 and 9 and the review's fixes: `tests/link-waits-note.test.ts`, `tests/link-waits-holder.test.ts`, `tests/capacity.test.ts`, `tests/capops.test.ts`, `tests/auto-watch.test.ts`, `tests/restore.test.ts`.

## Boss words (binding)

2026-11-26, relayed verbatim by the standing main work-on (01a21221):

> 「跟 sb 收工那邊說，你是無人塔台值守，無人塔台值守 的 prompt 不該是 main 的，應該要量身訂做（你剛剛拿到的有量身訂做嗎？），而且閒置喚醒的條件也應該不同。請你和他討論一個推薦的做法，我都授權發版」

The standing rule of 2026-11-25 still holds: 「提示詞可以逐步交付」. The role prompt holds only what every turn needs. A rule needed at one moment comes in the text that arrives at that moment, and what code can do, code does.

## What was wrong

A standing main got `main.md` plus `duty-standing.md` (6,092 characters). The addendum's first line set `main.md`'s `Done when` aside. The standing main listed what did not fit it: the dispatch, idle, and report-idle line; `Done when`; the tower-opened report; the car, integration, `boss_pair`, and worker-brief bullets; and `call_tower`'s "three points only", which says nothing of `linkWait` or `standing`.

## The design agreed with work-on

1. **`prompts/standing.md`** is the whole prompt of a standing main (`src/briefing.ts` `partsOf`). `main.md` is not included, and `duty-standing.md` is gone. It renders to 2,169 characters in 12 lines, the same with integration on and off. It has no integration block, since a standing main sends no car. It says only what every standing turn needs:
   - the role: one system or machine, no end, only the boss closes it;
   - the board line;
   - `boss_watch`, never polling in its own turns;
   - its own commands under `MonitorCreate`;
   - the boss question as `call_tower` `why: blocked`, never `ask_user_question`;
   - link waits, a device's standing questions and notices, and delegate approvals, answered with `linkWait`;
   - the capacity notices as incidents;
   - the relay rule;
   - a requirement as `why: blocked` for a new main;
   - `why: shared`;
   - writing terse to agents;
   - rotation with `boss_handover`.

   `call_tower`'s `milestone` is not named. A notice to a device's standing main is `standing` with `why: milestone`, and the tool's description says so.
2. **The idle wake** (`src/wrapup.ts`). A standing main still gets no 30-minute nudge and no `boss_wrap`. Idle 2 hours with nothing armed, it gets one `straw-boss-arm` message: "sb: you have nothing armed (no watch, monitor, or loop). Re-arm what you mind from your handoff or board, or say on your board why nothing needs watching." Nothing armed means that the same look `boss_wrap` uses finds nothing: no `boss_watch` watch (a `link:` key counts), no running monitor, no active loop of any trigger type (a cron loop counts), no running subagent, and no dialog. The wake comes once per idle period, and again only after a turn of other work and another 2 hours. It comes under auto mode too, since a standing main runs unattended. It never goes to another kind.
3. **Recovery** (`src/revive.ts` `REARM_TEXT`). A revived standing main's handoff and its successor's first message (`successorPrompt`) gain: "Re-arm your watches, monitors, and loops from your handoff or board: a restart retires them. A retired monitor or loop is not finished: check its own end condition before acting on a done-wake." The second sentence holds until pi-loop-monitor stops sending a done-wake for a monitor that a restart retired. Other kinds do not get it, and `standing.md` does not carry it.
4. **A device key wakes on content** (`src/server/linkwatch.ts`). In the field, `link:yixv3j` woke work-on as `changed` every minute or two (17:19 to 17:45Z on 11-25), and the line said nothing more. A probe of the live server showed that only the reading's age moved between quiet readings. The wakes came from the box's tower units: their run state and last report change with every tower run, and the device key hashed them. Now `link:<short>` hashes the mains' states and the device's board as the Link holder holds it (`holder.boards`): each entry's `now` and items, the capacity points, the budget, the paused mains, and whether the device is online. The board's times and the load are left out. A tower unit's state, monitors, and report wake only `link:<short>/<unit>`. The view gains `board` (online, entries, points, budget, paused count), and the line names the mains by state and the board: `watch link:aaaaaa: changed · mains 1 (1 working) · board 1 entry · capacity 2/6 pts`.
5. **The quota blind spot** (`src/server/capwatch.ts`, `src/link/holder.ts` `allySeen`). At 14:16Z on 11-25 box 2's Claude seven_day quota ran out. All its lanes froze for about 3 hours, and this Mac's standing main got no `capacity quota` notice. The trace: a box's board carries `paused` in its capacity row (`WireCap.paused`, by entry id, sent once every teammate's `caps` list `board.capacity`). `allySeen` dropped it, and the capacity watch raised `quota` only for this device's own mains. Now `allySeen` carries each ally's entries (id and name) and paused mains. The watch raises `quota` for each paused one, keyed by the device and the entry, to this device's standing main and the head tower: `capacity quota · main "work-on" · device "box 2" (yixv3j) · quota · resumes 17:16`. It sends `resumed` once the pause is gone while the board still has that main. A pause with another resume time is a new flag, as for a local main. The notice still depends on the box itself: its pi-agent-basic `quota-resume` must emit `straw-boss:pause`, and its board must carry capacity. Whether box 2 did so on 11-25 was not checked from here.
6. **The sender's half of the relay.** Most of the 20 or so ownerless notices a day come from a teammate device's sender, which writes "for urgent 1124" in the body and names no owner. Where a notice to a device's standing main is sent, the text now says: in `call_tower`'s `standing`, "A notice about another main's work: reply in that wait's thread (linkWait), or use waitsOn with its owner."; in `tower_send`'s `standing`, "reply in that ask's thread (inReplyTo), or name its owner (ally_escalate owner, a main's waitsOn owner)". sb does not parse an "owner:" hint in the body.
7. **Armed** counts a cron loop and a `link:` watch. `armedLoop` already counts any active loop that has not expired, whatever its trigger (pi-loop-monitor always writes `expiresAt`), and `watch-list` lists every key. The tests now pin both.

## Decisions

- `boss` with `call_tower` stays as sb decides it: drawn in the pane while the boss is there and the device is attended, parked under auto mode, sent to the tower on an unattended device. The prompt's "nobody may be at your pane" forbids `ask_user_question` only.
- The heartbeat reads "nothing armed" only when it looks. Something armed and then retired during the 2 hours is not tracked, because any wake from a watch, a monitor, or a loop starts a turn and opens a new idle period.
- A device in two teams reads one team's board for its key, the one `holder.boards({device})` resolves.
- `link:<short>/<unit>` keeps its tower-unit facts, so a watcher who wants the tower's runs can still have them.

## Sizes (measured)

| | before | after |
|---|---|---|
| a standing main's role prompt | 6,092 (main.md + duty-standing.md) | 2,169 (standing.md, on and off) |
| sb's tools, trimmed / all | 7,336 / 10,664 | 7,443 / 10,771 (+107: call_tower's `standing`) |
| `src/wrapup.ts` lines | 151 | 155 |

## Out of scope

The coordinator's and the integrator's `main.md` (unchanged), pi-loop-monitor's done-wake on a retired monitor (another package), and routing by an "owner:" hint in a notice's body.

## Items 8 and 9, and the review's fixes (2026-11-26)

### Boss words (binding)

- 「我都授權發版」: the release of this round (relayed verbatim by the standing main work-on, 01a21221).
- 「herdr state 還在 working 的 agent 不必被詢問」 (01:0x on 11-26, relayed verbatim by tab 7, urgent 1124, 01a20d4d, as a change request for this version).
- 「提示詞可以逐步交付」 (2026-11-25) still holds: each rule below comes in the text of its moment.

### 8. A note on a wait goes to the main that raised it

**Field.** On 2026-11-26 at about 02:00, `board_read` `waits` on this Mac showed nine out waits, L282 to L314, to box 1 (`waydosoft`, `n2knna`). Their raiser was "urgent 1124: 宇鈞調查＋5539/5554" (handle `6986b74ffcae790f`) and their owner was empty. Every reply or notice from box 1 on that work reached the standing main as "it names no main here, and you are a standing main", and the nine stayed open although most of the work was done.

**Trace** (this Mac's ledger, `tower/w15X/linkwaits.json`, and `link/link.log`):

- The nine are `kind: question`, sent with `call_tower` `standing` (`src/server/standingsend.ts`).
- Box 1's every step on them (L283 to L315, in) was a fresh `standing` notice: `kind: notice`, a new wait id, owner empty, and the handle of box 1's own main (`da07d0be22fe8f43`). It wrote "(L282)" or "owner 01a20d4d" in its body only.
- The wire had no field that could name the wait: `WaitWire` has 5 or 6 parts, `src/link/kinds.ts`.
- The receiving router blanks the owner of every question and notice (`src/server/linkwaits.ts` `take`, `owner: wire.kind && wire.kind !== "approval" ? "" : …`), so `route` found no owner and told the standing mains.
- So the cause was on the sender's side: it opened a fresh notice instead of answering on the wait. The receiver had nothing to match the notice to. No raiser handle was ignored, because a notice carries only its sender's handle.
- Box 1 also sent no state of any of the nine (`told`, `taken`, `done`). The last wait state it sent this Mac is from 2026-11-22 13:40Z, so nothing here could close them. Why its router acked none cannot be seen from this Mac: box 1's own ledger and `link.log` hold the answer.

**The design.**

- **Sender.** A main sends a note on a wait it holds with `call_tower` `linkWait {id, state: "note"}` and the note as `message`. The code sends a notice whose wire carries a seventh part, `re`: the id of the wait it is about, which the receiver sent. `re` is written only to a device whose `caps` list `tower.note`, the twelfth feature. To an older build it goes without `re`, as before. The router refuses a note before sending when the device lists no `tower.note`, and refuses one on a notice, a reply, an approval, or a wait with no thread there (an ally run's escalation). The wait stays as it is; `done` or `declined` still closes it.
- **Receiver.** A notice whose `re` names an out wait this computer sent that device is recorded in that wait's workspace with `re: <L n>`, which `board_read` shows. It is told to that wait's raiser while the raiser is a live main there, whatever owner the wait named: "<device> sent a note on your question L282 (<what>) (L290): information only …". When the raiser is gone, the standing main gets it, with "it is a note on question L282 (…), whose raiser <name> is not here". A notice about no wait, or about a wait this computer does not hold from that device, goes to the standing main as before.
- **The text at the moment** (no standing prompt carries it):
  - The wake of a told wait or question says a note to the one waiting goes as state `note`.
  - A `standing` notice from a main that holds open waits from that device returns "You hold L5 from <device>: a note on one goes in its thread (linkWait state note), to the main there that waits on it, not to its standing main; done or declined closes it."
  - `call_tower`'s `standing` description now says "A notice on a wait you hold from that device: linkWait note." Item 6's "or use waitsOn with its owner" is dropped: it opened a fresh wait, the thing this item removes.
  - `standing.md`'s relay line tells the sender to use `linkWait` `note`, else name the owner.
- **Closing.** An out wait closes when the other side answers it: `done` or `declined` comes back as its wire state, or the reply to its ask arrives (`answered` marks it done). That step exists, so nothing new closes the raiser's copy. A note does not close it: it is progress, and the asker still waits for the answer. The nine of the field close when box 1 answers them, when their raiser withdraws them (`waitsOn {device, cancel: true}`), when the raiser is gone for two sweeps, or after 7 days.

Out of scope: routing by "for urgent 1124" or "owner 01a20d4d" in a body.

### 9. No main is nudged while its Herdr pane is working

Every place sb wakes or nudges a main because it looks idle or stale now skips a main whose Herdr pane shows `agent_status` `working`. Board idle time alone is no signal.

- **`capacity stale`** (`src/capacity.ts` `staleOf`): never for a main whose pane is working, on an unattended device and elsewhere. `mainFacts` carries the pane's status (`paneStatus`). The device row's stale mark follows, and so does `board_read`'s, which the row replaces.
- **The auto watch** (`src/server/autowatch.ts` `factsOf`): an idle main it lists is never one whose pane is working (the watch reads the panes beside the net, `workingOf`) or one that runs a monitor. The notice's runbook, not a standing prompt, says: "A main not listed idle is working or runs something: ask it nothing." The longer runbook overran the notice's 6,000 characters when lines were cut, because the cut kept 40 characters of room for a line of about 60. The cut now keeps room for that line's own length.
- **The standing heartbeat and the 30-minute nudge** (`src/wrapup.ts`) were already right: both fire only when the session's own `ctx.isIdle()` holds, with no message queued, and nothing running (a dialog, a monitor, a loop, a watch, a subagent, a blocked pane). Unchanged, apart from F002 below.
- **`standing.md`**: the capacity line says to wake or ask only a main whose Herdr pane is idle (a working one is moving).
- **Not changed:**
  - `under` and `under-30m` ask a main to dispatch because it has ready todos and the device has room, not because it looks idle. Its copy reaches a busy session queued.
  - `boss_watch`'s `idle` answers the watcher's own request, and `standing.md` now limits what that watcher may wake.

### The review's P3s (standing-review on T4)

- **F001.** A standing main that a Herdr restart resumes now gets the revive's and the successor's re-arm text, `Straw Boss: a Herdr restart resumed this standing main. <REARM_TEXT>`, in a `straw-boss-arm` message, once the restore makes it the tab's main again. It comes whether or not it had subagents (`src/session.ts`). The subagent message of `restored.ts` is unchanged.
- **F002.** A watch list that does not answer (the sb server down, or no server) counts as something armed for the standing heartbeat, so it waits for a list that answers. The coordinator's nudge and `boss_wrap` are unchanged.
- **F003.** An ally's paused main is keyed by device and entry (`<device>:<entry>`), not by team, so a box in two teams is told once as `quota` and once as `resumed`. Marks already on disk under the old key may tell a pause that is still running once more after the upgrade.

### Sizes (measured)

| | before | after |
|---|---|---|
| sb's tools, trimmed / all | 7,443 / 10,771 | 7,473 / 10,801 (+30: `linkWait` `note`, `message` naming it, `standing`'s note clause in place of its `waitsOn` one) |
| `standing.md` | 2,169 characters, 12 lines | 2,296, 12 lines |
| `src/session.ts` / `src/wrapup.ts` lines | 405 / 155 | 408 / 156 |
| caps features | 11 | 12 (`tower.note`) |
