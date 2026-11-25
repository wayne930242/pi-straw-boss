# A main that handed over closes itself (2026-11-26)

Status: implemented, not yet released (planned for 0.93.0). Code: `src/rotclose.ts`, with the control channel's `took-over` in `src/closemain.ts`, the minute look in `src/wrapup.ts`, and `sb_handover_from` read in `src/session.ts`. Tests: `tests/rotation-close.test.ts`. The same round fixed two leftovers of the standing-prompt review (T5R-F002 and T5R-F003), listed at the end.

## Boss words (binding)

- 「我都授權發版」 (this sb round), and 「做完驗證完補一輪重構就可以自己發版和安裝，我要先睡了」.
- 「herdr state 還在 working 的 agent 不必被詢問」 (2026-11-26, 01:0x).
- The request, relayed by the old skald DnD main (01a20411) on 2026-11-26 at 02:19: after a rotation the old main cannot close itself or its pane. `boss_wrap` is refused under auto mode and needs the boss's yes, pi-session-doctor forbids `/new`, no other tool closes a session, and a child's result still goes to the old session, so it had to stay open to forward it. The boss asks: once the successor confirms the takeover and the old session runs no child, monitor, or loop, can sb close the old session and its pane by itself, under auto mode too? Or pi-session-doctor could rotate through `boss_handover` and hand the children to the successor.

## Decisions

1. **The rotation is the consent.** No one is asked: not the boss, and not the tower. The close takes the path `/boss close` takes (`closeSelf`): pi quits, and then its pane closes, with an emptied tab.
2. **The signal is code, not prose.** The successor's first prompt already asks it to tell the old main by intercom (`send`, to its session id). The successor's extension sees that call as a tool result (`intercom`, `send` or `ask`, `to` the id in its pane's `sb_handover_from`, no error) and sends `took-over` to the old main over `straw-boss/control`. The old main accepts it only from the session its own `successor` entry names, and records `took` in that entry, so a `/reload` keeps it. The successor stops sending once one was accepted. If it got no answer (an older build, or no channel), it sends again at its next such send. With no signal, nothing closes: the tower's close and the boss's close work as before.
3. **Only when nothing runs.** The old main checks once a minute, in the wrap-up look. It closes only if no turn is running, no message waits in its queue, and no dialog, monitor, loop, watch, or subagent runs; a pane Herdr shows blocked also counts as running. The check is wrap-up's `running`. A watch list that does not answer does not hold the close.
4. **A child's result goes on.** After the takeover, a `subagent_result` that reaches the old main goes to the successor by intercom. It is quoted as the child's result, not the boss's words. The old main's model sees the result too, and its handover result said that sb forwards it.
5. **Six hours, then the tower.** If something still runs 6 hours after the takeover, sb stops waiting. It tells the workspace's tower once (`call_tower`, `why: blocked`) and closes nothing; from then on the tower or the boss closes the old main.
6. **The board entry goes.** It is cleared before the close, since the successor holds the work.
7. **Not changed.** A coordinator that never handed over gets its idle nudge as before. The tower's milestone at the handover still names both sessions, and it says the old main closes itself. A tower may still close it with `boss_close_main` if it is still open.

## pi-session-doctor

pi-session-doctor is the user's own package (`npm:pi-session-doctor@0.1.0`, repository wayne930242/pi-session-doctor, checked out at `~/projects/pi-session-doctor`). It lives outside this repository, so this round did not change it. Its nudge (`nudgePrompt` in `src/index.ts`) says to write `scratch/handoff-<name>.md` and then "tell the boss or the tower that the handoff is ready and ask them to start a new session from it". To rotate through `boss_handover` it needs one bounded change. When the session has the tool (`pi.getAllTools()` lists `boss_handover`), step 2 would read: "call `boss_handover` with that handoff file and the reason; it opens your successor, and sb closes this session once the successor took over". Without the tool, the step stays as it is. The session-rotation rule in `~/.pi/agent/rules/session-rotation.md` would say the same. Children are not re-parented: a child's result is forwarded (decision 4), which covers the case the request named.

## T5R-F002: a note on a wait reaches someone

A note (a notice about a wait this computer raised) was filed in that wait's workspace. When neither the raiser nor a standing main was live there, nobody was told. Now such a note goes to a standing main of the workspace the message arrived in, as a note that names no wait would; there it is a plain notice, which that main reads and closes. With no standing main there either, the tower of the wait's workspace gets a notice that quotes the note as the teammate's words, and the note closes. A workspace whose tower the server does not run keeps the note open for the next sweep. A notice about no wait still reaches nobody when no standing main is live (D12).

## T5R-F003: the remaining asks of a working pane

- `capacity under`: the main's own copy is not sent while its Herdr pane is working. Its tower and the standing main still get theirs, since they may move the work elsewhere.
- `capacity under-30m` ends with `its pane is working now: ask it nothing` instead of `ask it to dispatch or say why`, and `tower-run.md` asks no main whose pane is working.
- The `stale` mark (`joinLocal`, in the tower's brief and in `board_read`) is not shown while the main's pane is working, even when the broker calls the main idle.
