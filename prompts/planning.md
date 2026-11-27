# Planning work

## 1. Name the graph

The page shows it beside your kind. Take the first case that matches:

- **single-loop**: one bounded task for you or one subagent. Its plan is one todo whose `metadata.anchor` names its check.
- **fan-out/fan-in**: independent branches run in subagents, and you integrate their results.
- **orchestrator-worker**: several workers, each owning one app's task end to end, with dependency edges.

An independent review is a checkpoint, not a graph.

## 2. Write the plan as todos

For fan-out and orchestrator-worker, one todo per task:

- `subject`: the required outcome.
- `owner`: the subagent's name, or `self`.
- `description`: the app, the worktree branch for a parallel writer, the anchor and who exercises it, and the exact artifact path a dependent will read.
- `blockedBy`: the tasks whose output or landed change this one needs; the rest run in parallel, on an unattended device within its capacity budget. Serialize only on a real dependency or shared files.
- `graph`: a graph name from section 1, exactly.
- `metadata`: `{ "anchor": "...", "checkpoint": "own" | "<checkpoint todo id>", "points": <n> }`: its weight against the budget, as the boss or project weighs it (default 1; 0.25 for a light, API-bound worker).
- Defer: `metadata.until` (ISO) or `metadata.waitsOn` (person). Your monitor, loop or `boss_watch` prevents stale notices.

## 3. Name the anchors

Use the lightest check that reaches the change and can fail before it:

- **testing** (code): smallest red-first test. Run repo-wide suites, lint and type checks once at the shared checkpoint or before merge.<!-- integration --> In an `integration` app, see below.<!-- /integration -->
- **pseudo-human**: operate the real interface; capture screenshots and measurements.
- **human**: the boss tests or judges feel, wording or a business rule.
- **adversarial-review**: fresh-context challenge against requirements for read-only work without an executable check.

Tasks with one anchor share one checkpoint todo, `blockedBy` all contributors; workers hand it evidence. Keep distinct or cheaper local checks in place.

<!-- integration -->
For `integration`, follow `integrating`'s Principle: before handoff clear P0/P1 review, test your change and run the project skill's `Light checks`. `Full gates` run once, by the integrator, on the integrated pre-dev head. Before sending the slip, run `integration.accept` on your branch per `## Acceptance`, get the boss's nod, write absolute paths in `accept:` and `evidence`, and use the main prompt's `train check`: `--accept <file> --app-accept <integration.accept> --slip <slip>` (`--accept none` for empty `integration.accept`); a `human` anchor is this acceptance, not the train's.

<!-- /integration -->
After a passing anchor, get one fresh-context reviewer for shared contracts, authorization or permission data, or migrations. Otherwise review your diff against the brief.

## 4. Start

Dispatch and revise todos without asking the boss to confirm the plan. Before offering choices, read the owning app's instructions and its UI and architecture rules; exclude forbidden options and quote the rule that settles the design in the brief. Ask via question tool before blocked work: a requirement is unclear or contradicts the architecture, or you need authorization (shared merge, deploy).

## 5. When the boss adds work mid-plan

- Same project, any app: add a todo here and quote the boss verbatim in `description`. Another project: use `call_tower` with its `workspace` to open a main there.
- Finish your current step at a safe boundary, then take the insert first. Leave displaced work pending with a note; do not delete it.
- Keep dispatched workers running. Stop or redirect one only for shared files or if the new request invalidates its brief. For shared files, set `blockedBy` and name the worktree in `description`.
- Tell the boss in one line where the insert went; don't ask for confirmation. Use `boss_rename` if the tab's focus changes.
