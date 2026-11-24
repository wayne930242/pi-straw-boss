# The todo list through pi-todo-ledger's contract (2026-11-24)

Status: implemented on `feat/todo-ledger-reader` (base `feat/capacity-prompts` 10b580e4). sb reads and guards the todo list through the public contract of [pi-todo-ledger](https://github.com/wayne930242/pi-todo-ledger) (its `CONTRACT.md` and `schema/todo-v1.schema.json`, version 1, main 73baf32) and imports nothing from that package. Without the ledger, rpiv-todo's records and the `tool_call` guard work as before. How it behaves for a user: [how-it-works, Todos](../how-it-works.md#todos).

## Why

Until now, sb read rpiv-todo's private storage: its `rpiv-todo-state` entries and the `details` of its `todo` results. The ledger publishes the same list as a contract: a `todo/v1` entry for every change, a `todo:changed` event, and change guards that see a call before it commits. Reading the contract keeps sb independent of either package's internals, and the train's rules become one of the ledger's guards instead of a `tool_call` hook placed in front of another extension's tool.

## Reading the list

`src/todoledger.ts` holds the contract's names and `isSnapshotV1`, which checks `data` against the schema's root: `v` 1, every task valid (`id` an integer ≥ 1, `subject` a string, `status` one of the four, and each optional field of the schema in its type and range), and `nextId` an integer ≥ 1. Properties that the schema does not name are allowed, as the contract's version rule requires.

A branch's list (`snapshotOfBranch` and `snapshotScan` in `src/todo.ts`, and `todos()` in `src/history.ts` for the chat's todo panel) is:

1. the newest `todo/v1` custom entry on the branch whose data passes `isSnapshotV1`; an invalid one is skipped for the next older one. It wins over every rpiv record, before it or after it, as the ledger's own migration rule says;
2. else rpiv-todo's newest `rpiv-todo-state` entry;
3. else the `details` of the newest `todo` tool result.

Every reader of the list goes through these: the card's summary (`bridge.ts`), the board's auto-fill (`boardfill.ts`), capacity (`capfill.ts`, `workercap.ts`), the main's duty (`mainduty.ts`), the tools (`tools.ts`), and the train's guard, car, and manifest (`trainguard.ts`, `traincar.ts`). A snapshot is the whole list: a reader replaces its copy, never merges tasks by id (ids are per branch and restart at a `clear`). No reader keeps live state from `todo:changed`: each reads the branch again where it did before (the bridge at every tool's end, turn end, tree move, and compaction), and the ledger writes the entry before its call ends.

`todosOf` keeps `metadata.points` as before and reads the ledger's top-level `points` when `metadata.points` is missing or invalid; when both are set, `metadata.points` wins.

## The train's guard on two paths

The rules of `src/trainguard.ts` for `todo` calls (every todo of a train is a step, the integrator's `train` todo, the role not yet settled, the skills' contract) now run in one function, `todoReasons(input, ctx, state)`, where `state` gives the list the call is judged on. Two paths call it, and one call is judged by only one of them:

| | rpiv-todo | pi-todo-ledger |
|---|---|---|
| Where | `tool_call` of the `todo` tool | the ledger's change guard `sb-train` (`todo:guard`, v 1) |
| Input | `event.input` | `change.params` |
| List before the call | the branch's snapshot | `change.before`; `nextId` is the lowest id in `change.after` that `change.before` lacks, else one past the highest id in `change.before` (tombstones count) |
| Branch (manifest, forwards) | the call's `ctx` | the context sb saw last for `change.sessionId` (`session_start`, `session_tree`, and every `tool_call`, which pi fires before the tool runs) |
| A refusal | `{ block: true, reason }` | the reason; the ledger's tool result says `Error: guard sb-train refused: <reason>` |

sb registers the guard when its guard is created and again on every `todo:ready` (v 1), which covers either load order. The `tool_call` path stands down for `todo` calls once the ledger is known: its `todo:ready`, its `todo:changed` (the ledger restores the list at `session_start`, so a ledger that loaded before sb is known before the first call), or the first call of the check. `MonitorCreate` and `call_tower` stay on `tool_call` and read the list through `snapshotOfBranch`.

A no-op update (a status set again after `/reload`) reaches the check flagged `noop` and is judged like any update, so a step set `in_progress` again gets its start time back, as on the `tool_call` path. When a rule needs the branch of a session sb has not seen (a train's manifest, the integrator's forwards), the call is refused: the guard says it could not check the call. A session that is neither a train nor a main is not checked. With the merge train off (§14.8 of the train spec), nothing registers.

## Tests

- `tests/todo-ledger.test.ts`: v1 wins over rpiv records; the newest valid v1 entry wins; invalid v1 entries (each schema rule) are skipped for the older valid one or the rpiv fallback; unknown properties are allowed; the incremental scan; `points`.
- `tests/history.test.ts`: the chat panel reads the same order from the session file.
- `tests/train-guard-ledger.test.ts` runs the whole of `tests/train-guard.test.ts` again with `SB_TEST_TODO_PATH=ledger`: `tests/train-guard-rig.ts` then emulates the ledger by its contract (it hears `todo:guard`, emits `todo:ready` and `todo:changed`, runs the checks with `noop`, writes `todo/v1` entries, and returns a refusal as the ledger's error text, which the rig unwraps after checking its `sb-train` prefix), and it fails any test in which the `tool_call` path still blocks a `todo` call. Its own tests cover both load orders, a ledger learned from its first check, the `noop` update after `/reload`, and a change for an unseen session.

## Contract gaps (for pi-todo-ledger, not changed here)

- A guard owner cannot tell whether its registration was accepted: there is no reply to `todo:guard`. sb infers the ledger from `todo:ready`, `todo:changed`, or a call of its check; a ledger that loaded first and has not yet restored any list is learned only at its first check, so that one call is judged on both paths.
- A change carries the lists but not `nextId` before the call; sb derives it from `before` and `after`.
- A change carries no `toolCallId`, so a guard cannot match it with pi's `tool_call` event for the same call.
