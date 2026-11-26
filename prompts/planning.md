# Planning work

Revise the plan when the work changes.

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

Each anchor is the lightest check that can fail before the change and still reach what changed:

- **testing**: the default for code changes. Use the smallest test that goes red first. Repo-wide suites, lint, and type checks run once, at the shared checkpoint or before merge, never inside each task.<!-- integration --> In an `integration` app, see below.<!-- /integration -->
- **pseudo-human**: a browser or computer operates the real interface and records screenshots and measurements.
- **human**: the boss operates or judges the result: UI feel, wording, a business rule.
- **adversarial-review**: a fresh-context agent challenges the result against the requirement. Use it for read-only work that has no executable checkpoint.

Tasks that share one anchor share one checkpoint. Give each such group one checkpoint todo, `blockedBy` every task it covers, and tell those workers to hand it their evidence. A task whose check is distinct, or plainly cheaper in place, keeps its own.

<!-- integration -->
In an app that declares `integration`, follow `integrating`'s Principle: your anchor before handoff is your review (P0 and P1 clear), behaviour tests aimed at your own change, and the project skill's `Light checks`; repo-wide quality gates run once, by the integrator, on the integrated pre-dev head (its `Full gates`). Run the app's `integration.accept` on your branch before the slip, as the project skill's `## Acceptance` says, get the boss's nod, and write the evidence file (absolute paths in `accept:` and `evidence`); check it with the `train check` command in your main prompt (`--accept none` when `integration.accept` is empty): `--accept <file> --app-accept <integration.accept> --slip <slip>` before you send the slip; a `human` anchor is this acceptance, not the train's.

<!-- /integration -->
A change-set that touches a shared contract, authorization or permission data, or a migration gets one fresh-context reviewer after its anchor passes. Other change-sets take the author's own read of the diff against the brief.

## 4. Start

Dispatch without asking the boss to confirm the plan, and change it the same way: the todos record it. Before offering the boss a design choice, read the owning app's instructions and the UI and architecture rules they name; drop the options they forbid, and quote the rule that settles the design in the brief. Through your question tool, bring the boss only the decisions the plan cannot settle, before the task they block: a requirement that is unclear or contradicts the architecture, and an authorization the work needs, such as a merge to a shared branch or a deploy.
