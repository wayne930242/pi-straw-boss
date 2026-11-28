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
5. Either its last move is older than the interval (SZ-D2; on an unattended device the last write of its session file or board entry, elsewhere its board entry), or a snooze of it ended after its last move (SZ-D8; a move is the later of the two writes on either device). The session file counts by its newest entry that is not the main's taking of a stale notice (review r2-F003, below).

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
- An episode is the main's last move (the later of its own move in its session file and its board entry's write) and its open todos (their ids and deferrals, as one number): each notice records both (`notice:`, `notice-moved:`, `notice-todos:` in `capacity/_sent.json`, kept while the main is live, or a day). A stale main whose move and todos are as its last notice recorded is in the same episode, however many looks in between saw it not stale (a monitor that ran a minute, a pane that worked on the notice): the main alone is told again each interval after that notice (SZ-D3). A move, an answered or new todo, ends it, and the next notice is a first one again. The marks outlive a restart, so it neither repeats nor drops one (review r2-F002).
- A snooze that ended starts a new episode once, keyed by the snooze's identity (its main, its scope, and when it was set; `wake:`): told as a first notice at once, with a tag of its own, so the throttle of the last notice does not hold it back. Once told, that wake routes nothing: a later episode of the unchanged main is the same episode, the main's alone (r2-F002). The end the server first sees of a snooze is kept (`snooze-end:`, while the main's file holds the snooze): a later watch line, the snooze's own time, and a restart do not move it (review F001). The throttle of the stale flag is the interval.
- Taking a notice is no move (review F005, r2-F003): the server reads the end of the main's session file (`src/server/worked.ts`, 256 KB, again only when its time moved) for its own move, the newest entry that is not the notice's delivery. The delivery is the notice's own entry (an `intercom_message` from the server's intercom id whose text is the code-written header with `kind=capacity_notice` and a `capacity stale` line), pi-intercom's wake prompt, and what the main writes in that turn before it calls a tool or real input comes. Real input is a user message other than the wake prompt, or an intercom message that is not the server's notice; an extension's context (`claude-hook-context` and other custom messages) is none (r3-F003). A tool call in the turn is work, and so is anything after real input. No time window: real work a minute after a notice resets the clock. A tail that holds no move (a large entry pushed the move out) keeps the move the reader knew before the append; after a restart the watch takes the move its episode was told with (`notice-moved:`). A recognised notice never stands in for a move (r3-F002).
- A main whose Herdr pane is working is never stale, on its own rule: no episode mark changes it.

### `board_set` snooze

`board_set { snooze: {…} }` takes no `now`, `items`, `auto`, or `clear`, and only a tab's main calls it. Before anything, it asks the sb server of its Herdr slot for this session's watches; the reply says whether that server runs the stale reminder (`snoozes: true` on the primary server, which runs the capacity watch; `false` on the server of another Herdr slot, which runs none: r2-F004). With no answer, from a server that runs no reminder, or from an older server (no `snoozes`), it keeps nothing and says which (review F003). After the answer, the session and its role are checked again: a session replaced or a main demoted while it waited writes nothing (r2-F005). A capacity file that cannot be written is refused with the error, and the snooze is not kept (F004); the background refreshes stay best-effort. It is checked in this order: `why`; `for` (a length the `boss_watch` lengths are written in, at least 1 minute, at most 24 hours); `watch` (1 to 200 characters, and one of this session's own watches on the sb server, else refused with "start boss_watch on it first"); `todo` (an open todo of this session's list, all of it: the capacity file lists every open todo, and the stale verdict reads them all; only the notice names three, review F006). The list is the whole ledger (`capTasksOf` in `src/capacity.ts`), read apart from the board's display parser, which keeps a ledger's first 200 records: 200 completed todos before a pending one hid it (r2-F001). Past 5,000 open todos the file lists 5,000 and keeps the count in `open`, and a todo snoozed on its own is always among the 5,000 (r3-F004); the reader keeps the count too, and the todos it could not list are unanswered work, never "no work". The answer says when it ends and that a new snooze of the same scope replaces it: `Reminder snoozed until 14:30 ("CI runs"). If your open todos are still unanswered then, sb reminds you again; a new snooze of the main replaces this one.`; with `watch`: `… until watch train-a sends its next change (14:30 at the latest) …`; with `todo`: `Todo #3's reminder snoozed until 14:30 …`.

The main's own session keeps its snoozes in its capacity file (`snoozes`, beside the pause; local only), kept across a `/reload`, gone with the session's quit. A todo's snooze goes when the todo is completed or deleted, and a snooze whose time has passed goes at the main's next turn.

### Where it shows

- `board_read`: a local row gets `snoozed: [{ todo?, until, watch?, why }]` (ISO `until`) for its active snoozes; none in a teammate's remote turn.
- `/boss board`: `snoozed until 14:30: CI runs` on the row, and `#3 snoozed until train-a changes: lands next` for a todo.
- The head page's board fold: the same text on the row, in English or Traditional Chinese (`提醒延到 14:30：CI runs`, `#3 提醒延到 train-a 有變化：lands next`).

## Design

- `src/snooze.ts` (new): the `Snooze` shape (`{ at, why, until, todo?, watch? }`, `until` always set: `at + for`, else `at + 24 h`), the check of `board_set`'s input, the replace rule, the file reader, and the end of a snooze (`snoozeEnd`: its `until` when that has passed, else the time of its watch's first line after `at`, else when the watch ended, which the server keeps a day (review F002), else `at` when the server knows the watch no longer).
- `src/capacity.ts`: `MainCap` gains `todos` (the open todos: id, subject cut to 80, the deferral's end) and `snoozes`; `MainFacts` gains `watches` (each with when it started and when its last line reached the main); `staleOf` takes the intervals and returns the same boolean, `staleFacts` the details; `MainRow` gains the unanswered todos, the last move, the snooze end that woke it, and the active snoozes (the local `_device.json` only, never on the wire, like `workers`); `readStale` reads the two keys; `snoozeLine` and `snoozeSaid` are the English texts.
- `src/capfill.ts`: keeps the snoozes, writes `todos` and the counts from the whole ledger (`capTasksOf`), prunes the snoozes, and answers `board_set` (`snooze`).
- `src/server/watches.ts`: `facts(session)` lists each watch's `added` and `told.at`, and those that ended in the last day with their end, kept in `watches.json` (`ended`) for that day; `src/server/capops.ts` puts them on the main's facts in place of the boolean `watching`. `src/server/watchesops.ts` answers `watch-list` with `snoozes`, true on the primary slot alone.
- `src/server/worked.ts` (new): the main's own last move in its session file (`worked` on its facts), which the stale verdict counts in place of the file's time.
- `src/server/capwatch.ts`: the episode by move and todos, the repeat, the wake's tag once, the interval as the stale throttle, and the snooze clause on the main's copy (`SNOOZE_HINT`, `src/moments.ts`).
- `src/tools.ts` (`board_set`'s `snooze`, handed to `capfill.ts`), `src/boardread.ts`, `src/boardview.ts`, `gui/board.ts` (`snoozeText`, a span of its own on every view, since Geek alone shows the capacity span), `gui/messages/*.json`, and `gui/demo-board.ts` (web-new's two snoozes).

Rejected: a new tool `boss_snooze` (another tool on every turn, for what `board_set` already frames as "say why not on your board"); writing the snooze into the todo's own metadata (sb cannot edit the ledger of a session, and `metadata.until` with `metadata.waitsOn` already means "waits on that person even after the date"); ending a snooze from the watch line in the main's session (the server already knows when each watch's line was taken, and keeps it across a restart in `watches.json`).

## Second review (snooze-review2)

The brief of the fix round: where a heuristic needs more patching than a simpler design, take the simpler design.

- **r2-F001 (P1).** Capacity read the list through the board's display parser (`todosOf`, 200 records), so a long ledger hid its open todos. It now has its own projection of the whole ledger (`capTasksOf`, and `todoDeadlines` over every record), and an overflow is counted as work.
- **r2-F002 and r2-F003, one design.** The first round patched two heuristics: an episode ended whenever one look saw the main not stale, and a 5-minute window after a notice discounted the session file's writes. Both are gone. An episode is now what the main did, its move and its open todos, recorded at each notice, so a look in between ends nothing; and the move is read from the session file's entries, where the delivery is told apart by what it is (the server's own message and the text-only answer), not by when it came. The working pane is a guard of its own again. Simpler, and it covers both findings: no rebroadcast for an unchanged main, and real work after a notice resets the clock.
- **r2-F004.** `snoozes` moved from the watches to the route, which knows its slot: true on the primary alone, false elsewhere, absent on an older build.
- **r2-F005.** The session and the role are checked again after the server's answer.
- **r2-F006.** The ended watches are kept in `watches.json` for a day. Simpler than tracking which ends the capacity watch has consumed: no snooze lasts longer than 24 hours, and the capacity watch keeps the first end it sees (`snooze-end:`) anyway.

## Third review (snooze-review3)

- **r3-F001 (P1).** The board's auto line read `done (200/200)` for 200 completed todos and one pending past its 200 rows; the board purged the line after 30 minutes, and the attended check, which counts the entry's time, had nothing. The line now asks the whole ledger whether the list is done (`moreOf` in `src/boardauto.ts`: the first open todo past the display, written as `next <subject>` with no done count), without expanding the display. And an attended main with open work and no board entry counts its last move, so it is never without a reminder.
- **r3-F002.** The session-file reader keeps the last move it knew across an append whose tail holds none, and the watch takes the episode's `notice-moved:` after a restart; a notice's time is never a move.
- **r3-F003.** Only real input or a tool call ends the turn's discount; an extension's custom message does not.
- **r3-F004.** A todo snoozed on its own stays inside the 5,000 the file lists.

## Performance

The boss asked for it with the third review (「也要注意一下效能問題」). Nothing new runs more often than the watch's minute per main, and nothing reads a whole file:

- The server's minute: a session file is read again (its last 256 KiB) only when its time or size moved (`createWorked`); a capacity file is parsed again only when its time, size, or inode moved (`readCaps`; a write renames a new file in), and the open todos' key is hashed once per reading (`todosKey`).
- The session's refresh, at each tool call: the whole ledger is projected again only when the todo snapshot changed (`snapshotScan` hands back the same one until a todo write), or a todo snooze changed what the bound keeps.
- `node scripts/bench-captick.ts [mains] [ticks]` measures a tick with a 50,000-record ledger and a 128 MiB session file per main. On this Mac, 20 mains: before, 70 ms a tick with nothing changed (cold 88 ms); after, 1.8 ms (cold 76 ms). Projecting the ledger once takes about 17 ms.

## Tests

`tests/snooze.test.ts` (the input check, the replace rule, `snoozeEnd`, the texts), `tests/capacity.test.ts` (the intervals from config, unanswered todos, a snooze of the main or of a todo, a watch until its first change, the woken rule), `tests/capwatch.test.ts` (the repeat to the main alone each interval, across a restart; a snooze that ends reminds at the next look; the notice names the todos), `tests/capfill.test.ts` (`todos`, the snooze kept across a reload, pruned), `tests/capops.test.ts` (the snooze clause on the main's copy only, `worked` on the facts), `tests/worked.test.ts` (the delivery and the text answer are no move, a tool call or a later input is), `tests/snooze-r3.test.ts` (the third review's four findings), `tests/watches.test.ts` (an ended watch across a restart), `tests/watch-read.test.ts` (`snoozes` by slot), `tests/capacity-board.test.ts` (`board_read`, `/boss board`), `tests/board-page.test.ts` (the row text in both languages), and `board_set`'s refusals.

## Limits

- A snooze is the reminder's only: a snoozed todo is still ready work for `under`. Defer it with `metadata.until` or `metadata.waitsOn` to take it out of both.
- The board's own stale rule (`/boss board` "idle over 2 h", Clear on the head page) keeps its 2 hours when no device row is fresh.
- A watch line held by the hourly cap (12 an hour) reaches the main as the summary; the snooze ends when that summary is taken.
