# Todo preflight and run spend (2026-11-28)

Status: built on `feat/todo-preflight`, with pi-todo-ledger 0.8.0 for the spend; a reviewer is paired before release because the ledger's contract grows. The behavior is in [how-it-works, The subagent host](../how-it-works.md#the-subagent-host).

## Boss words (binding)

The boss picked both items on the 11/28 form: 「todo 驗收檢查」 and 「todo 記成本」.

## A. Preflight at dispatch

When a main dispatches for a todo (`subagent` with `item`, or `boss_pair` with `item`), sb looks at that todo before the call goes through. It is a static check of the list, in the manner of Archon's plan validation: it runs nothing.

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| P1 | What is read | The newest `todo/v1` snapshot of the launcher's branch, raw (tombstones included, every row), through an incremental branch scan (`snapshotScan`). The board's parser (`todosOf`) caps at 200 rows and drops tombstones, so it cannot see a deleted blocker or a row past 200. | items.ts, todo.ts | settled |
| P2 | Missing or vague anchor | A warning on the call's result, naming `todo update anchor`. sb removed hard dispatch gates in 0.83.0, so bookkeeping never refuses a launch. | brief; docs/specs/2026-11-23-lite-main.md §1 | settled |
| P3 | What counts as vague | An anchor with no command word at its start and nothing concrete in it (code, a path, a flag, a file name, a number, an address, a quote, a comparison) is vague when it is a known empty phrase (`tests pass`, `works`, `done`, `完成`, `測試通過`, ...) or shorter than four words (six CJK characters count as four). A sentence that says what is seen, such as "Credit notes round before tax", passes. | src/preflight.ts `anchorProblem` | settled |
| P4 | A `blockedBy` cycle | Refused, with the cycle's path: the todo can never become ready, and a worker on it starts work out of order. Only a cycle the todo reaches counts; one elsewhere in the list is another launch's. The ledger refuses a cycle at `update`, so one comes only from an import or a hand edit. | brief | settled |
| P5 | A deleted or unknown blocker | A warning: the dependency it records is gone. Capacity already treats such a blocker as blocking nothing, so the launch is not wrong, only the record. | capacity.ts `capOfTodos` | settled |
| P6 | An item that names no todo, or a deleted one | A warning: the ledger binds nothing to such a launch. A `<session8>#<id>` of another session is not judged; that session checks its own. | pi-todo-ledger CONTRACT.md "Optional Herdr launch identity" | settled |
| P7 | rpiv-todo lists | Only the graph is judged: rpiv-todo has no anchors. | | settled |
| P8 | Cost | Measured on a 5,000-row ledger with a new snapshot at each launch (the reader validates and walks it): median about 2 ms, max about 4 ms on the boss's Mac. The test fails above 25 ms to leave room for a loaded machine. | tests/preflight.test.ts | settled |

The `subagent` check runs in the session's `tool_call` hook before the capacity cap reserves anything, so a refused launch holds no points. Its warnings wait for the call's result and ride on it once; a call the turn ended without a result leaves none behind. `boss_pair` checks before it asks the server for a thread, so a refused pair opens no thread.

## B. Run spend on the todo

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| S1 | Where the cost comes from | The child's own session file: pi writes each assistant turn's `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost.total`) and its `provider`/`model` there. sb had no child cost before; Maestro's result names `sessionFile` and `elapsed` (seconds) but no usage. | @earendil-works/pi-ai `Usage`; Maestro delivery.js | settled |
| S2 | Who records it | pi-todo-ledger (0.8.0), the list's one writer. It already binds launches to todos (`metadata.herdr`), resumes by session path included, so it resolves the todo of a result the same way and writes through its normal guarded update. sb reads the record only. | pi-todo-ledger herdr-owner.ts | settled |
| S3 | The shape | `metadata.herdr.spend`: totals (`input`, `output`, `cacheRead`, `cacheWrite`, `tokens`, `cost`, `ms`, `runs`, `models`) and up to twelve `sessions` with each one's last figures. Additive within `todo/v1`: `metadata` is free-form, and a later launch keeps `spend` when it rebinds `metadata.herdr`. | pi-todo-ledger CONTRACT.md "Run spend" | settled |
| S4 | Resumes | A resume continues the same session file, so a session's figures are replaced by the file's newest total, never added twice; wall time adds each result's `elapsed`. A `subagent_ping` (the run stopped to ask) counts a run and its tokens so far. | | settled |
| S5 | What sb shows | The session page's todo detail line (`Spent: … tokens · $… · … · N runs · models`); totals only, never the session paths. An older ledger records nothing, and nothing shows: no version check is needed, since the reader takes the field only when it is there and well formed. | src/items.ts, gui/bars.ts | settled |
