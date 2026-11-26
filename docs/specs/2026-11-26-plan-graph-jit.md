# The planning rule when a main plans without a graph (2026-11-26)

Status: implemented in 0.101.0. Code: `src/planhint.ts`, wired in `src/session.ts`. Tests: `tests/plan-hint.test.ts`. Follows [the just-in-time prompts spec](2026-11-26-just-in-time-prompts.md).

## Why

`prompts/planning.md` §1 (name the graph) and §2 (the todo fields, `metadata.graph` among them) reach a main only through the pointer `({{dir}}/planning.md: plan, anchors)` in `prompts/main.md`. In the 58 latest main sessions that created todos, 6 opened planning.md, and all 6 set a graph; of the 52 that did not, 8 set one. The boss labelled the miss live (a main planned stage by stage with no graph, so no parallel branches) and says it happens often.

## Boss words (binding)

2026-11-26:

> 「sb 在派工當下送規則」

When a main first creates todos without choosing a graph, sb attaches the rules for choosing a graph and writing todos to that result. They appear only when needed, and the always-on prompt does not grow.

Later that day:

> 「選圖也需要融入記帳，最好是我們的 todo 本身就有圖支援」

The graph becomes a first-class field of a todo in pi-todo-ledger 0.4.0 (`graph`: exactly `single-loop`, `fan-out/fan-in`, or `orchestrator-worker`; anything else refused; a legacy valid `metadata.graph` read as `graph`). planning.md §2 now names the todo's `graph` field instead of `metadata.graph`; §1's names are unchanged. This release waits for ledger 0.4.0 on npm.

## What sb does

- **Who.** A session whose role is `main`, outside a tower run, of kind `coordinator` or `standing` (standing.md points to planning.md for dispatching too). An integrator, a worker main, a member, a train, and a tower get nothing.
- **When.** On a `todo` result with no error whose call is a `create` (single or batch `tasks[]`), when the list after the call has open todos (not completed, not a train step with `metadata.sb`) and none names a graph: its own `graph` field, a name of `GRAPHS` exactly, or a legacy `metadata.graph` through `graphOf` (`todosOf` in `src/items.ts`, which the page reads too). It works with the ledger before and after 0.4.0.
- **How often.** Once. Then it waits until a `todo` result shows a graph on an open todo, or no open todo, and only then can it come once more. A new session (`session_start`) starts armed.
- **What.** The result's content gets one more text: an opening line, planning.md §1 and §2 condensed, and the end line ``Set the `graph` field on these todos.`` The text is read from `prompts/planning.md` at that moment. The condensed version leaves out the page's label sentence, the capacity details (capacity notices carry them), the default points, and the Defer bullet, and drops the bold marks. Each cut must still match the file. A section or a cut that no longer matches throws: pi passes the result through and reports the hook's error, and the test fails.

## Sizes

The block is 1,189 bytes against planning.md as of this change, under the 1.2 KB budget held by the test. `prompts/main.md` is unchanged at 4,468 characters; main.md plus planning.md stay within the 8,559 characters of `tests/duty-prompts.test.ts`.
