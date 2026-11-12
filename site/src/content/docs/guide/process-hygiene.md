---
title: Process hygiene
description: What a worker's shell started is stopped when the worker ends, and a worktree is not removed under a running process.
---

Every pi loads a small extension that marks its environment, so what a worker's bash starts carries the worker's id, even when `timeout` or `setsid` moved it to a process group of its own.

- **Leftovers are stopped.** A pi-herdr-agents worker registers with the sb server. When the worker quits or its pane closes, the server stops what it left (SIGTERM, then SIGKILL after 10 s, each step checked by pid and start time) and logs one `procs-reaped` line.
- **No worktree removal under a running process.** `worktree_remove` and a bash `git worktree remove` are refused while a process works in the checkout. The refusal names each holder's pid, program, CPU, and age, and the command that stops them: `node dist/server/cli.mjs procs reap --checkout <path>`.
- **`cli.mjs procs`** lists the workers the server knows.

## The stall watch

A pi session can freeze: its process pegs a core, takes no keys, and drops out of the net, while its pane still looks alive.
Once a minute the sb server checks the pi of every pane and tells the workspace's tower when one looks frozen.
It never stops the session and sends it no key.

It tells on any of three signals:

- **Pegged.** The process stayed at or above 75% of a core for 5 minutes in a row while its session file was not written. A short burst, and a session that still writes, are not told.
- **Missing.** The process is alive, but pi-intercom has not listed the session for 3 minutes. This also catches a session that did not come back after a server restart.
- **Silent.** The pane says working, the session file was not written for 30 minutes, and no tool call is open. A long command, a build, or a subagent is an open call, so it is never told.

The tower gets one message per incident, with the pane, the session, the pid, its CPU minutes, and the steps to take: read the pane, send Esc if the screen stands still, and stop the process only with a handoff file or the boss's approval.
It hears again when another signal fires, when the session recovers, and as a reminder after an hour.

The thresholds are the `stallWatch` keys in [`config.json`](/pi-straw-boss/docs/reference/configuration/#configjson).

Heavy-command slots, Linux cgroups, and a watchdog that stops a runaway worker process are planned for a later release.
See [Process hygiene and slots](/pi-straw-boss/docs/reference/how-it-works/process-hygiene-and-slots/) for the rules and the limits.
