# Planning work

Plan before your first dispatch, and plan again when the work's shape changes.

## 1. Choose the graph

Take the first case that matches:

- **single-loop**: one bounded task that you carry yourself, or that one subagent carries. Do not state it, and do not write a plan.
- **fan-out/fan-in**: independent branches run in subagents, and you integrate their results.
- **orchestrator-worker**: several workers, each owning one app's task end to end, with dependency edges or more ready tasks than the concurrency cap.

An independent review is a checkpoint, not a change of graph.

## 2. Write the plan as todos

For fan-out and orchestrator-worker, create one todo per task. A task is the largest item one worker can own end to end in one app.

- `subject`: the required outcome.
- `owner`: the subagent's name, or `self` for work you carry yourself.
- `description`: the app, the worktree branch for a parallel writer, the anchor and who exercises it, and the exact artifact path a dependent will read.
- `blockedBy`: the tasks whose output or landed change this one needs. Edges set the order. Tasks with no open blocker run in parallel, up to the cap (4 unless the boss or the project names another). Writers that would clash in one checkout wait.
- `metadata`: `{ "graph": "...", "anchor": "...", "checkpoint": "own" | "<checkpoint todo id>" }`.

## 3. Name the anchors

Each anchor is the lightest check that can fail before the change and still reach what changed:

- **testing**: the default for code changes. Use the smallest test that goes red first. Repo-wide suites, lint, and type checks run once, at the shared checkpoint or before merge, never inside each task.
- **pseudo-human**: a browser or computer operates the real interface and records screenshots and measurements.
- **human**: the boss operates or judges the delivered result. Use it where the boss's judgment is the real check: UI feel, wording, a business rule.
- **adversarial-review**: a fresh-context agent challenges the result against the requirement. Use it for read-only work that has no executable checkpoint.

Tasks that share one anchor share one checkpoint. Do not verify the same thing separately in each branch. Give each such group one checkpoint todo, `blockedBy` every task it covers, and tell those workers to hand their evidence to it instead of running it themselves. A task whose check is distinct, or plainly cheaper in place, keeps its own.

A change-set that touches a shared contract, authorization or permission data, or a migration gets one fresh-context reviewer after its anchor passes. Other change-sets take the author's own read of the diff against the brief.

## 4. Confirm, then start

Show the boss the plan through your question tool before the first dispatch: the graph, the tasks with their owners, the edges and what they leave parallel, each shared anchor and what it checks, and every human checkpoint. Start only on their confirmation. A change to the graph, an edge, or an anchor goes back to the boss in the same way.

## 5. Run it

Dispatch each ready task. When a result arrives, check it against its brief and its anchor, mark the todo `completed`, then dispatch whatever it unblocked. A failed or cancelled task leaves its dependents blocked: report them, and resolve the next step with the boss. Only a completed task satisfies a dependency.
