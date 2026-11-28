# A snoozable stale reminder (2026-11-28)

Status: built on `feat/snooze` (base `main` 4655637f, 0.113.2), not released; a reviewer is paired because this changes the main contract. The behavior is in [how-it-works, Device capacity](../how-it-works.md#device-capacity). It changes the `stale` flag of [capacity](2026-11-24-capacity.md).

## Boss words (binding)

> 「sb 的閒置提醒，改成可延後」

> 「30 分鐘做一次 warm up（如果 todo 還沒清理，就會提醒、並且可以標注延時提醒）」

pi-anchorloop's loop book, removed in its 3.0.0, reminded a session of its open todos and let a todo be deferred with a follow-up. The `capacity stale` notice is sb's reminder of that kind, and this record makes it snoozable.

## The problem

Today a main with open todos and nothing moving for 120 minutes (30 on an unattended device) gets one `capacity stale` notice (`… no move for 120+ min · …` plus "dispatch its ready work now, or say why not … on your board with board_set"), and no second one until the stale episode ends. The notice names no todo, the 120 and 30 minutes are constants, and a main has no way to say "remind me later": it can only defer a todo with `metadata.until` or `metadata.waitsOn`, and a running `boss_watch` silences it for the watch's whole life (up to 48 hours), well past the change it waited for.

## Decisions

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| SZ-D1 | Which reminder? | The capacity `stale` notice (`src/server/capwatch.ts`). The idle wrap-up nudge (`src/idlewake.ts`, [idle wrap-up](2026-11-25-idle-wrap-up.md)) is another reminder and is not changed. | The brief | grounded |
| SZ-D2 | The interval's key | `capacity.staleMinutes` (an attended device, default 120) and `capacity.staleUnattendedMinutes` (an unattended device, default 30) in `<state dir>/config.json`: whole minutes, 1 to 1440; anything else keeps the default. Read at each look of the server, as `capacity.budget` is. The defaults are today's, so nothing changes until the boss sets one; his example of 30 minutes is `"staleMinutes": 30`. | The brief ("keep the current default"); `capacity.budget`, `stallWatch.*Minutes` | grounded |
| SZ-D3 | Does an unanswered reminder come back? | Yes: while a stale episode lasts, the main is told again each interval after its last notice; only the first of an episode also goes to its tower and the standing main, the repeats to the main alone. Today's "once per episode" would leave nothing to snooze. | 「30 分鐘做一次 warm up（如果 todo 還沒清理，就會提醒…）」 | grounded |
| SZ-D4 | How does a main snooze? | `board_set { snooze: { why, for?, watch?, todo? } }`: `why` 1 to 120 characters; `for` a length (`30m`, `2h`, 1 minute to 24 hours); `watch` the key of one of the main's own `boss_watch` watches, until its next change; `todo` the id of one open todo, else the whole main. `for` or `watch` is required; with both it ends at whichever comes first; `watch` alone ends 24 hours after at the latest. One snooze for the whole main and one per todo, at most 20: a new one replaces the one of the same scope. | The brief (reuse `board_set`, `boss_watch`) | grounded |
| SZ-D5 | Which events? | What `boss_watch` reports: a unit's change of state (a main, a subagent, a monitor), a train's step (its landing included), a teammate device's link wait (opened, answered, closed), offline, and the watch's end. A wait card for the boss stays a todo with `metadata.waitsOn` (the boss), as today. | `WATCH_DESCRIPTION` (`src/bosswatch.ts`) | grounded |
| SZ-D6 | `metadata.waitsOn` and `metadata.until` | Unchanged: a todo deferred with either is answered (neither stale nor ready) on today's terms, and the ledger shows it as ⏸. A board_set snooze is for the reminder only: a snoozed todo stays ready for the `under` notice. | The brief ("a todo marked waiting with a reason counts as answered"); [capacity](2026-11-24-capacity.md) | grounded |
| SZ-D7 | A running `boss_watch` | Narrowed: a watch silences the stale reminder from its start until its first change reaches the main, not for its whole life. Otherwise a snooze "until the watched unit changes" would end and the watch would still hold the reminder off for up to 48 hours. A main that keeps waiting after the change snoozes again on the same key (or restarts the watch). A running monitor in the main's pane and an active loop still silence it, as today. | SZ-D4, SZ-D5 | grounded |
| SZ-D8 | A snooze that ends | The reminder is due at the next look when the main has not moved since the snooze ended, without waiting out a new interval; else the interval runs from its last move. Every snooze ends: by its time, by its watch's next change, or 24 hours after it was set. | The brief ("a snooze that expires reminds again") | grounded |
| SZ-D9 | Auto mode, a standing main | Kept as they are today. The stale reminder has no auto-mode rule: under auto mode it comes as it does without it (the wrap-up nudge is the reminder that stops then). A standing main is never stale on an attended device; on an unattended device the 30-minute rule applies to it as to any main, and its watches, monitors and loops usually hold it. | `staleOf` (`src/capacity.ts`), `src/idlewake.ts` | grounded |
| SZ-D10 | Where a snooze shows | On the main's row: `board_read` (`snoozed`, not in a teammate's remote turn), `/boss board`, and the head page's board fold, in both languages. It stays on this computer: no wire field, no ally board. | The brief | grounded |

## Behavior

### When a main is stale

A main is stale when all of the following hold (the rest of [capacity's flag table](2026-11-24-capacity.md#flags) is unchanged):

1. It is not paused, its Herdr pane is not working, no monitor runs in its pane, no loop of its session is active, and none of its `boss_watch` watches is still waiting for its first change (SZ-D7).
2. It has no active snooze for the whole main.
3. It has at least one **unanswered** open todo: not deferred by a future `metadata.until` or by `metadata.waitsOn`, and not snoozed on its own.
4. It moves nothing, by today's rule: on an unattended device it runs no worker, train, or points; elsewhere it is idle, commands nothing, and is not standing.
5. Either its last move is older than the interval (SZ-D2; on an unattended device the last write of its session file or board entry, elsewhere its board entry), or a snooze of it ended after its last move (SZ-D8; a move is the later of the two writes on either device).

A main whose session runs an older build writes no todo list to its capacity file; for it, item 3 is today's count of open todos against their deadlines.

### The notice

The stale notice names the unanswered todos, at most three by id and subject (cut to 60 characters), then the count of the rest:

```text
capacity stale · main "api" · 2 open todos unanswered: #3 "deploy the api", #5 "review the docs" · no move for 124 min · state of the device: capacity 0 / 4 pts · load 0.2 / 8 cores · ready 2
```

After a snooze ended, the reason comes first: `capacity stale · main "api" · its snooze ended at 14:30 ("CI runs") · 1 open todo unanswered: #3 "deploy the api" · no move for 31 min · …`.

The main's own copy ends with today's hint and, in the same line, the snooze:

```text
· your work: dispatch its ready work now, or say why not (blocked, shared files, the boss) on your board with board_set, and reply to whoever asked · or snooze this reminder: board_set {snooze: {why, for: "30m"}}; watch: <your boss_watch key> waits for its next change, todo: <id> snoozes one todo
```

A held box's copy keeps its held hint, followed by the same snooze clause. The tower's and the standing main's copies carry no snooze clause: they cannot snooze another main's reminder.

### Repeats and routing

- The first notice of a stale episode goes as today: to the tower that hears of the main's workspace, this device's standing main, and the main itself unless its pane is working.
- While the episode lasts, the main alone is told again each interval after its last notice (SZ-D3). The marks (`episode:stale:<session>`, its last notice's time) live in `capacity/_sent.json`, so a restart neither repeats nor drops one.
- An episode ends when the main is no longer stale (it moved, answered, or snoozed). A snooze that ended starts a new episode, keyed by the time it ended, so the throttle of the last notice does not hold it back. The throttle of the stale flag is the interval (today 30 minutes for every flag).

### `board_set` snooze

`board_set { snooze: {…} }` takes no `now`, `items`, `auto`, or `clear`, and only a tab's main calls it. It is checked in this order: `why`; `for` (a length the `boss_watch` lengths are written in, at least 1 minute, at most 24 hours); `watch` (1 to 200 characters, and one of this session's own watches on the sb server, else refused with "start boss_watch on it first"); `todo` (an open todo of this session's list). The answer says when it ends and that a new snooze of the same scope replaces it: `Reminder snoozed until 14:30 ("CI runs"). If your open todos are still unanswered then, sb reminds you again; a new snooze of the main replaces this one.`; with `watch`: `… until watch train-a sends its next change (14:30 at the latest) …`; with `todo`: `Todo #3's reminder snoozed until 14:30 …`.

The main's own session keeps its snoozes in its capacity file (`snoozes`, beside the pause; local only), kept across a `/reload`, gone with the session's quit. A todo's snooze goes when the todo is completed or deleted, and a snooze whose time has passed goes at the main's next turn.

### Where it shows

- `board_read`: a local row gets `snoozed: [{ todo?, until, watch?, why }]` (ISO `until`) for its active snoozes; none in a teammate's remote turn.
- `/boss board`: `snoozed until 14:30: CI runs` on the row, and `#3 snoozed until train-a changes: lands next` for a todo.
- The head page's board fold: the same text on the row, in English or Traditional Chinese (`提醒延到 14:30：CI runs`, `#3 提醒延到 train-a 有變化：lands next`).

## Design

- `src/snooze.ts` (new): the `Snooze` shape (`{ at, why, until, todo?, watch? }`, `until` always set: `at + for`, else `at + 24 h`), the check of `board_set`'s input, the replace rule, the file reader, and the end of a snooze (`snoozeEnd`: its `until` when that has passed, else the time of its watch's first line after `at`, else `at` when the watch is gone).
- `src/capacity.ts`: `MainCap` gains `todos` (the open todos: id, subject cut to 80, the deferral's end) and `snoozes`; `MainFacts` gains `watches` (each with when it started and when its last line reached the main); `staleOf` takes the intervals and returns the same boolean, `staleFacts` the details; `MainRow` gains the unanswered todos, the last move, the snooze end that woke it, and the active snoozes (the local `_device.json` only, never on the wire, like `workers`); `readStale` reads the two keys; `snoozeLine` and `snoozeSaid` are the English texts.
- `src/capfill.ts`: keeps the snoozes, writes `todos`, prunes the snoozes, and answers `board_set` (`snooze`).
- `src/server/watches.ts`: `facts(session)` lists each watch's `added` and `told.at`; `src/server/capops.ts` puts them on the main's facts in place of the boolean `watching`.
- `src/server/capwatch.ts`: the repeat, the woken episode's tag, the interval as the stale throttle, and the snooze clause on the main's copy (`SNOOZE_HINT`, `src/moments.ts`).
- `src/tools.ts` (`board_set`'s `snooze`, handed to `capfill.ts`), `src/boardread.ts`, `src/boardview.ts`, `gui/board.ts` (`snoozeText`, a span of its own on every view, since Geek alone shows the capacity span), `gui/messages/*.json`, and `gui/demo-board.ts` (web-new's two snoozes).

Rejected: a new tool `boss_snooze` (another tool on every turn, for what `board_set` already frames as "say why not on your board"); writing the snooze into the todo's own metadata (sb cannot edit the ledger of a session, and `metadata.until` with `metadata.waitsOn` already means "waits on that person even after the date"); ending a snooze from the watch line in the main's session (the server already knows when each watch's line was taken, and keeps it across a restart in `watches.json`).

## Tests

`tests/snooze.test.ts` (the input check, the replace rule, `snoozeEnd`, the texts), `tests/capacity.test.ts` (the intervals from config, unanswered todos, a snooze of the main or of a todo, a watch until its first change, the woken rule), `tests/capwatch.test.ts` (the repeat to the main alone each interval, across a restart; a snooze that ends reminds at the next look; the notice names the todos), `tests/capfill.test.ts` (`todos`, the snooze kept across a reload, pruned), `tests/capops.test.ts` (the snooze clause on the main's copy only), `tests/capacity-board.test.ts` (`board_read`, `/boss board`), `tests/board-page.test.ts` (the row text in both languages), and `board_set`'s refusals.

## Limits

- A snooze is the reminder's only: a snoozed todo is still ready work for `under`. Defer it with `metadata.until` or `metadata.waitsOn` to take it out of both.
- The board's own stale rule (`/boss board` "idle over 2 h", Clear on the head page) keeps its 2 hours when no device row is fresh.
- A watch line held by the hourly cap (12 an hour) reaches the main as the summary; the snooze ends when that summary is taken.
