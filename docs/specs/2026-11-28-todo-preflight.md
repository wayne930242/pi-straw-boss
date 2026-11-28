# Todo preflight and run spend (2026-11-28)

Status: built on `feat/todo-preflight`, with pi-todo-ledger 0.9.0 for the spend; a reviewer is paired before release because the ledger's contract grows. The behavior is in [how-it-works, The subagent host](../how-it-works.md#the-subagent-host).

## Boss words (binding)

The boss picked both items on the 11/28 form: 「todo 驗收檢查」 and 「todo 記成本」.

## A. Preflight at dispatch

When a main dispatches for a todo (`subagent` with `item`, or `boss_pair` with `item`), sb looks at that todo before the call goes through. It is a static check of the list, in the manner of Archon's plan validation: it runs nothing.

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| P1 | What is read | The newest `todo/v1` snapshot of the launcher's branch, raw (tombstones included, every row), through an incremental branch scan (`snapshotScan`). The board's parser (`todosOf`) caps at 200 rows and drops tombstones, so it cannot see a deleted blocker or a row past 200. | items.ts, todo.ts | settled |
| P2 | Missing or vague anchor | A warning on the call's result, naming `todo update anchor`. sb removed hard dispatch gates in 0.83.0, so bookkeeping never refuses a launch. | brief; docs/specs/2026-11-23-lite-main.md §1 | settled |
| P3 | What counts as vague | An anchor with no command word at its start and nothing concrete in it (code, a path, a flag, a file name, a number, an address, a quote, a comparison) is vague when it is a known empty phrase (`tests pass`, `works`, `done`, `完成`, `測試通過`, ...) or shorter than four words (six CJK characters count as four). A sentence that says what is seen, such as "Credit notes round before tax", passes. | src/preflight.ts `anchorProblem` | settled |
| P4 | A `blockedBy` cycle | Refused, with the cycle's path: the todo can never become ready, and a worker on it starts work out of order. Only a cycle the todo still waits on counts, through blockers that are neither done nor deleted, as capacity counts readiness (a done blocker frees its todo whatever waits behind it, review F005); one elsewhere in the list is another launch's. The ledger refuses a cycle at `update`, so one comes only from an import or a hand edit. | brief; capacity.ts `capOfTodos` | settled |
| P5 | A deleted or unknown blocker | A warning: the dependency it records is gone. Capacity already treats such a blocker as blocking nothing, so the launch is not wrong, only the record. | capacity.ts `capOfTodos` | settled |
| P6 | An item that names no todo, or a deleted one | A warning: the ledger binds nothing to such a launch. A `<session8>#<id>` of another session is not judged; that session checks its own. | pi-todo-ledger CONTRACT.md "Optional Herdr launch identity" | settled |
| P7 | rpiv-todo lists | Only the graph is judged: rpiv-todo has no anchors. | | settled |
| P8 | Cost | The ceiling is the median per launch, in the process's CPU time, on a 5,000-row ledger with a new snapshot before each launch, read through pi's own `SessionManager.getBranch`: about 1 ms for a chain and for a dense graph of 12 blockers a todo (p95 1.4 to 4 ms, a rare GC pause up to 50 ms). Each snapshot is indexed once and each row's open blockers asked once (review F007). The test asserts the median ≤ 5 ms and reports the tail. | tests/preflight.test.ts | settled |

The `subagent` check runs first in the session's `tool_call` hook, before a bar from the net (a sub workspace's session dispatches too, review F006) and before the capacity cap reserves anything, so a refused launch holds no points. Its warnings wait for the call's result and ride on it once; a call the turn ended without a result leaves none behind. `boss_pair` checks before it asks the server for a thread, so a refused pair opens no thread.

## B. Run spend on the todo

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| S1 | Where the cost comes from | The child's own session file: pi writes each assistant turn's `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost.total`) and its `provider`/`model` there. sb had no child cost before; Maestro's result names `sessionFile` and `elapsed` (seconds) but no usage. | @earendil-works/pi-ai `Usage`; Maestro delivery.js | settled |
| S2 | Who records it | pi-todo-ledger (0.9.0), the list's one writer. It already binds launches to todos (`metadata.herdr`), resumes by session path included, so it resolves the todo of a result the same way and writes through its normal guarded update. sb reads the record only. | pi-todo-ledger herdr-owner.ts | settled |
| S3 | The shape | `metadata.herdr.spend`: totals (`input`, `output`, `cacheRead`, `cacheWrite`, `tokens`, `cost`, `ms`, `runs`, `models`) and up to twelve `sessions` with each one's last figures. Additive within `todo/v1`: `metadata` is free-form, and a later launch keeps `spend` when it rebinds `metadata.herdr`. | pi-todo-ledger CONTRACT.md "Run spend" | settled |
| S4 | Resumes | A resume continues the same session file, so a session's figures are replaced by the file's newest total, never added twice; wall time adds each result's `elapsed`. A `subagent_ping` (the run stopped to ask) counts a run and its tokens so far. | | settled |
| S5 | What sb shows | The session page's todo detail line (`Spent: … tokens · $… · … · N runs · models`); totals only, never the session paths. An older ledger records nothing, and nothing shows: no version check is needed, since the reader takes the field only when it is there and well formed. | src/items.ts, gui/bars.ts | settled |
| S6 | Ends the model never reads, and a ping's time | sb's host (src/host/run-end.ts, in front of Maestro, which is not changed) notes each launch and resume it acknowledged, and as an end goes out adds the run id and, on a ping, the elapsed since the run started (Maestro's registry `startTime`) to its details, then sends `subagent:run-end` `{ v: 1, id, kind, name, item?, sessionFile, elapsed }` on pi.events. The ledger counts an end by either, once by its run id (`spend.ended`), so a steer cleared before the turn is still spent and a ping's first segment is timed. A bare `<session8>#<id>` is never looked up by number at the end: only the launch's binding (run id, session file) or a uid ties it (review F002). | review F003, F008 | settled |
| S7 | Fallback attempts | Not counted: Maestro hands the host only the last attempt's session file and elapsed. Needs a Maestro change, routed through the fork: in `maestro/runtime/pi-run-session.ts` (where `entry.completed` is built, beside `failures.push`), keep each spawned attempt's `{ model, sessionFile, elapsed }`; carry them through `maestro/runtime/run-session.ts` `acquireNext`/`deliver` into the completion; and in `pi-extension/subagents/delivery.ts` `deliverPiCompletion` put them on the result and ping details as `attempts: [{ model, sessionFile, elapsed }]`. The ledger would then add each attempt file's figures and elapsed to the same todo. | review F004 | open (Maestro) |
