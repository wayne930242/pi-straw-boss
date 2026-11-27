---
name: pi-straw-boss-subagents
description: Operate sb's subagent host (pi-straw-boss). Use when asked to launch, delegate to, cancel, resume, or list Pi subagents; to pick a model or task:<category> for one; to tie a worker to a todo; when a worker ended without a result; or when the subagent tools are missing or sb_doctor says the host stood down.
---

# Subagents with Straw Boss

Adapted from pi-herdr-agents' operating guide (`skills/pi-herdr-agents/SKILL.md`, MIT, Giuseppe Rodriguez; see NOTICE.md). Live tool descriptions are authoritative; this guide is a summary.

## What the host is

pi-straw-boss hosts subagents on the Maestro engine, in a simple mode. Any pi session can dispatch: a main, a member, a session that never joined the net, with or without todos. Each child is a real pi in a Herdr split pane of your tab. It runs one task, exits when done, and its result comes back to you as one message. Start pi inside Herdr.

The tools: `subagent`, `subagent_cancel`, `subagent_resume`, `subagents_list`, and the `/subagent` command. A child has `caller_ping` to ask you for help, and `subagent_done` when it does not exit by itself.

The simple mode has no persistent specialists (`subagent_send`, `subagent_stop`), no `subagent_interrupt`, no managed worktrees (`worktree`, `worktree_list`, `worktree_remove`), no `accept` checks, no Herdr Core backend, and no task-model writer. A call that passes `persistent`, `notify`, `worktree` or `accept` is refused with what to do instead.

## Results arrive by themselves: never poll

`subagent` returns at once. The result or failure arrives later as one `subagent_result` message, a help request as `subagent_ping`, and each starts a turn. End your turn or do other independent work. Never sleep, loop, tail session files or list status to wait for a child. Stall notices are facts, not instructions.

## Launching: `subagent`

`name` and `task` are required.

| Parameter | What it means |
| --- | --- |
| `agent` | A role to load defaults from (see `subagents_list`). Omit for a bare child. A role defined as a persistent specialist is refused. |
| `model` | An exact authenticated `provider/model-id`, a comma-separated fallback list, or `task:<category>` from the configured `models.tasks`. Omitted: the role's model, then `models.agents`, `models.default`, then yours. |
| `thinking` | `off` to `max`, within the model's range. Omitted: the category's thinking, the role's, then yours; an installed extension may set it from `solutionSpace`. |
| `solutionSpace` | One or two sentences on how open the work is (fix given, or causes still open). The child gets it as `PI_SUBAGENT_SOLUTION_SPACE`. |
| `item` | The todo this launch works on (its uid or `<session8>#<id>`). Optional: a quick scout or check off the plan is launched without it, and that is a normal worker. |
| `cwd` | The child's working directory. For a parallel writer, create the worktree yourself (`git worktree add`) and pass its path. |
| `systemPrompt`, `skills`, `tools`, `fork`, `interactive` | As their descriptions say. |

Name coordinated children `<task>-<role>[-n]`, for example `login-api`.

## Where workers show

A worker launched with `item` is drawn under its todo by pi-todo-ledger; one launched without it is drawn in the ledger's group of other workers. Without a ledger, they show in the built-in Subagents box above the editor: one row each, name · model · state · time. The sb GUI and board show every worker under the session that launched it.

## Cancel, resume, list

- `subagent_cancel({ id | name })` ends a running child. Its intent is recorded first, so no fallback model starts; one `cancelled` result follows. `confirmed`: done; `requested`: the launch is still settling; `unconfirmed`: retry or report. Never close a pane or kill a process by hand to cancel.
- `subagent_resume({ sessionPath, name?, message?, autoExit? })` continues a finished, failed or cancelled child in a new pane: answer its `caller_ping`, or send follow-up work. It keeps the stored model and tools.
- `subagents_list` lists the roles you can launch and where each comes from.

## A worker ended without a result

When a worker's pane closes or its pi dies before it reports, its failed result carries a line from Straw Boss with its name, session file and the `subagent_resume` call. Straw Boss does not revive or resume it: you decide, and resume it with a message saying what is left.

## Configuration

The models live in `<agent dir>/herdr-agents/config.json` (default `~/.pi/agent/herdr-agents/config.json`), the same file pi-herdr-agents read: `models.default`, `models.agents`, `models.tasks` (ordered candidates per category), `models.tasksThinking`, plus `status`, `supervision`, `panes` and `spawning.maxDepth`. Edit it by hand and keep every other key; `/reload` after a change. Without the file the package's `config.json.example` supplies the non-model settings.

`<agent dir>/straw-boss/host.json` with `{ "host": "off" }` turns the host off (`PI_STRAW_BOSS_HOST=off` for one process).

## When the tools are missing

Run `sb_doctor` (or `/boss doctor`). It names the subagent host of this pi:

- `active`: sb registered the four tools.
- `stood down`: pi-herdr-agents (or another copy of pi-straw-boss) registered `subagent`, so sb registered nothing. Remove one of the two hosts from your packages, then restart pi.
- `off`: host.json or `PI_STRAW_BOSS_HOST` turned it off.
- `failed to load`: the engine threw; the doctor shows the error.

The host needs Herdr, not pi-intercom. The sb server, the net and the GUI need pi-intercom, which a plain `pi install npm:pi-straw-boss` does not bring: install it with `pi install npm:pi-intercom`.
