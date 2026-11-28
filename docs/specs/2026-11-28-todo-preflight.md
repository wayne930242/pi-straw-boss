# Todo preflight and run spend (2026-11-28)

Status: A (preflight) ships; B (run spend) is redone, review pending. The boss split the two on 11/28 after the third review left the spend open: 「拆開：檢查先發，記成本重做」. The preflight's behavior is in [how-it-works, The subagent host](../how-it-works.md#the-subagent-host).

## Boss words (binding)

The boss picked both items on the 11/28 form: 「todo 驗收檢查」 and 「todo 記成本」. After the third review: 「拆開：檢查先發，記成本重做」.

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
| P8 | Cost | The claim is a CPU median: ≤ 5 ms a launch on a 5,000-row ledger with ≤ 12 blockers a todo, a new snapshot before each launch, read through pi's own `SessionManager.getBranch`. It is not a bound on every launch. Measured on this Mac at a load average near 35 (`npm run test:one -- tests/preflight.test.ts`): a chain 0.7 ms (p95 13 ms), 12 blockers a todo with 4,000 rows done 1.1 ms (p95 4.8 ms), 12 blockers with every row open 3.5 to 4.1 ms (p95 22 to 24 ms, max 41 ms); the review measured 3.35 ms median and 10.13 ms p95 wall time for the all-open list, and 6.19 ms median at 32 blockers, past the claim. Each snapshot is indexed once and each row's open blockers asked once (review F007). The test asserts the median ≤ 5 ms for the three lists and reports p95 and max. | tests/preflight.test.ts | settled |

The `subagent` check runs first in the session's `tool_call` hook, before a bar from the net (a sub workspace's session dispatches too, review F006) and before the capacity cap reserves anything, so a refused launch holds no points. Its warnings wait for the call's result and ride on it once; a call the turn ended without a result leaves none behind. `boss_pair` checks before it asks the server for a thread, so a refused pair opens no thread.

## B. Run spend on the todo

Status: redone on sb `feat/spend-v2`, pi-todo-ledger `feat/spend-v2` (0.9.0) and the Maestro fork's `feat/spend-v2` (tag `sb-host-a5a9c43`); a fresh reviewer is paired before release, since the ledger's contract and Maestro's delivery details grow.

When a run bound to a todo ends, pi-todo-ledger records its tokens, cost, wall time, runs and models on that todo (`metadata.herdr.spend`), and the session page's todo detail shows the totals, never the session paths. The figures are an estimate from the child's transcript, not a bill.

| # | Question | Answer | Basis | Status |
|---|---|---|---|---|
| S1 | Where the cost comes from | The child's own session files: pi writes each assistant turn's `usage` and its `provider`/`model` there. A fork's copy of its launcher's turns (older than the file's header, or entry ids the launcher holds) is not the child's (review F001). | @earendil-works/pi-ai `Usage` | settled |
| S2 | Who records it | pi-todo-ledger, the list's one writer. It ties an end to the todo its launch bound (`metadata.herdr.runs`: run id, then session file, then uid), never to the todo a bare `<session8>#<id>` names after a clear (review F002). sb reads the record only. | pi-todo-ledger herdr-spend.ts | settled |
| S3 | Which run an end closes | Maestro names it: every `subagent_result` and `subagent_ping` carries `details.id`, the run id the launch or resume acknowledged, and a ping its `elapsed` (review F003, F011). sb's host no longer notes launches or reads Maestro's registry; an end without a run id sends no event. | Maestro fork `pi-extension/subagents/delivery.ts` | settled |
| S4 | Ends the model never reads | As each end goes out, sb's host (src/host/run-end.ts) sends `subagent:run-end` `{ v: 1, id, kind, name?, item?, sessionFile?, elapsed?, attempts? }` on pi.events, taken from the end's details. The ledger counts an end by the event or the message, once by its run id (`spend.ended`), so a steer cleared before the turn is still spent (review F008). A listener's throw never reaches Maestro, which would retry the send. | | settled |
| S5 | Fallback attempts | Maestro's details carry `attempts: [{ model?, sessionFile, elapsed }]`, every spawned attempt in order, failed fallbacks included; the ledger reads each attempt's file and adds their elapsed (review F004). | Maestro fork `maestro/runtime/pi-run-session.ts` | settled |
| S6 | A write and a branch switch | The ledger's spend write is synchronous: in one tick it reads the list from the branch pi is on (its newest `todo/v1` snapshot, not the live slot a pending `session_tree` replay may still hold), reads the files, and appends. Pi moves the leaf before its `session_tree` handlers run, so nothing between the read and the append can move it (review F010). Behind a running or queued `todo` call it waits in the session's queue and does the same there; one queued before `session_shutdown` is dropped. Change guards, which are awaited, are not asked; namespace validators are. | pi-todo-ledger CONTRACT.md "Run spend" | settled |
| S7 | Resumes | A resume continues the same session file, so a session's figures are replaced by the file's newest total, never added twice; wall time adds each end's. | | settled |
| S8 | What sb shows | The session page's todo detail line (`Spent: … tokens · $… · … · N runs · models`): totals only, never session paths or run ids. An older ledger records nothing, and nothing shows. | src/items.ts, gui/bars.ts | settled |
