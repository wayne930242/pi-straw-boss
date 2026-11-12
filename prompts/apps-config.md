# Apps configuration

The project's managed apps live in `.straw-boss/apps.json` at the git root, or in `.claude/straw-boss/apps.json` when the first is absent. Without either file, a repository holding one codebase is its own single app; with several plausible apps, ask which one the request targets.

```json
{"apps": [{"name": "api", "dir": "apps/api", "match": ["backend", "rest api"]}]}
```
<!-- integration -->
With a merge train:

```json
{"integration": {"skill": "integrate", "maxCars": 4, "maxWaitMin": 60},
 "apps": [{"name": "api", "dir": "apps/api", "match": ["backend", "rest api"], "integration": {"base": "develop", "stages": ["merge", "deploy"], "accept": ["e2e"], "targets": {"test-env": "auto"}}}]}
```
<!-- /integration -->

| Field | Meaning |
|---|---|
| `name`, `dir`, `match` | Required: the app's name, its checkout relative to the git root, and phrases that name it in a request. |
| `redirectTo`, `note` | A retired app: route new work to the named app and tell the user the `note`. |
| `forbidDirectCommit` | `true`: changes reach the base branch only through a worktree branch and MR. |
| `gitWorkflowSkill` | The app's own skill for commit, MR, and release steps; the worker follows it. |
| `localFiles` | Gitignored files a new worktree needs, each with `path` relative to `dir`; copy them before launch. A `sensitive: true` file is copied only under the user's authorization, and an entry without `optional: true` that is missing blocks the launch. |
| `crossAppSkills` | `withApp` and `skill`: an existing skill that handles this app depending on `withApp`; name it in the brief. |
<!-- integration -->| `integration` (top level) | The project's merge train defaults: `skill` is the name of the project skill that holds the concrete checks (a name, as `gitWorkflowSkill` is), `maxCars` (default 4) and `maxWaitMin` (default 60) say when a train departs; the skill may override them. `integration.maxTrains` (top level, default 3) is how many trains the project runs at once. `integration.project` (top level) is the project's name, as its integrator carries it (`integ <project>`) and its ledger folder is named; default the repository's folder name. |<!-- /integration -->
<!-- integration -->| `integration` (per app) | `base` is the integration branch; `skill` overrides the project's; `integration.accept` lists the acceptance kinds a car must show evidence of (such as e2e or uat; default none): its coordinator runs them on its branch before the slip, with the boss's nod, and the train accepts nothing; `stages` lists, in order, what a train carries: `merge` (the default, always first), then optionally `deploy` (a stage list that names uat is a configuration error); `targets` maps a deploy target to `auto` (every train deploys there with no per-car authorization: the boss's standing word, so only the boss sets it: a main adds or widens an `auto` entry only with the boss's words for it quoted in the commit message) or `strict` (only cars whose slip `auth` names it; the default for an unlisted target). Only an app with this field takes the merge train; an app without it keeps today's flow, and the main merges after its own checks. |<!-- /integration -->

<!-- integration -->
## Merge train

The procedure is the `integrating` and `deploying` skills (the merge-train contract), which Straw Boss binds in the Seam bindings of the main prompt; this file holds only the `apps.json` fields. The project's skill (`integration.skill`) holds every concrete check, found by the headings of `integrating`'s Project skill contract (`## Light checks` to `## Load`), exactly as written; Straw Boss reads no other part of it. When a required one is missing (`integrating` says which), the integrator does not depart and calls the tower with `why=blocked`.

A computer can turn the merge train off with `STRAW_BOSS_INTEGRATION=off` in the environment, or `"integration": "off"` in `config.json` of the state folder (the variable wins). Every field above is then ignored, and this file is served without it.
<!-- /integration -->
