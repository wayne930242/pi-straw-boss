# A standing main's own prompt and wake rules (2026-11-26)

Status: implemented, not yet released (planned for 0.93.0). Follows [just-in-time prompts](2026-11-26-just-in-time-prompts.md). Tests: `tests/duty-prompts.test.ts`, `tests/duty-session.test.ts`, `tests/wrapup.test.ts`, `tests/revive.test.ts`, `tests/watch-link.test.ts`, `tests/capwatch.test.ts`, `tests/link-capacity.test.ts`, `tests/tools-budget.test.ts`.

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
