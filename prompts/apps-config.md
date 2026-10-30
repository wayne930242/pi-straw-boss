# Apps configuration

The project's managed apps live in `.straw-boss/apps.json` at the git root, or in `.claude/straw-boss/apps.json` when the first is absent. Without either file, a repository holding one codebase is its own single app; with several plausible apps, ask which one the request targets.

```json
{"integration": {"skill": "integrate", "maxCars": 4, "maxWaitMin": 60},
 "apps": [{"name": "api", "dir": "apps/api", "match": ["backend", "rest api"], "integration": {"base": "develop"}}]}
```

| Field | Meaning |
|---|---|
| `name`, `dir`, `match` | Required: the app's name, its checkout relative to the git root, and phrases that name it in a request. |
| `redirectTo`, `note` | A retired app: route new work to the named app and tell the user the `note`. |
| `forbidDirectCommit` | `true`: changes reach the base branch only through a worktree branch and MR. |
| `gitWorkflowSkill` | The app's own skill for commit, MR, and release steps; the worker follows it. |
| `localFiles` | Gitignored files a new worktree needs, each with `path` relative to `dir`; copy them before launch. A `sensitive: true` file is copied only under the user's authorization, and an entry without `optional: true` that is missing blocks the launch. |
| `crossAppSkills` | `withApp` and `skill`: an existing skill that handles this app depending on `withApp`; name it in the brief. |
| `integration` (top level) | The project's merge train defaults: `skill` is the name of the project skill that holds the concrete checks (a name, as `gitWorkflowSkill` is), `maxCars` (default 4) and `maxWaitMin` (default 60) say when a train departs; the skill may override them. |
| `integration` (per app) | `base` is the integration branch; `skill` overrides the project's. Only an app with this field takes the merge train; an app without it keeps today's flow, and the main merges after its own checks. |

## Merge train

Straw-boss states the principle and the contract; the project's skill holds every concrete check. A coordinator's anchor before handoff is its review (P0 and P1 clear) plus behaviour tests aimed at its own change. Format, lint, build, full type-check, full suites, publish, and similar quality gates run once, by the project's integrator, on the integrated pre-dev head. A skill may name exceptions.

The skill is found by the headings below, exactly as written. Straw-boss reads no other part of it.

| Heading | Read by | Holds |
|---|---|---|
| `## Light checks` | coordinator | The checks to run before handoff and how to report them. |
| `## Train assembly` | integrator | Project steps after the cars are merged and before the gates (for example migration reordering and snapshots). |
| `## Full gates` | integrator | The heavy checks, which depend on the clock (run at low load), and which failures may be rerun as flakes. |
| `## Merge` | integrator | How the train enters the base branch. |
| `## Post-merge` | integrator | What to watch after the merge, how to confirm the release, who closes tickets. |
| `## Urgent lane` | integrator | Optional: when a car may jump the queue, and whether it may interrupt a running gate. |
| `## Load` | integrator | Optional: the project's lock name and load thresholds. |

`Light checks`, `Full gates`, and `Merge` are required. If one is missing, the integrator does not depart and calls the tower with `why=blocked`; it never guesses a section.
