# Apps configuration

The project's managed apps live in `.straw-boss/apps.json` at the git root, or in `.claude/straw-boss/apps.json` when the first is absent. Without either file, a repository holding one codebase is its own single app; with several plausible apps, ask which one the request targets.

```json
{"apps": [{"name": "api", "dir": "apps/api", "match": ["backend", "rest api"]}]}
```

| Field | Meaning |
|---|---|
| `name`, `dir`, `match` | Required: the app's name, its checkout relative to the git root, and phrases that name it in a request. |
| `redirectTo`, `note` | A retired app: route new work to the named app and tell the user the `note`. |
| `forbidDirectCommit` | `true`: changes reach the base branch only through a worktree branch and MR. |
| `gitWorkflowSkill` | The app's own skill for commit, MR, and release steps; the worker follows it. |
| `localFiles` | Gitignored files a new worktree needs, each with `path` relative to `dir`; copy them before launch. A `sensitive: true` file is copied only under the user's authorization, and an entry without `optional: true` that is missing blocks the launch. |
| `crossAppSkills` | `withApp` and `skill`: an existing skill that handles this app depending on `withApp`; name it in the brief. |
