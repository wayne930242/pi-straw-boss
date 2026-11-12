# Planning work

Plan before you dispatch a worker, and again when the work's shape changes.

## 1. Choose the graph

Take the first case that matches:

- **single-loop**: one bounded task that you carry yourself, or that one subagent carries. Its plan is one todo whose `metadata.anchor` names its check, plus `"graph": "single-loop"` when a worker carries it.
- **fan-out/fan-in**: independent branches run in subagents, and you integrate their results.
- **orchestrator-worker**: several workers, each owning one app's task end to end, with dependency edges or more ready tasks than the concurrency cap.

An independent review is a checkpoint, not a graph.

## 2. Write the plan as todos

For fan-out and orchestrator-worker, create one todo per task. A task is the largest item one worker can own end to end in one app.

- `subject`: the required outcome.
- `owner`: the subagent's name, or `self` for work you carry yourself.
- `description`: the app, the worktree branch for a parallel writer, the anchor and who exercises it, and the exact artifact path a dependent will read.
- `blockedBy`: the tasks whose output or landed change this one needs. Tasks with no open blocker run in parallel, up to the cap (4 unless the boss or the project names another). Writers that would clash in one checkout wait.
- `metadata`: `{ "graph": "<a graph name from section 1, exactly>", "anchor": "...", "checkpoint": "own" | "<checkpoint todo id>" }`.

## 3. Name the anchors

Each anchor is the lightest check that can fail before the change and still reach what changed:

- **testing**: the default for code changes. Use the smallest test that goes red first. Repo-wide suites, lint, and type checks run once, at the shared checkpoint or before merge, never inside each task.<!-- integration --> In an `integration` app, see below.<!-- /integration -->
- **pseudo-human**: a browser or computer operates the real interface and records screenshots and measurements.
- **human**: the boss operates or judges the delivered result. Use it where the boss's judgment is the real check: UI feel, wording, a business rule.
- **adversarial-review**: a fresh-context agent challenges the result against the requirement. Use it for read-only work that has no executable checkpoint.

Tasks that share one anchor share one checkpoint. Give each such group one checkpoint todo, `blockedBy` every task it covers, and tell those workers to hand it their evidence. A task whose check is distinct, or plainly cheaper in place, keeps its own.

<!-- integration -->
In an app that declares `integration`, follow `integrating`'s Principle: your anchor before handoff is your review (P0 and P1 clear), behaviour tests aimed at your own change, and the project skill's `Light checks`; repo-wide quality gates run once, by the integrator, on the integrated pre-dev head (its `Full gates`). Run the app's `integration.accept` on your branch before the slip, as the project skill's `## Acceptance` says, get the boss's nod, and write the evidence file (absolute paths in `accept:` and `evidence`); check it with the `train check` command in your main prompt (`--accept none` when `integration.accept` is empty): `--accept <file> --app-accept <integration.accept> --slip <slip>` before you send the slip; a `human` anchor is this acceptance, not the train's.

<!-- /integration -->
A change-set that touches a shared contract, authorization or permission data, or a migration gets one fresh-context reviewer after its anchor passes. Other change-sets take the author's own read of the diff against the brief.

## 4. Start

Dispatch without asking the boss to confirm the plan, and change it the same way: the todos record it. Before offering the boss a design choice, read the owning app's instructions and the UI and architecture rules they name; drop the options they forbid, and quote the rule that settles the design in the brief. Through your question tool, bring the boss only the decisions the plan cannot settle, before the task they block: a requirement that is unclear or contradicts the architecture, and an authorization the work needs, such as a merge to a shared branch or a deploy.
