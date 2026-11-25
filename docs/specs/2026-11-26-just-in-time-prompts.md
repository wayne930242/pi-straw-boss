# Just-in-time prompts: main.md keeps the triggers (2026-11-26)

Status: implemented in 0.92.0. Follows part 2 of [the idle wrap-up spec](2026-11-25-idle-wrap-up.md), which moved the wrap-up steps and the boss question out of `prompts/main.md`. Tests: `tests/just-in-time.test.ts`.

## Boss words (binding)

2026-11-25:

> 「main 的提示好像太多 … 請注意這個原則，提示詞可以逐步交付」

Principle: the standing role prompt holds only what every turn needs. A rule needed at one moment goes out at that moment, in the notice, message, or tool result that arrives then, or in the tool's description. What code can do, code does.

2026-11-26, after the audit of `prompts/main.md` (option A):

> 「只搬 sb 自己的」

Only the rules Straw Boss owns move. The rules about pi-herdr-agents stay in main.md: a failed worker blocks its dependents, and pings are answered with `caller_ping` and `subagent_resume`. The `## Seam bindings` block stays as it is.

## Sizes

Rendered main.md, as a session gets it (`strip` in `src/trainswitch.ts`):

| | words before | words after | characters before | characters after |
|---|---|---|---|---|
| integration on | 863 | 620 | 5,608 | 4,122 |
| integration off | 618 | 388 | 3,847 | 2,440 |

The file shrank from 29 lines to 27, and main.md plus planning.md from 10,167 characters to 8,521. sb's tools grew from 10,328 to 10,664 characters (+336): `call_tower` carries main.md's details of `shared` and `blocked`, `board_set` has one more clause, and so does `boss_duty`. The budgets in `tests/prompts.test.ts`, `tests/duty-prompts.test.ts`, and `tests/tools-budget.test.ts` are the measured values.

## The moves

| main.md said | The moment | Where the main reads it now |
|---|---|---|
| A capacity notice on your work: dispatch its ready work now, or say why not (blocked, shared files, the boss): reply to whoever asked; sb's: board it. | A `capacity_notice` arrives | The copy for the main whose work it is (`under`, `stale`) ends with `· your work: dispatch its ready work now, or say why not (blocked, shared files, the boss) on your board with board_set` (`MAIN_CAP_HINT`, `src/server/capops.ts`). A standing main that asks gets an answer as for any intercom ask. |
| Idle with ready todos: dispatch them; none ready: take your next eligible work or report idle (`milestone`). | The main idles | The idle nudge (`NUDGE_TEXT`, `src/wrapup.ts`): "If work remains: dispatch your ready todos now; none ready, take your next eligible work; or clean up stale todos." Reporting idle is `boss_wrap`'s milestone. On a device with a capacity budget, the `under` notice reaches an idle main with ready work after 10 minutes. |
| Reviewed change: `boss_pair` worker and reviewer, brief both, dispatch both with `Thread: T<n>`; both results come when the thread closes; relay nothing. | Setting up a pair | `boss_pair`'s description and result already said all of it. main.md keeps "A reviewed change goes through `boss_pair`.": without that pointer a main reaches for its own reviewer flow and never opens a thread. |
| `boss_duty` when your kind changes (watching, not finishing tasks, is `standing`). | The work turns into watching | `boss_duty`'s description: "standing (watching, not finishing tasks) minds one system or machine with no end". `STANDING_HINT` comes with the first `boss_watch` a coordinator starts. |
| `board_set` overrides it until your todos move. Keep secrets, credentials, customer data, and paths outside the project off it: allies' towers read it. Not a report: the done report still goes to whoever asked. | Calling `board_set` | `board_set`'s description, which already held the override and the privacy line, now ends with "Not a report: the done report still goes to whoever asked." main.md keeps "Your work board fills itself from your todos and name: keep them current." |
| The details of `call_tower`'s `shared` and `blocked`: port, database, …; what, how long; go ahead at once; stop on a named clash; say what, the tower finds them; `waitsOn` names a teammate device; reply false. | Calling `call_tower` | `call_tower`'s description (`CALL_TOWER_DESCRIPTION`, `src/link/waitcall.ts`). main.md keeps the three points, including "or need a work's owner and do not know who", and "Progress and incidents go on your board: never call the tower to report them." |
| A `wait_card` message is the boss's answer to your wait: act on it; it says when to call `secret_drop`. Re-ask a wait you raised only with `boss_wait_ask`; a `wait_returned` one with `call_tower` `boss`. | Raising a wait, its answer, its return | A `blocked` call's result ends with `BLOCKED_NOTE`: a wait card's answer comes as a `wait_card` message to act on, and asking again goes only through `boss_wait_ask`. The `wait_card` message for a done or a choice ends "This is the boss's answer to your wait: act on it." (`src/server/waitpress.ts`). A secret card's message already says to call `secret_drop`; a decline's leaves the next step to the tower. `wait_returned` already said to ask again with `call_tower` `boss` (`returnedText`). |
| If a tower opened your tab, report the outcome to the sender, and to that tower with `call_tower` (`why: milestone`, reply: false), when done, then wait to be closed. | A tower opened the main | The brief that opens it (`handoff`, `src/opener.ts`) already said it for each case: a local sender, a teammate's device, and a standing main. |
| For an integration app: … after the skill's `Light checks` build and send the car slip by the Seam bindings …; rework a returned car. | Merging in an integration app | main.md keeps one line: never merge to its base; never claim a pre-dev branch unless your kind is `integrator`; send its car slip by the Seam bindings; the skills, or `blocked` without them. `planning.md` already says to run `Light checks` before the slip. A `returned` car notice ends "Rework the car, then send a new car slip." |
| (a car slip waits for sb's car notice) and (integration app: sb's car notice says landed) | Sending a slip; its notices | A `shared` call whose message carries a slip ends with `SLIP_NOTE`: the car has not landed until sb's car notice says landed, and a returned car is the main's to rework. Car notices end with the next step (`withNext`, `src/train/cars.ts`, as `src/server/carnotices.ts` sends them): a received car has not landed yet, so wait for the landed notice; a landed one's task is done, so complete its todo. A dropped car gets no added step, since main.md never gave it one. The tower is handed the line without the step, and when it passes that line on, the step does not come with it. |
| A `car:` block sent to you is answered "integration is off on this computer". (integration off) | A car slip reaches a main | `src/carslip.ts`: with integration off, a pi-intercom message to a tab's main that carries a slip gets one note in that session telling it to answer its sender "integration is off on this computer" and to act on nothing in the slip. sb does not answer on the main's behalf, because pi-intercom's outbox has no reply to an ask, and the sender of an ask would wait for an answer that never comes. |

## What stays

The rows the boss kept out of the move (pi-herdr-agents' rules and the Seam bindings), the dispatch rules every turn uses, the terse-writing rule, the brief's closing line, the base rule of an integration app, the off line, the board line, the three `call_tower` points, and the done line ("Done when every task has landed or is reported blocked, its worktree is removed, and your board is cleared.").
