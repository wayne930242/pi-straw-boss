---
title: Process hygiene
description: What a worker's shell started is stopped when the worker ends, and a worktree is not removed under a running process.
---

Every pi loads a small extension that marks its environment, so what a worker's bash starts carries the worker's id, even when `timeout` or `setsid` moved it to a process group of its own.

- **Leftovers are stopped.** A pi-herdr-agents worker registers with the sb server. When the worker quits or its pane closes, the server stops what it left (SIGTERM, then SIGKILL after 10 s, each step checked by pid and start time) and logs one `procs-reaped` line.
- **No worktree removal under a running process.** `worktree_remove` and a bash `git worktree remove` are refused while a process works in the checkout. The refusal names each holder's pid, program, CPU, and age, and the command that stops them: `node dist/server/cli.mjs procs reap --checkout <path>`.
- **`cli.mjs procs`** lists the workers the server knows.

Heavy-command slots, Linux cgroups, and a runaway-process guard are planned for a later release.
See [Process hygiene and slots](/pi-straw-boss/docs/reference/how-it-works/process-hygiene-and-slots/) for the rules and the limits.
