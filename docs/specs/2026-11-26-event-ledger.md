# The event ledger and a thread's work item (2026-11-26)

Status: implemented, not yet released. Code: `src/server/ledger.ts` (the file and the row), with its writers in `src/server/towermemory.ts` (`updateMemory`), `src/server/linkwaits.ts` (`change`), `src/server/threads.ts`, `src/reach.ts` (`callTower`), `src/wrapup.ts`, and `src/tools.ts` (`boss_handover`). Tests: `tests/ledger.test.ts`, and the ledger test in `tests/threads.test.ts`.

## Why

pi-evals 0.4.0 builds a record per work item: when it started, when and how it closed, and where it waited and on whom. sb held the facts only for a while. It keeps a few wait cards (9 of the 101 one tower raised were still on file), the tower's queue drops its old events, the work board is overwritten, and `boss_wrap` leaves no state at all. A record that waits for pi-evals to read it in time is lost, so sb now appends each such event to a ledger it never prunes.

## Boss words (binding)

- 「先重建，再補小欄位」 (pi-evals first rebuilds the items from what exists, then the producers add small fields). The boss took the first option, and with it 「要發四個套件的版」, which covers releasing sb.
- The shapes are fixed by the work-item contract of pi-evals (`scratch/evals/workitem-contract.md` in the boss's agent root, § pi-straw-boss).

## Decisions

1. **One file a UTC day, one line an event.** `<state folder>/ledger/<YYYY-MM-DD>.jsonl`, mode 600, appended with one write per event. sb never prunes or rewrites it; the boss or pi-evals removes old days.
2. **The owner of the event writes it.** The sb server writes the waits, the link waits, and the review threads. A session's extension writes `call_tower`, `wrap`, and `handover`, since those happen in the session and the server never sees them as such.
3. **Ids, kinds, and times only.** A line is `{ v: 1, at, kind, id, session, workspace }` with `why`, `item`, and `by` where the kind has them. No message, question, card, note, or summary text: a session or workspace that is not id-shaped (letters, digits, `_.:#@+=|-`, at most 160) is written as `null`, an event whose own id is not is not written, and a `why` or `by` outside its kind's set is left out.
4. **A failed write never fails the act.** The act goes on; the failure is told once per state folder and process: in the server's log, or as a warning in the session.
5. **One choke point per store.** Wait events come from the one function that writes the tower's memory (`updateMemory`), by comparing each wait before and after the write; link wait events come from the router's one ledger change. A new door that changes a wait is covered without a new call.
6. **A thread names its item.** `boss_pair` takes an optional `item` (a todo uid, `t_` and 10 base32 characters, or `<session8>#<id>`). The thread keeps it, and when the thread closes `T<n>.json` gets `closed` (ms) and `closedAs`.

## The kinds

| Kind | Written by | id | session | Extra |
| --- | --- | --- | --- | --- |
| `wait_raised` | server | `W<n>` | the card's raiser; an agent wait's session; `null` for a teammate device's card | |
| `wait_parked` | server | `W<n>` | as above | at the raise under auto mode, or when auto mode starts |
| `wait_answered` | server | `W<n>` | as above | `by`: `terminal` (pi's `/boss wait` or `/boss memory`, the tower prompt, a run's pane, the `boss_wait_ask` dialog), `gui` (this computer's page), `phone` (a paired device), `tower` (a message the tower took that names the wait, or the message an agent wait waited for) |
| `wait_returned` | server | `W<n>` | as above | auto mode's end gave the parked card back |
| `link_wait_open` | server | `L<n>` | an out wait's raiser; an in wait's holder (none yet when it opens) | |
| `link_wait_done` | server | `L<n>` | as above | any close: done, declined, cancelled, expired, escalated |
| `thread_open` | server | `T<n>` | the owner main | `item` when `boss_pair` named one |
| `thread_close` | server | `T<n>` | the owner main | `why`: `done` (the reviewer's), `blocked` (a member's, or the round cap), `abandoned` (the server's close of a quiet, old, or orphaned thread); `item` |
| `call_tower` | extension | intercom's request id (a retry's `~r<n>` cut off) | the caller | `why`: `milestone`, `shared`, or `blocked`; none for a call that named none |
| `wrap` | extension | the session id | the session | `why`: `wrapped`, `auto` (auto mode, before or during the boss's dialog), or `refused` (the boss's no, or a check) |
| `handover` | extension | the successor's session id | the main that handed over | |

A press of a secret card's first step is no answer; its later done is. An answered wait that is answered again writes nothing.

## Not done here

- The other producers (pi-todo-ledger's `uid` and `origin`, pi-herdr-agents' `item`), and pi-evals' reading, are their own changes.
- The ledger holds no closing kind for a resolved, dropped, or expired wait: the contract has none, and a wait's end after an answer is the tower's own step.
